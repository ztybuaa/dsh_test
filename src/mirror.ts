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
  metadata: {
    deviceWidth: number
    deviceHeight: number
    /** CSS-pixel viewport, present on Chrome builds that support it. */
    visibleViewportWidth?: number
    visibleViewportHeight?: number
  }
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
 * the same backstop (`#scheduleBackstop` / `cdpBackstopIntervalMs`, default 3s) for
 * this reason. A shorter interval buys nothing — a frame is forced on every attach —
 * and every forced frame is a full-page JPEG encode followed by a full-frame decode
 * in the panel, which is exactly the stutter this used to cause at 1s.
 */
const BACKSTOP_MS = 3000

/**
 * Frames written to the panel per second.
 *
 * `Page.startScreencast` emits in bursts — scrolling and animation can produce far
 * more frames than the panel can decode, and because the response is a single
 * `multipart/x-mixed-replace` body, every frame is decoded in order whether or not
 * anyone saw it. A backlog therefore shows up as lag that outlives the gesture.
 * ego paces this the same way (`cdpFps`): hold the newest frame, drop the ones
 * that arrive inside the gap, and never write faster than the target rate.
 */
const TARGET_FPS = 20
const FRAME_MIN_GAP_MS = 1000 / TARGET_FPS

/**
 * One relayed input event posted by the client panel.
 *
 * The vocabulary is ego-lite's (`InputRouter.sendInput`): semantic pointer and key
 * events rather than Playwright-level calls, because only these can carry a buttons
 * bitmask, a click count, modifiers, or composed text.
 */
interface InputEvent {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel' | 'keyDown' | 'keyUp' | 'insertText'
  /** Normalized 0..1 within the frame; scaled to the page's CSS pixels on the host. */
  x?: number
  y?: number
  button?: 'left' | 'middle' | 'right' | 'back' | 'forward' | 'none'
  buttons?: number
  clickCount?: number
  modifiers?: number
  deltaX?: number
  deltaY?: number
  key?: string
  code?: string
  text?: string
  autoRepeat?: boolean
  windowsVirtualKeyCode?: number
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

  webServer.register({
    name: 'browser-use-show',
    kind: 'exact',
    path: '/browser-use/show',
    handler: (_req, res) => showBrowser(manager, res),
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
  let sendTimer: ReturnType<typeof setTimeout> | undefined
  /** Newest frame not yet written; a burst collapses into this single slot. */
  let pendingFrame: string | undefined
  /** When a frame last ARRIVED — what the idle backstop watches. */
  let lastFrameAt = 0
  /** When a frame was last WRITTEN — what the pacer watches. */
  let lastSentAt = 0
  let closed = false

  const flushLatest = (): void => {
    sendTimer = undefined
    const data = pendingFrame
    pendingFrame = undefined
    if (data === undefined || closed) return
    lastSentAt = Date.now()
    const buf = Buffer.from(data, 'base64')
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`)
    res.write(buf)
    res.write('\r\n')
  }

  /** Write at most one frame per FRAME_MIN_GAP_MS, and always the newest one. */
  const queueFrame = (data: string): void => {
    if (closed) return
    pendingFrame = data
    lastFrameAt = Date.now()
    const gap = FRAME_MIN_GAP_MS - (Date.now() - lastSentAt)
    if (gap <= 0) flushLatest()
    else if (sendTimer === undefined) sendTimer = setTimeout(flushLatest, gap)
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
    queueFrame(shot.data)
  }

  const startBackstop = (session: CDPSession): void => {
    stopBackstop()
    let forcing = false
    backstop = setInterval(() => {
      if (closed || forcing || Date.now() - lastFrameAt < BACKSTOP_MS) return
      forcing = true
      void forceFrame(session)
        .catch(() => {})
        .finally(() => {
          forcing = false
        })
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
      // Prefer what Chrome reports per frame: no round trip, and never stale.
      const vw = frame.metadata.visibleViewportWidth
      const vh = frame.metadata.visibleViewportHeight
      if (typeof vw === 'number' && vw > 0) frameSize.width = Math.round(vw)
      if (typeof vh === 'number' && vh > 0) frameSize.height = Math.round(vh)
      queueFrame(frame.data)
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
    clearTimeout(sendTimer)
    if (cdp !== undefined) {
      cdp.send('Page.stopScreencast').catch(() => {})
      cdp.detach().catch(() => {})
    }
  })
}

/**
 * Reused CDP session for relayed input, keyed by the page it was opened for.
 *
 * Opening one per event would put a round trip in front of every mousemove; ego keeps
 * a session per target for the same reason. A CDP session is bound to a single target,
 * so this is dropped as soon as the watched page changes — for the other way a session
 * dies, see the catch in relayInput.
 */
let inputCdp: { page: Page; session: CDPSession } | undefined

async function inputSessionFor(page: Page): Promise<CDPSession> {
  if (inputCdp?.page === page) return inputCdp.session
  if (inputCdp !== undefined) await inputCdp.session.detach().catch(() => {})
  inputCdp = { page, session: await page.context().newCDPSession(page) }
  return inputCdp.session
}

/**
 * Relay one human input event onto the watched page.
 *
 * Dispatched as raw CDP `Input.*`, which is what ego-lite's worker does. Playwright's
 * `page.mouse` / `page.keyboard` cannot express a buttons bitmask, a click count, or
 * composed text, so drags, double clicks, modifier combinations and any IME text
 * (Chinese, Japanese) were either subtly wrong or simply impossible.
 *
 * `x`/`y` arrive normalized to the frame and are scaled here by the page's CSS
 * viewport, which is exactly what `Input.dispatchMouseEvent` expects.
 */
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
  // The human operates what they SEE — the watched tab, which is not necessarily
  // the tab the agent is working on.
  const page = session.watchedPage()
  const cdp = await inputSessionFor(page)

  const x = typeof body.x === 'number' ? body.x * frameSize.width : 0
  const y = typeof body.y === 'number' ? body.y * frameSize.height : 0
  const modifiers = typeof body.modifiers === 'number' ? body.modifiers : 0

  try {
    if (body.type === 'mouseMoved') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: body.buttons ?? 0 })
    } else if (body.type === 'mousePressed' || body.type === 'mouseReleased') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: body.type,
        x,
        y,
        button: body.button ?? 'left',
        buttons: body.buttons ?? 0,
        clickCount: body.clickCount ?? 1,
        modifiers,
      })
    } else if (body.type === 'mouseWheel') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: body.deltaX ?? 0,
        deltaY: body.deltaY ?? 0,
      })
    } else if (body.type === 'insertText') {
      const text = typeof body.text === 'string' ? body.text : ''
      if (text !== '' && text.length <= 10_000) await cdp.send('Input.insertText', { text })
    } else if (body.type === 'keyDown' || body.type === 'keyUp') {
      const key = typeof body.key === 'string' ? body.key.slice(0, 64) : ''
      if (key !== '') {
        const virtualKeyCode = Number.isInteger(body.windowsVirtualKeyCode) ? (body.windowsVirtualKeyCode ?? 0) : 0
        await cdp.send('Input.dispatchKeyEvent', {
          type: body.type,
          key,
          code: typeof body.code === 'string' ? body.code.slice(0, 64) : '',
          modifiers,
          autoRepeat: body.autoRepeat === true,
          windowsVirtualKeyCode: virtualKeyCode,
          nativeVirtualKeyCode: virtualKeyCode,
          // Chrome derives Enter's text from the key event, but the raw CDP path has
          // to supply it or forms never submit.
          ...(body.type === 'keyDown' && key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
        })
      }
    }
  } catch (error) {
    // A session bound to a page that has navigated or closed is dead. Drop it so the
    // next event opens a fresh one instead of failing forever behind a cached handle.
    if (inputCdp?.session === cdp) inputCdp = undefined
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return
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

/**
 * Bring the real browser window to the front, on the watched tab.
 *
 * Only ever reached because the human pressed a button in the panel. Showing the
 * window automatically would contradict the whole point of the panel — observation
 * that never disturbs the browser — so nothing in this module calls it on its own.
 * Uses the primary session WITHOUT creating one: there is nothing to show before the
 * agent has driven anything, and launching a browser to reveal it would be absurd.
 */
async function showBrowser(manager: BrowserSessionManager, res: ServerResponse): Promise<void> {
  const session = manager.getPrimarySession()
  if (session === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'no browser to show yet' }))
    return
  }
  try {
    await session.showWindow()
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}
