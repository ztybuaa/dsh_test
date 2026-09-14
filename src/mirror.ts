import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CDPSession, Page } from 'playwright'
import type { BrowserSession, BrowserSessionManager } from './session.ts'

/** Minimal slice of the DSH webServer seam the mirror consumes. */
export interface WebServerLike {
  register(route: {
    name: string
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): unknown
}

/** The most recent screencast frame's device size, used to scale relayed coordinates. */
interface FrameSize {
  width: number
  height: number
}

/** One screencast frame pushed by Chrome over CDP. */
interface ScreencastFrame {
  data: string
  sessionId: number
  metadata: { deviceWidth: number; deviceHeight: number }
}

/** Downscale cap for both the screencast and the backstop screenshots. */
const MAX_FRAME_WIDTH = 1600
const MAX_FRAME_HEIGHT = 900

/**
 * How long the stream may go without a frame before it takes a screenshot itself.
 *
 * `Page.startScreencast` only pushes on paint, so a target that is not repainting —
 * a background tab, a static document — emits nothing at all. Without this the panel
 * keeps rendering the last frame of whatever target it was attached to before, which
 * looks exactly like "switching tabs does nothing". ego-browser's CDP backend carries
 * the same backstop (`#scheduleBackstop` / `cdpBackstopIntervalMs`) for this reason.
 */
const BACKSTOP_MS = 1000

/** One relayed input event posted by the client panel. */
interface InputEvent {
  type: 'down' | 'move' | 'up' | 'scroll' | 'key'
  x?: number
  y?: number
  deltaY?: number
  key?: string
}

/** Read a JSON request body, bounding it to a sane size. */
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

/** Register the sidebar-mirror HTTP routes (frame stream + input relay) on the DSH web server. */
export function registerMirrorRoutes(manager: BrowserSessionManager, webServer: WebServerLike): void {
  const frameSize: FrameSize = { width: 1280, height: 720 }

  webServer.register({
    name: 'browser-use-frame-stream',
    kind: 'exact',
    path: '/browser-use/frame-stream',
    handler: (req, res) => {
      void streamFrames(manager, req, res, frameSize)
    },
  })

  webServer.register({
    name: 'browser-use-input',
    kind: 'exact',
    path: '/browser-use/input',
    handler: (req, res) => relayInput(manager, req, res, frameSize),
  })

  webServer.register({
    name: 'browser-use-takeover',
    kind: 'exact',
    path: '/browser-use/takeover',
    handler: (req, res) => setTakeover(manager, req, res),
  })

  webServer.register({
    name: 'browser-use-tabs',
    kind: 'exact',
    path: '/browser-use/tabs',
    handler: (req, res) => listTabs(manager, res),
  })

  webServer.register({
    name: 'browser-use-watch',
    kind: 'exact',
    path: '/browser-use/watch',
    handler: (req, res) => watchTab(manager, req, res),
  })
}

/** Stream the primary session's current page as MJPEG, following session swaps and target=_blank page rebinds. */
async function streamFrames(
  manager: BrowserSessionManager,
  req: IncomingMessage,
  res: ServerResponse,
  frameSize: FrameSize,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'multipart/x-mixed-replace; boundary=frame',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  let cdp: CDPSession | undefined
  let disposePage: (() => void) | undefined
  let backstop: ReturnType<typeof setInterval> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let lastFrameAt = 0
  let closed = false

  const pushFrame = (data: string): void => {
    if (closed) return
    const buf = Buffer.from(data, 'base64')
    lastFrameAt = Date.now()
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`)
    res.write(buf)
    res.write('\r\n')
  }

  const stopBackstop = (): void => {
    if (backstop !== undefined) clearInterval(backstop)
    backstop = undefined
  }

  /**
   * Refresh the CSS viewport size that relayed input is scaled against.
   *
   * The client normalizes a click through the rendered image (0..1) and this module
   * multiplies it back up, so the multiplier has to be the page's CSS viewport — not
   * the image's pixel size, which the `maxWidth` cap shrinks on wide windows. ego
   * keeps the same two numbers apart for the same reason.
   */
  const refreshViewport = async (session: CDPSession): Promise<number> => {
    const metrics = (await session.send('Page.getLayoutMetrics')) as unknown as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
    }
    const width = metrics.cssVisualViewport?.clientWidth
    const height = metrics.cssVisualViewport?.clientHeight
    if (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0) {
      frameSize.width = Math.round(width)
      frameSize.height = Math.round(height)
    }
    return frameSize.width
  }

  /** One screenshot, used both to show a fresh target at once and as the idle backstop. */
  const forceFrame = async (session: CDPSession): Promise<void> => {
    if (closed || session !== cdp) return
    const width = await refreshViewport(session)
    const scale = width > MAX_FRAME_WIDTH ? MAX_FRAME_WIDTH / width : 1
    const shot = await session.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
      captureBeyondViewport: false,
      ...(frameSize.width > 0 && frameSize.height > 0
        ? { clip: { x: 0, y: 0, width: frameSize.width, height: frameSize.height, scale } }
        : {}),
    })
    if (closed || session !== cdp) return
    pushFrame(shot.data)
  }

  const startBackstop = (session: CDPSession): void => {
    stopBackstop()
    backstop = setInterval(() => {
      if (closed || Date.now() - lastFrameAt < BACKSTOP_MS) return
      void forceFrame(session).catch(() => {})
    }, BACKSTOP_MS)
  }

  const attach = async (page: Page): Promise<void> => {
    if (closed) return
    stopBackstop()
    if (cdp !== undefined) {
      cdp.send('Page.stopScreencast').catch(() => {})
      cdp.detach().catch(() => {})
      cdp = undefined
    }
    const session = await page.context().newCDPSession(page)
    if (closed) {
      session.detach().catch(() => {})
      return
    }
    cdp = session
    session.on('Page.screencastFrame', (raw) => {
      const frame = raw as unknown as ScreencastFrame
      // Ack first so Chrome's flow control never throttles the next frame.
      session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      // A frame from a session we have already replaced belongs to the old target.
      if (session !== cdp) return
      pushFrame(frame.data)
    })
    // Downscale to the mirror panel's size (the client <img> is ~1240px wide);
    // 1600x900 + quality 85 keeps the text crisp while staying below the
    // full-resolution encode cost that caused the earlier latency.
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 85,
      everyNthFrame: 1,
      maxWidth: MAX_FRAME_WIDTH,
      maxHeight: MAX_FRAME_HEIGHT,
    })
    // `startScreencast` waits for the next paint to emit anything, so show the new
    // target now instead of whenever it happens to repaint.
    await forceFrame(session)
    startBackstop(session)
  }

  /** The page currently being screencast, so a redundant re-attach is skipped. */
  let streaming: Page | undefined

  const follow = (session: BrowserSession): void => {
    if (closed) return
    disposePage?.()
    // Both subscriptions re-attach to whatever is WATCHED right now — never to the
    // page the event happened to carry. The subtlety matters: the foreground-follow
    // poll moves the AGENT's page, which fires onPageChange, and attaching to that
    // page dragged the stream back off a tab the human had pinned — the panel then
    // looked one click behind.
    const reattach = (): void => {
      if (closed) return
      const wanted = session.watchedPage()
      if (wanted === streaming) return
      streaming = wanted
      void attach(wanted).catch(() => {
        // A switch can race a navigation or a tab close. Leaving `streaming` set here
        // would pin the stream to a target we never attached to — the panel would sit
        // on the previous tab's last frame forever, with no event left to retry it.
        if (streaming === wanted) streaming = undefined
        if (closed) return
        clearTimeout(retry)
        retry = setTimeout(reattach, 300)
      })
    }
    const offPage = session.onPageChange(reattach)
    const offWatch = session.onWatchChange(reattach)
    disposePage = () => {
      offPage()
      offWatch()
    }
    reattach()
  }

  // Mirror the agent's session; while none exists, hold the stream open (the
  // panel shows its background) and start once the agent drives the browser.
  const disposePrimary = manager.onPrimaryChange(follow)
  const initial = manager.getPrimarySession()
  if (initial !== undefined) follow(initial)

  req.on('close', () => {
    closed = true
    disposePrimary()
    disposePage?.()
    stopBackstop()
    clearTimeout(retry)
    if (cdp !== undefined) {
      cdp.send('Page.stopScreencast').catch(() => {})
      cdp.detach().catch(() => {})
    }
  })
}

/** Relay one client input event back onto the shared page, scaling normalized coords to device pixels. */
async function relayInput(
  manager: BrowserSessionManager,
  req: IncomingMessage,
  res: ServerResponse,
  frameSize: FrameSize,
): Promise<void> {
  const body = await readJson<InputEvent>(req)

  const session = await manager.requireSession()
  if (!session.isTakeover) {
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not in takeover — click 接管浏览器 first' }))
    return
  }
  const mx = typeof body.x === 'number' ? body.x * frameSize.width : undefined
  const my = typeof body.y === 'number' ? body.y * frameSize.height : undefined
  // The human operates what they SEE — the watched tab, which is not necessarily
  // the tab the agent is working on.
  const page = session.watchedPage()

  if (body.type === 'down' && mx !== undefined && my !== undefined) {
    await page.mouse.move(mx, my)
    await page.mouse.down()
  } else if (body.type === 'move' && mx !== undefined && my !== undefined) {
    await page.mouse.move(mx, my)
  } else if (body.type === 'up' && mx !== undefined && my !== undefined) {
    await page.mouse.move(mx, my)
    await page.mouse.up()
  } else if (body.type === 'scroll' && typeof body.deltaY === 'number') {
    await page.mouse.wheel(0, body.deltaY)
  } else if (body.type === 'key' && typeof body.key === 'string') {
    await page.keyboard.press(body.key)
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

/** Enter/leave human takeover for the default session. */
async function setTakeover(manager: BrowserSessionManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<{ takeover: boolean }>(req)

  const session = await manager.requireSession()
  if (body.takeover === true) session.takeOver()
  else session.cede()

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, takeover: session.isTakeover }))
}

/**
 * List the agent browser's tabs for the panel's tab strip.
 *
 * The panel only ever sees the frame, so it cannot discover tabs itself. Uses the
 * primary session WITHOUT creating one, so a poll before the agent drives anything
 * returns an empty list instead of launching a browser. Each entry carries
 * `current` (the AGENT's page) and `watched` (the PANEL's page) — two different
 * things, which is the whole point of the watch state.
 */
async function listTabs(manager: BrowserSessionManager, res: ServerResponse): Promise<void> {
  const session = manager.getPrimarySession()
  const tabs = session === undefined ? [] : await session.listPages()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, tabs }))
}

/**
 * Pin the panel to a tab (1-based). Moves the WATCH, not the agent's session, and
 * never raises the browser window.
 */
async function watchTab(manager: BrowserSessionManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<{ index?: number }>(req)
  const index = typeof body.index === 'number' && Number.isFinite(body.index) ? Math.round(body.index) : 0
  if (index < 1) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'index must be a 1-based tab number' }))
    return
  }
  try {
    const session = await manager.requireSession()
    session.watchPage(index)
  } catch (error) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, index }))
}
