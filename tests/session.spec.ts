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
      // refs were cleared on takeover and not re-snapshot since: the old ref is stale,
      // and the error must tell the agent a human takeover caused it.
      await expect(session.click(ref)).rejects.toThrow(/human took over/)

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

  it('lets the first agent key adopt the browser the panel started', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      // The panel's path (no key) is the one a 「启动浏览器」 click takes.
      const panel = await manager.requireSession()
      expect(manager.liveSessionCount).toBe(1)

      // Every session shares one --user-data-dir in production, so a second Chrome
      // would find the profile locked. The agent must adopt, not launch.
      const agent = await manager.requireSession({ id: 'agent-a' })
      expect(agent).toBe(panel)
      expect(manager.liveSessionCount).toBe(1)

      // Only ONE key may adopt it — isolation between agents still holds.
      const other = await manager.requireSession({ id: 'agent-b' })
      expect(other).not.toBe(panel)
      expect(manager.liveSessionCount).toBe(2)
    } finally {
      await manager.dispose()
    }
  })

  it('lists tabs and switches between them', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      // open a target=_blank popup -> the session follows it to the newest tab
      await session.page.click('a[target="_blank"]')
      await expect.poll(() => session.page.url(), { timeout: 5000 }).toContain('/popup')

      const tabs = await session.listPages()
      expect(tabs.length).toBe(2)
      expect(tabs[0].url).toContain(base)
      expect(tabs[1].url).toContain('/popup')
      expect(tabs[1].current).toBe(true)

      session.switchPage(1)
      expect(session.page.url()).toContain(base)
      session.switchPage(2)
      expect(session.page.url()).toContain('/popup')
    } finally {
      await manager.dispose()
    }
  })

  it('goes back and forward through history', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      await session.navigate(`${base}/popup`)
      expect(await session.page.title()).toBe('Popup')
      await session.goBack()
      await expect.poll(() => session.page.title(), { timeout: 5000 }).toBe('Home')
      await session.goForward()
      await expect.poll(() => session.page.title(), { timeout: 5000 }).toBe('Popup')
    } finally {
      await manager.dispose()
    }
  })

  it('falls back to the previous tab when the current page closes', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      const firstPage = session.page

      // open a target=_blank popup -> the session follows the newest tab
      await session.page.click('a[target="_blank"]')
      await expect.poll(() => session.page.url(), { timeout: 5000 }).toContain('/popup')
      const secondPage = session.page
      expect(secondPage).not.toBe(firstPage)

      // close the current (popup) tab -> the session must fall back to the original tab
      await secondPage.close()
      expect(session.page).toBe(firstPage)
      expect(session.page.isClosed()).toBe(false)
      expect(session.page.url()).toContain(base)
    } finally {
      await manager.dispose()
    }
  })

  it('reports the foreground tab via activePageIndex', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000, channel: 'chrome' })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      await session.page.click('a[target="_blank"]')
      await expect.poll(() => session.page.url(), { timeout: 5000 }).toContain('/popup')

      // The popup (tab 2) is the foreground tab.
      expect(await session.activePageIndex()).toBe(2)

      // Activate tab 1 via CDP, like a human clicking the tab strip.
      const cdp = await session.page.context().newCDPSession(session.page)
      const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] })
      const firstTab = targetInfos.find((t: { url: string; targetId: string }) => !t.url.includes('/popup'))
      await cdp.send('Target.activateTarget', { targetId: firstTab.targetId })
      await cdp.detach().catch(() => {})

      await expect.poll(() => session.activePageIndex(), { timeout: 3000 }).toBe(1)
    } finally {
      await manager.dispose()
    }
  })

  it('follows the tab the human activates', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000, channel: 'chrome' })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      const firstPage = session.page

      await session.page.click('a[target="_blank"]')
      await expect.poll(() => session.page.url(), { timeout: 5000 }).toContain('/popup')
      const secondPage = session.page
      expect(secondPage).not.toBe(firstPage)

      // Activate the first tab via CDP; the follow poll should re-bind the session.
      const cdp = await session.page.context().newCDPSession(session.page)
      const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] })
      const firstTab = targetInfos.find((t: { url: string; targetId: string }) => !t.url.includes('/popup'))
      await cdp.send('Target.activateTarget', { targetId: firstTab.targetId })
      await cdp.detach().catch(() => {})

      await expect.poll(() => session.page, { timeout: 5000 }).toBe(firstPage)
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

  it('recreates the session when the page is closed but the browser stays connected', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    const key = { id: 'a' }
    try {
      const s1 = await manager.requireSession(key)
      await s1.navigate(base)
      await s1.page.close() // close only the tab; the browser process stays alive
      expect(s1.isAlive()).toBe(false)
      const s2 = await manager.requireSession(key)
      expect(s2).not.toBe(s1)
      await s2.navigate(base)
      expect(await s2.page.title()).toBe('Home')
    } finally {
      await manager.dispose()
    }
  })

  it('pins the watched tab without moving the agent page (the panel views, it does not steer)', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      const first = session.page

      // A second tab. The session FOLLOWS a newly created page (target=_blank
      // semantics), so the agent ends up on tab 2 while tab 1 still exists.
      const second = await first.context().newPage()
      await second.goto(`${base}/popup`)
      const agentPage = session.page
      expect(agentPage).toBe(second)

      const before = await session.listPages()
      expect(before).toHaveLength(2)
      // While following, the panel watches wherever the agent is.
      expect(before[0]).toMatchObject({ current: false, watched: false })
      expect(before[1]).toMatchObject({ current: true, watched: true })

      const notices: string[] = []
      session.onWatchChange((page) => notices.push(page.url()))
      session.watchPage(1)

      // The whole point: the agent's page is untouched, only the watch moved.
      expect(session.page).toBe(agentPage)
      expect(session.watchedPage()).toBe(first)
      expect(session.isWatchingPinned).toBe(true)
      expect(notices).toHaveLength(1)

      const after = await session.listPages()
      expect(after[0]).toMatchObject({ current: false, watched: true })
      expect(after[1]).toMatchObject({ current: true, watched: false })

      session.unwatchPage()
      expect(session.watchedPage()).toBe(agentPage)
      expect(session.isWatchingPinned).toBe(false)
    } finally {
      await manager.dispose()
    }
  })

  it('leaves the agent page where it is when the agent switches tabs, and drops the panel pin', async () => {
    const manager = new BrowserSessionManager({ headless: true, timeoutMs: 15000 })
    try {
      const session = await manager.requireSession({ id: 'a' })
      await session.navigate(base)
      const first = session.page
      const second = await first.context().newPage()
      await second.goto(`${base}/popup`)

      session.watchPage(2)
      expect(session.watchedPage()).toBe(second)

      // The agent switches back: the panel follows the agent again (the pin was on
      // the page the agent just left), and no window is raised.
      session.switchPage(1)
      expect(session.page).toBe(first)
      expect(session.watchedPage()).toBe(first)
      expect(session.isWatchingPinned).toBe(false)
    } finally {
      await manager.dispose()
    }
  })
})
