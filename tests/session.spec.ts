import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserSessionManager, diffAxNodes } from '../src/session.ts'

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (url.pathname === '/') {
      res.end('<html><head><title>Home</title></head><body><h1>Hello Browser</h1><a href="/popup" target="_blank">Open popup</a></body></html>')
    } else if (url.pathname === '/popup') {
      res.end('<html><head><title>Popup</title></head><body><h1>Popup page</h1></body></html>')
    } else {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('diffAxNodes', () => {
  const a = { key: '1', role: 'link', name: 'About' }
  const b = { key: '2', role: 'button', name: 'Go' }

  it('reports added/deleted/changed keyed by the stable backendNodeId handle', () => {
    expect(diffAxNodes([], [a])).toEqual({ added: ['link "About"'], deleted: [], changed: [] })
    expect(diffAxNodes([a], [])).toEqual({ added: [], deleted: ['link "About"'], changed: [] })
    expect(diffAxNodes([a], [a])).toEqual({ added: [], deleted: [], changed: [] })
    expect(diffAxNodes([a], [{ ...a, name: 'About us' }])).toEqual({ added: [], deleted: [], changed: ['link "About us"'] })
    // same label but a different handle is still a remove+add, not a no-op
    expect(diffAxNodes([a], [b])).toEqual({ added: ['button "Go"'], deleted: ['link "About"'], changed: [] })
  })
})

describe('BrowserSessionManager', () => {
  it('navigates a URL for a keyed session', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    const key = { id: 'a' }
    try {
      const session = await manager.requireSession(key)
      await session.navigate(base)
      expect(await session.page.title()).toBe('Home')
    } finally {
      await manager.dispose()
    }
  })

  it('leaves the viewport unset in headful mode so the page follows the window', async () => {
    const manager = new BrowserSessionManager({ headless: false, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      expect(session.page.viewportSize()).toBeNull()
    } finally {
      await manager.dispose()
    }
  })

  it('follows a target=_blank popup to the new page', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      await session.page.click('a[target="_blank"]')
      await expect.poll(() => session.page.url(), { timeout: 5000 }).toContain('/popup')
    } finally {
      await manager.dispose()
    }
  })

  it('notifies page-change listeners when a popup opens', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      let notifiedUrl = ''
      session.onPageChange((page) => {
        notifiedUrl = page.url()
      })
      await session.page.click('a[target="_blank"]')
      await expect.poll(() => notifiedUrl, { timeout: 5000 }).toContain('/popup')
    } finally {
      await manager.dispose()
    }
  })

  it('reports a backendNodeId added/deleted diff across snapshots', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      const first = await session.snapshot()
      expect(first.changes).toBeUndefined()
      await session.page.evaluate(() => {
        const a = document.createElement('a')
        a.href = '/popup'
        a.textContent = 'New link'
        document.body.appendChild(a)
      })
      const second = await session.snapshot()
      expect(second.changes?.added).toContain('link "New link"')
      const third = await session.snapshot()
      expect(third.changes).toBeUndefined()
    } finally {
      await manager.dispose()
    }
  })

  it('blocks agent writes during takeover, clears refs on cede, and arms a one-shot notice', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      const snap = await session.snapshot()
      const ref = snap.elements[0].ref

      session.takeOver()
      expect(session.isTakeover).toBe(true)
      expect(session.currentEpoch).toBe(1)
      await expect(session.click(ref)).rejects.toThrow(/takeover/)

      session.cede()
      expect(session.isTakeover).toBe(false)
      // refs were cleared on takeover and not re-snapshot since: the old ref is stale
      await expect(session.click(ref)).rejects.toThrow(/not in the most recent snapshot/)

      // a fresh takeover + snapshot arms (then consumes) the one-shot notice
      session.takeOver()
      const afterTakeover = await session.snapshot()
      expect(afterTakeover.notice).toContain('took over')
      expect((await session.snapshot()).notice).toBeUndefined()
    } finally {
      await manager.dispose()
    }
  })

  it('isolates sessions per agent key', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    const keyA = { id: 'a' }
    const keyB = { id: 'b' }
    try {
      const a = await manager.requireSession(keyA)
      const b = await manager.requireSession(keyB)
      const aAgain = await manager.requireSession(keyA)
      expect(a).not.toBe(b)
      expect(a).toBe(aAgain)
      expect(manager.liveSessionCount).toBe(2)
    } finally {
      await manager.dispose()
    }
  })

  it('tracks a primary session for the mirror and notifies on change', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      expect(manager.getPrimarySession()).toBeUndefined()

      let notified = 0
      const off = manager.onPrimaryChange(() => {
        notified += 1
      })
      const key = { id: 'a' }
      const a = await manager.requireSession(key)
      expect(manager.getPrimarySession()).toBe(a)
      expect(notified).toBe(1)

      // the mirror (no key) resolves to the agent's primary session, not a second browser
      const mirror = await manager.requireSession()
      expect(mirror).toBe(a)
      expect(manager.liveSessionCount).toBe(1)

      off()
    } finally {
      await manager.dispose()
    }
  })

  it('closes one session without touching others, and dispose closes the rest', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    const keyA = { id: 'a' }
    const keyB = { id: 'b' }
    await manager.requireSession(keyA)
    await manager.requireSession(keyB)
    expect(manager.liveSessionCount).toBe(2)

    const closed = await manager.closeSession(keyA)
    expect(closed).toBe(true)
    expect(manager.liveSessionCount).toBe(1)

    await manager.dispose()
    expect(manager.liveSessionCount).toBe(0)
  })

  it('flags a one-shot notice when a dead session is auto-recreated', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    const key = { id: 'a' }
    try {
      const s1 = await manager.requireSession(key)
      await s1.close()
      const s2 = await manager.requireSession(key)
      expect(s2).not.toBe(s1)
      const notice = manager.takeRecreateNotice()
      expect(notice).toContain('recreated')
      // 一次性：取过一次后消失
      expect(manager.takeRecreateNotice()).toBeUndefined()
      // 正常路径不产生 notice
      const s3 = await manager.requireSession(key)
      expect(s3).toBe(s2)
      expect(manager.takeRecreateNotice()).toBeUndefined()
    } finally {
      await manager.dispose()
    }
  })
})
