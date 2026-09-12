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
    name: 'browser-use-viewport',
    kind: 'exact',
    path: '/browser-use/viewport',
    handler: (req, res) => setViewport(manager, req, res),
  })

  webServer.register({
    name: 'browser-use-tabs',
    kind: 'exact',
    path: '/browser-use/tabs',
    handler: (req, res) => listTabs(manager, res),
  })

  webServer.register({
    name: 'browser-use-switch-tab',
    kind: 'exact',
    path: '/browser-use/switch-tab',
    handler: (req, res) => switchTab(manager, req, res),
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
  let closed = false

  const attach = async (page: Page): Promise<void> => {
    if (closed) return
    if (cdp !== undefined) {
      cdp.send('Page.stopScreencast').catch(() => {})
      cdp.detach().catch(() => {})
      cdp = undefined
    }
    cdp = await page.context().newCDPSession(page)
    cdp.on('Page.screencastFrame', (raw) => {
      const frame = raw as unknown as ScreencastFrame
      // Ack first so Chrome's flow control never throttles the next frame.
      cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      frameSize.width = frame.metadata.deviceWidth
      frameSize.height = frame.metadata.deviceHeight
      const buf = Buffer.from(frame.data, 'base64')
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`)
      res.write(buf)
      res.write('\r\n')
    })
    // Downscale to the mirror panel's size (the client <img> is ~1240px wide);
    // 1600x900 + quality 85 keeps the text crisp while staying below the
    // full-resolution encode cost that caused the earlier latency.
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1, maxWidth: 1600, maxHeight: 900 })
  }

  const follow = (session: BrowserSession): void => {
    if (closed) return
    disposePage?.()
    // The session keeps its own page pointed at the browser's foreground tab
    // (see BrowserSession's follow poll); the mirror just re-attaches on change.
    disposePage = session.onPageChange((page) => void attach(page))
    void attach(session.page)
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

  if (body.type === 'down' && mx !== undefined && my !== undefined) {
    await session.page.mouse.move(mx, my)
    await session.page.mouse.down()
  } else if (body.type === 'move' && mx !== undefined && my !== undefined) {
    await session.page.mouse.move(mx, my)
  } else if (body.type === 'up' && mx !== undefined && my !== undefined) {
    await session.page.mouse.move(mx, my)
    await session.page.mouse.up()
  } else if (body.type === 'scroll' && typeof body.deltaY === 'number') {
    await session.page.mouse.wheel(0, body.deltaY)
  } else if (body.type === 'key' && typeof body.key === 'string') {
    await session.page.keyboard.press(body.key)
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

/** Viewport bounds: small enough for a narrow sidebar, capped so a huge pane cannot thrash the page. */
const MIN_VIEWPORT = 240
const MAX_VIEWPORT_WIDTH = 1920
const MAX_VIEWPORT_HEIGHT = 1280

/** Clamp one requested dimension into the supported viewport range. */
function clampSize(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Resize the agent's page to the observation panel's content box.
 *
 * Matching the page viewport to the panel is what makes the screencast FILL the
 * panel instead of being scaled down into it, and it is also what keeps relayed
 * pointer coordinates exact: a frame whose aspect ratio differs from the panel's
 * letterboxes, and every normalized click then lands somewhere it was not aimed.
 */
async function setViewport(manager: BrowserSessionManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<{ width?: number; height?: number }>(req)
  const width = clampSize(body.width, MIN_VIEWPORT, MAX_VIEWPORT_WIDTH, 1280)
  const height = clampSize(body.height, MIN_VIEWPORT, MAX_VIEWPORT_HEIGHT, 720)

  const session = await manager.requireSession()
  await session.page.setViewportSize({ width, height })

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, width, height }))
}

/**
 * List the agent browser's tabs for the observation panel's tab strip.
 *
 * The panel only ever sees the MJPEG frame, so it cannot discover tabs itself —
 * it polls this. Uses the primary session WITHOUT creating one, so a poll before
 * the agent has driven anything returns an empty list instead of launching a
 * browser.
 */
async function listTabs(manager: BrowserSessionManager, res: ServerResponse): Promise<void> {
  const session = manager.getPrimarySession()
  const tabs = session === undefined ? [] : await session.listPages()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, tabs }))
}

/** Switch the agent browser to one of its tabs (1-based), driven from the panel's tab strip. */
async function switchTab(manager: BrowserSessionManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<{ index?: number }>(req)
  const index = typeof body.index === 'number' && Number.isFinite(body.index) ? Math.round(body.index) : 0
  if (index < 1) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'index must be a 1-based tab number' }))
    return
  }
  try {
    const session = await manager.requireSession()
    session.switchPage(index)
  } catch (error) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, index }))
}
