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

/** The most recent screencast frame's device size, shared with the input relay. */
export interface FrameSize {
  width: number
  height: number
}

/** One screencast frame pushed by Chrome over CDP. */
interface ScreencastFrame {
  data: string
  sessionId: number
  metadata: { deviceWidth: number; deviceHeight: number }
}

/** Register the sidebar-mirror HTTP routes on the DSH web server. */
export function registerMirrorRoutes(manager: BrowserSessionManager, webServer: WebServerLike): FrameSize {
  const frameSize: FrameSize = { width: 1280, height: 720 }

  webServer.register({
    name: 'browser-use-frame-stream',
    kind: 'exact',
    path: '/browser-use/frame-stream',
    handler: (req, res) => {
      void streamFrames(manager, req, res, frameSize)
    },
  })

  return frameSize
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
