import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserSessionManager } from '../src/session.ts'
import { registerMirrorRoutes, type WebServerLike } from '../src/mirror.ts'

/**
 * Route-level tests for the relayed input path.
 *
 * The session tests cover what the panel WATCHES; nothing covered what the human's
 * clicks and keystrokes turn into once they reach the page. That gap is where the
 * takeover path lived: it dispatched through Playwright's `page.mouse`, which cannot
 * express a buttons bitmask, a click count, or composed text, so drags, double clicks
 * and every IME language were silently wrong.
 */

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><script>window.__hits = []; window.__keys = [];</script>
<style>html,body{margin:0;height:100%}
#l,#r{position:fixed;top:0;bottom:0;width:50%}
#l{left:0}#r{right:0}
#t{position:fixed;left:0;bottom:0;width:200px}</style></head>
<body>
<div id="l" onmousedown="window.__hits.push('left')"></div>
<div id="r" onmousedown="window.__hits.push('right')"></div>
<input id="t" onkeydown="window.__keys.push(event.key)">
<script>addEventListener('wheel', function () { window.__hits.push('wheel') }, { passive: true })</script>
</body></html>`

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** The mirror's register seam, reduced to the path -> handler lookup the tests need. */
function collectRoutes(): { webServer: WebServerLike; routes: Map<string, Handler> } {
  const routes = new Map<string, Handler>()
  const webServer = {
    register(route: { path: string; handler: Handler }): undefined {
      routes.set(route.path, route.handler)
      return undefined
    },
  }
  return { webServer, routes }
}

/** A request whose body is the JSON payload, iterable the way readJson consumes it. */
function request(payload: unknown): IncomingMessage {
  const body = Buffer.from(JSON.stringify(payload))
  return {
    async *[Symbol.asyncIterator]() {
      yield body
    },
  } as unknown as IncomingMessage
}

function response(): { res: ServerResponse; state: { status: number; body: string } } {
  const state = { status: 0, body: '' }
  const res = {
    writeHead(status: number) {
      state.status = status
      return res
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') state.body = chunk
      return res
    },
    write() {
      return true
    },
  }
  return { res: res as unknown as ServerResponse, state }
}

async function hits(session: { page: { evaluate: (expression: string) => Promise<unknown> } }): Promise<unknown> {
  return session.page.evaluate('window.__hits')
}

describe('relayed input', () => {
  it('refuses input until the human holds takeover, then drives the page over CDP', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      const viewport = session.page.viewportSize()
      // The mirror scales normalized coordinates by the frame's CSS viewport, and with
      // no frame yet it falls back to this default. If Playwright's headless default
      // ever moves, this is where it should fail rather than mysteriously missing.
      expect(viewport).toEqual({ width: 1280, height: 720 })

      const { webServer, routes } = collectRoutes()
      registerMirrorRoutes(manager, webServer)
      const input = routes.get('/browser-use/input')
      expect(input).toBeTypeOf('function')

      // Nobody holds takeover: the route must refuse rather than drive the page.
      const refused = response()
      await input?.(request({ type: 'mousePressed', x: 0.25, y: 0.5 }), refused.res)
      expect(refused.state.status).toBe(409)
      expect(await hits(session)).toEqual([])

      session.takeOver()

      // A left click, then a right click — the halves are what catch an inverted or
      // mis-scaled axis.
      for (const [x, half] of [
        [0.25, 'left'],
        [0.75, 'right'],
      ] as const) {
        await input?.(request({ type: 'mousePressed', x, y: 0.5, button: 'left', buttons: 1, clickCount: 1 }), response().res)
        await input?.(request({ type: 'mouseReleased', x, y: 0.5, button: 'left', buttons: 0, clickCount: 1 }), response().res)
        expect(await hits(session)).toEqual(half === 'left' ? ['left'] : ['left', 'right'])
      }

      // Scroll, then text: `insertText` is the only way an IME language can arrive,
      // since a key NAME cannot carry 中文.
      const scrolled = response()
      await input?.(request({ type: 'mouseWheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 120 }), scrolled.res)
      expect(scrolled.state.status).toBe(200)
      // A wheel goes through the compositor, so unlike a click it does not land with
      // the dispatch — measured at about a frame later, which is why this waits
      // instead of asserting straight away.
      await session.page.waitForFunction("window.__hits.indexOf('wheel') >= 0")
      expect(await hits(session)).toEqual(['left', 'right', 'wheel'])

      await session.page.evaluate("document.getElementById('t').focus()")
      const typed = response()
      await input?.(request({ type: 'insertText', text: '中文 ok' }), typed.res)
      expect(typed.state.status).toBe(200)
      expect(await session.page.inputValue('#t')).toBe('中文 ok')

      // Control keys still travel as key events, and Enter has to carry its CR text.
      const keyed = response()
      await input?.(request({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }), keyed.res)
      await input?.(request({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }), response().res)
      expect(keyed.state.status).toBe(200)
      await session.page.waitForFunction("window.__keys.length > 0")
      expect(await session.page.evaluate('window.__keys')).toEqual(['Enter'])
    } finally {
      await manager.dispose()
    }
  })
})
