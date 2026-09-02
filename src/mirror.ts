import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CDPSession, Page } from 'playwright'
import type { BrowserSessionManager } from './session.ts'

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
    handler: (req, res) => {
      void relayInput(manager, req, res, frameSize)
    },
  })
}

/** Stream the session's current page as MJPEG, following target=_blank page rebinds. */
async function streamFrames(
  manager: BrowserSessionManager,
  req: IncomingMessage,
  res: ServerResponse,
  frameSize: FrameSize,
): Promise<void> {
  const session = await manager.requireSession()
  await session.page.goto('https://www.wikipedia.org', { waitUntil: 'load' }).catch(() => {})

  res.writeHead(200, {
    'content-type': 'multipart/x-mixed-replace; boundary=frame',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  let cdp: CDPSession | undefined
  let closed = false

  const attach = async (page: Page): Promise<void> => {
    if (closed) return
    cdp = await page.context().newCDPSession(page)
    cdp.on('Page.screencastFrame', (raw) => {
      const frame = raw as unknown as ScreencastFrame
      frameSize.width = frame.metadata.deviceWidth
      frameSize.height = frame.metadata.deviceHeight
      const buf = Buffer.from(frame.data, 'base64')
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`)
      res.write(buf)
      res.write('\r\n')
      cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 })
  }

  const offPage = session.onPageChange((page) => {
    if (closed) return
    cdp?.send('Page.stopScreencast').catch(() => {})
    void attach(page)
  })

  await attach(session.page)

  req.on('close', () => {
    closed = true
    offPage()
    cdp?.send('Page.stopScreencast').catch(() => {})
  })
}

/** Relay one client input event back onto the shared page, scaling normalized coords to device pixels. */
async function relayInput(
  manager: BrowserSessionManager,
  req: IncomingMessage,
  res: ServerResponse,
  frameSize: FrameSize,
): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as InputEvent

  const session = await manager.requireSession()
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
