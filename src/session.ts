import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page, type Response } from 'playwright'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Session-level configuration resolved once at plugin load. */
export interface BrowserConfig {
  /** Launch a headless browser when true; otherwise a visible window. */
  headless: boolean
  /** Path to a system browser executable. Omit to use Playwright's bundled chromium. */
  executablePath?: string
  /** Navigation timeout in milliseconds. */
  timeoutMs: number
  /** Proxy server URL, e.g. http://127.0.0.1:7897. Omit for a direct connection. */
  proxy?: string
  /** Cap on characters returned by browser_extract. */
  maxChars?: number
  /** Cap on the number of elements listed in a snapshot; beyond it the snapshot is truncated. */
  maxElements?: number
  /** Browser channel (e.g. 'chrome') to use the installed Chrome instead of bundled chromium. */
  channel?: string
  /** Persistent profile directory; login/cookies survive across sessions when set. */
  userDataDir?: string
  /** Start the browser minimized to the taskbar. */
  minimized?: boolean
  /** CDP endpoint (e.g. http://127.0.0.1:9222) to attach to an already-running Chrome. */
  cdpUrl?: string
}

/** One element in a snapshot, addressed by its 1-based `ref`. */
export interface SnapshotElement {
  ref: number
  role: string
  name: string
  /** Optional ARIA state (checked/selected/expanded/disabled), present only when the element has one. */
  state?: string
}

/** The accessibility snapshot a tool returns to the model. */
export interface PageSnapshot {
  title: string
  url: string
  elements: SnapshotElement[]
  /** Set when the element list was capped at maxElements. */
  truncated?: boolean
  /** One-shot notice about the session (e.g. "recreated after a crash"). */
  notice?: string
  /** Diff vs the previous snapshot, keyed by the stable `backendNodeId` handle (see #24). */
  changes?: SnapshotChanges
}

/** Elements that appeared / disappeared / changed between two consecutive snapshots. */
export interface SnapshotChanges {
  added: string[]
  deleted: string[]
  changed: string[]
}

/** One interactive node from `Accessibility.getFullAXTree`, carrying its stable backend handle. */
export interface AxNode {
  /** Stable handle: `frameId` + `backendNodeId`, so cross-iframe nodes don't collide. */
  key: string
  role: string
  name: string
  state?: string
}

/**
 * Diff two AX trees by `backendNodeId` (per #24): a node is `added`/`deleted`
 * when its stable handle appears/disappears, and `changed` when the same node
 * keeps its handle but its role/name/state shifted. Labels are `role "name"`.
 */
export function diffAxNodes(prev: AxNode[], next: AxNode[]): SnapshotChanges {
  const prevMap = new Map(prev.map((n) => [n.key, n]))
  const nextMap = new Map(next.map((n) => [n.key, n]))
  const label = (n: AxNode) => `${n.role} "${n.name}"`
  const added = next.filter((n) => !prevMap.has(n.key)).map(label)
  const deleted = prev.filter((n) => !nextMap.has(n.key)).map(label)
  const changed = next
    .filter((n) => {
      const p = prevMap.get(n.key)
      return p !== undefined && (p.role !== n.role || p.name !== n.name || (p.state ?? '') !== (n.state ?? ''))
    })
    .map(label)
  return { added, deleted, changed }
}

/** Truncate text at a character cap without splitting a surrogate pair. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let end = maxChars
  while (end > 0 && (text.charCodeAt(end) & 0xfc00) === 0xdc00) end -= 1
  return `${text.slice(0, end)}\n…(truncated)`
}

/** Parse a JSON body, stripping common anti-XSSI prefixes (e.g. `)]}'`). Returns undefined when not JSON. */
function parseJsonBody(raw: string): unknown {
  let json = raw.trim().replace(/^\)\]\}'\s*/, '').replace(/^while\(1\);\s*/, '')
  try {
    return JSON.parse(json)
  } catch {
    const idx = json.search(/[{[]/)
    if (idx > 0) json = json.slice(idx)
    try {
      return JSON.parse(json)
    } catch {
      return undefined
    }
  }
}

/** Interactive ARIA widget roles the snapshot selector covers, alongside native tags. */
const INTERACTIVE_ROLES = [
  'button', 'link', 'textbox', 'combobox', 'listbox', 'option', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio',
  'switch', 'searchbox', 'slider', 'spinbutton', 'treeitem',
] as const
/** Same roles as a Set, for filtering `getFullAXTree` down to interactive nodes. */
const INTERACTIVE_ROLE_SET = new Set<string>(INTERACTIVE_ROLES)
const TAG_SELECTOR = 'a[href]:visible, button:visible, input:visible, select:visible, textarea:visible, [contenteditable="true"]:visible'
const ROLE_SELECTOR = INTERACTIVE_ROLES.map((r) => `[role="${r}"]:visible`).join(', ')
const SNAPSHOT_SELECTOR = `${TAG_SELECTOR}, ${ROLE_SELECTOR}`

/** Compute role/name/state for a batch of elements in one in-page round-trip. */
const computeElementInfos = (els: Element[]): Array<{ role: string; name: string; state?: string }> =>
  els.map((el) => {
    const tag = el.tagName.toLowerCase()
    let role = el.getAttribute('role') ?? ''
    if (!role) {
      if (tag === 'input') {
        const type = el.getAttribute('type') ?? 'text'
        if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') role = 'button'
        else if (type === 'checkbox') role = 'checkbox'
        else if (type === 'radio') role = 'radio'
        else role = 'textbox'
      } else {
        const byTag: Record<string, string> = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox' }
        role = byTag[tag] ?? tag
      }
    }
    let name = el.getAttribute('aria-label') ?? ''
    if (!name) {
      const labelledby = el.getAttribute('aria-labelledby')
      if (labelledby) {
        name = labelledby.split(/\s+/).map((id) => (document.getElementById(id)?.textContent ?? '').trim()).join(' ').trim()
      }
    }
    if (!name) {
      const labels = (el as HTMLInputElement).labels
      if (labels && labels.length > 0) name = (labels[0].textContent ?? '').trim()
    }
    if (!name) name = el.getAttribute('placeholder') ?? ''
    if (!name) name = el.getAttribute('value') ?? ''
    if (!name) name = (el.textContent ?? '').trim()
    let state: string | undefined
    for (const attr of ['aria-checked', 'aria-selected', 'aria-expanded']) {
      const v = el.getAttribute(attr)
      if (v) {
        state = `${attr.slice('aria-'.length)}=${v}`
        break
      }
    }
    if (!state && (el as HTMLInputElement).disabled) state = 'disabled'
    return { role, name, ...(state ? { state } : {}) }
  })

/** Project a snapshot to model-facing prose. */
export function formatSnapshot(snapshot: PageSnapshot): string {
  const lines = [
    `Title: ${snapshot.title}`,
    `URL: ${snapshot.url}`,
    '',
    'Interactive elements:',
  ]
  for (const el of snapshot.elements) {
    lines.push(`[${el.ref}] ${el.role} "${el.name}"${el.state ? ` (${el.state})` : ''}`)
  }
  if (snapshot.elements.length === 0) lines.push('(none)')
  if (snapshot.truncated) lines.push(`(snapshot truncated at ${snapshot.elements.length} elements — call browser_extract for full content)`)
  if (snapshot.changes && (snapshot.changes.added.length > 0 || snapshot.changes.deleted.length > 0 || snapshot.changes.changed.length > 0)) {
    lines.push('', 'Changes since last snapshot:')
    for (const added of snapshot.changes.added) lines.push(`  + ${added}`)
    for (const deleted of snapshot.changes.deleted) lines.push(`  - ${deleted}`)
    for (const changed of snapshot.changes.changed) lines.push(`  ~ ${changed}`)
  }
  if (snapshot.notice) lines.unshift(`Notice: ${snapshot.notice}`)
  return lines.join('\n')
}

/**
 * One live browser session: a launched chromium, its context, and a single
 * page. The owning manager owns its lifecycle.
 */
export class BrowserSession {
  private readonly browser: Browser | null
  private readonly context: BrowserContext
  private readonly config: BrowserConfig
  private readonly homeDir: string
  private readonly ownsBrowser: boolean
  /** The page the session currently drives; follows target=_blank popups to the newest page. */
  page!: Page
  /** ref (1-based index) -> live locator, captured by the most recent snapshot. */
  private refs = new Map<number, Locator>()
  /** JSON API responses the page has loaded (bounded, newest last), exposed to the agent. */
  private readonly jsonResponses: Array<{ url: string; body: unknown }> = []
  /** Listeners notified whenever the session rebinds to a new page (target=_blank etc.). */
  private readonly pageListeners: Array<(page: Page) => void> = []
  /** Whether the human has taken over this session via the mirror. */
  private takeover = false
  /** Monotonic epoch, bumped on takeover so stale snapshots/refs are rejected. */
  private epoch = 0
  /** One-shot takeover notice armed by takeOver(), consumed by the next snapshot. */
  private takeoverNotice = false
  /** The previous snapshot's AX nodes, for the backendNodeId diff. `null` = no baseline yet. */
  private lastAxNodes: AxNode[] | null = null
  /** Pages that already have response/close listeners, so switching tabs doesn't double-register. */
  private readonly attached = new WeakSet<Page>()
  /** Pages that already have a visibility bridge installed. */
  private readonly visibilityAttached = new WeakSet<Page>()

  private constructor(browser: Browser | null, context: BrowserContext, page: Page, config: BrowserConfig, homeDir: string, ownsBrowser: boolean) {
    this.browser = browser
    this.context = context
    this.config = config
    this.homeDir = homeDir
    this.ownsBrowser = ownsBrowser
    this.attachPage(page)
    // Follow new pages opened via target=_blank / window.open.
    context.on('page', (newPage) => this.attachPage(newPage))
    // Pages already open (e.g. a persistent profile or a reused context) also
    // need the visibility bridge, or the session can't follow a tab the human
    // activates that predates this session.
    for (const existing of context.pages()) this.watchVisibility(existing)
  }

  /** Bind a page as the current one: capture its JSON responses and drop stale refs. */
  private attachPage(page: Page): void {
    this.page = page
    this.refs.clear()
    this.lastAxNodes = null
    if (!this.attached.has(page)) {
      this.attached.add(page)
      page.on('response', (resp) => this.captureJson(resp))
      page.on('close', () => this.handlePageClosed(page))
    }
    this.watchVisibility(page)
    for (const listener of this.pageListeners) listener(page)
  }

  /** When the current page closes, fall back to the newest remaining tab so the mirror keeps streaming. */
  private handlePageClosed(page: Page): void {
    if (page !== this.page) return
    const remaining = this.context.pages().filter((p) => !p.isClosed())
    if (remaining.length > 0) this.attachPage(remaining[remaining.length - 1])
  }

  /**
   * Follow the tab the human activates in the browser: each page reports its
   * `visibilitychange` (tab switch) through a CDP binding, and the session
   * re-binds to whichever page became visible. Installed once per page and
   * re-armed after navigations; the CDP session is detached on close.
   */
  private async watchVisibility(page: Page): Promise<void> {
    if (this.visibilityAttached.has(page)) return
    this.visibilityAttached.add(page)
    if (page.isClosed()) return
    const cdp = await page.context().newCDPSession(page).catch(() => undefined)
    if (cdp === undefined) return
    await cdp.send('Runtime.addBinding', { name: '__dshReportVisibility' }).catch(() => {})
    cdp.on('Runtime.bindingCalled', (ev: { name: string }) => {
      if (ev.name !== '__dshReportVisibility') return
      // The listener only fires this binding when the page becomes visible.
      if (page !== this.page && !page.isClosed()) this.attachPage(page)
    })
    const arm = () => {
      if (page.isClosed()) return
      void page
        .evaluate(`document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') window.__dshReportVisibility('visible') })`)
        .catch(() => {})
    }
    arm()
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) arm()
    })
    page.once('close', () => {
      cdp.detach().catch(() => {})
    })
  }

  /** Subscribe to page rebinds (e.g. a mirror re-attaching its screencast). Returns a disposer. */
  onPageChange(listener: (page: Page) => void): () => void {
    this.pageListeners.push(listener)
    return () => {
      const i = this.pageListeners.indexOf(listener)
      if (i >= 0) this.pageListeners.splice(i, 1)
    }
  }

  /** Whether the human currently owns the page (mirror takeover). */
  get isTakeover(): boolean {
    return this.takeover
  }

  /** The current takeover epoch (bumped each takeover). */
  get currentEpoch(): number {
    return this.epoch
  }

  /** Human takes over: bump epoch, clear refs, arm the one-shot notice. */
  takeOver(): void {
    this.takeover = true
    this.epoch += 1
    this.refs.clear()
    this.takeoverNotice = true
  }

  /** Human cedes: agent may resume, but must re-snapshot (refs stay cleared). */
  cede(): void {
    this.takeover = false
  }

  /** Consume the one-shot takeover notice. */
  takeTakeoverNotice(): boolean {
    const n = this.takeoverNotice
    this.takeoverNotice = false
    return n
  }

  /** Reject agent writes while the human holds the page. */
  private assertWritable(): void {
    if (this.takeover) {
      throw new Error('browser-use: human takeover in progress — agent writes are blocked; wait for the human to cede, then re-snapshot')
    }
  }

  /** Error for a stale ref, telling the agent explicitly when a human takeover caused it. */
  private staleRefError(ref: number): Error {
    if (this.takeoverNotice) {
      return new Error(`browser-use: a human took over the browser — ref ${ref} is stale; call browser_snapshot to see the current page state`)
    }
    return new Error(`browser-use: ref ${ref} not in the most recent snapshot — the page may have changed; call browser_snapshot first`)
  }

  /** Capture JSON API responses (bounded) as they arrive, so the agent can read page data even when the frontend doesn't render it. */
  private captureJson(resp: Response): void {
    const contentType = resp.headers()['content-type'] ?? ''
    if (!contentType.includes('json') && !contentType.includes('javascript')) return
    resp.text().then((raw) => {
      const body = parseJsonBody(raw)
      if (body !== undefined) {
        this.jsonResponses.push({ url: resp.url(), body })
        if (this.jsonResponses.length > 30) this.jsonResponses.shift()
      }
    }).catch(() => { /* non-text body */ })
  }

  /** The JSON API responses captured so far (newest last). */
  getJsonResponses(): Array<{ url: string; body: unknown }> {
    return this.jsonResponses
  }

  /** Launch a browser and open a fresh page. */
  static async create(config: BrowserConfig): Promise<BrowserSession> {
    const args = [
      '--disable-crash-reporter',
      '--disable-metrics-reporting',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-blink-features=AutomationControlled',
      ...(config.minimized ? ['--start-minimized'] : []),
    ]
    const options = {
      headless: config.headless,
      ...(config.channel !== undefined ? { channel: config.channel } : {}),
      ...(config.proxy !== undefined ? { proxy: { server: config.proxy, bypass: '<local>,localhost,127.0.0.1,::1' } } : {}),
      args,
      ...(config.executablePath !== undefined ? { executablePath: config.executablePath } : {}),
    }
    // Headful must not carry a fixed viewport: it locks the page to a thumbnail
    // size instead of following the window. `viewport` is a context option, so it
    // belongs on the context-creation calls below, never on `chromium.launch`.
    const contextOptions = config.headless ? {} : { viewport: null }
    if (config.cdpUrl !== undefined) {
      // Attach to an already-running Chrome: reuse its login state and profile.
      const browser = await chromium.connectOverCDP(config.cdpUrl)
      const context = browser.contexts()[0]
      const page = await context.newPage()
      return new BrowserSession(browser, context, page, config, '', false)
    }
    if (config.userDataDir !== undefined) {
      // Persistent profile: login/cookies survive across sessions.
      const context = await chromium.launchPersistentContext(config.userDataDir, { ...options, ...contextOptions })
      const browser = context.browser()
      const page = context.pages()[0] ?? await context.newPage()
      return new BrowserSession(browser, context, page, config, '', true)
    }
    // A private HOME keeps the browser self-contained: profile, crashpad, and
    // cache land under this temp dir instead of the user's real profile.
    const homeDir = mkdtempSync(join(tmpdir(), 'dsh-browser-use-'))
    const browser = await chromium.launch({ ...options, env: { ...process.env, HOME: homeDir } })
    const context = await browser.newContext(contextOptions)
    const page = await context.newPage()
    return new BrowserSession(browser, context, page, config, homeDir, true)
  }

  /** Open a URL and wait for its load event. */
  async navigate(url: string): Promise<void> {
    // Stale refs from a previous page must not survive a navigation.
    this.refs.clear()
    // A navigation is a brand-new page, so drop the diff baseline.
    this.lastAxNodes = null
    await this.page.goto(url, { waitUntil: 'load', timeout: this.config.timeoutMs })
  }

  /** List every open tab in the context, marking the current one. */
  async listPages(): Promise<Array<{ index: number; title: string; url: string; current: boolean }>> {
    const pages = this.context.pages()
    const out: Array<{ index: number; title: string; url: string; current: boolean }> = []
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]
      out.push({
        index: i + 1,
        title: (await p.title().catch(() => '')).slice(0, 120),
        url: p.url().slice(0, 300),
        current: p === this.page,
      })
    }
    return out
  }

  /** Switch the current page to the tab at `index` (1-based). */
  switchPage(index: number): void {
    const pages = this.context.pages()
    const target = pages[index - 1]
    if (target === undefined) {
      throw new Error(`browser-use: tab ${index} does not exist (${pages.length} tab(s) open)`)
    }
    this.attachPage(target)
  }

  /** 1-based index of the page that is currently visible (foreground tab), or undefined if none. */
  async activePageIndex(): Promise<number | undefined> {
    const pages = this.context.pages()
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]
      if (p.isClosed()) continue
      const vis = await p.evaluate(() => document.visibilityState).catch(() => 'hidden')
      if (vis === 'visible') return i + 1
    }
    return undefined
  }

  /** Go back one step in the current page's history. */
  async goBack(): Promise<void> {
    this.refs.clear()
    this.lastAxNodes = null
    await this.page.goBack({ waitUntil: 'load', timeout: this.config.timeoutMs })
  }

  /** Go forward one step in the current page's history. */
  async goForward(): Promise<void> {
    this.refs.clear()
    this.lastAxNodes = null
    await this.page.goForward({ waitUntil: 'load', timeout: this.config.timeoutMs })
  }

  /**
   * Project the current page into an accessibility snapshot: title, URL, and
   * an indexed list of interactive elements. The 1-based indices become the
   * `ref`s that click/type resolve against this snapshot. Element metadata is
   * collected in a single in-page round-trip and capped at maxElements.
   */
  async snapshot(): Promise<PageSnapshot> {
    const title = await this.page.title().catch(() => '')
    const url = this.page.url()
    const locator = this.page.locator(SNAPSHOT_SELECTOR)
    const infos = await locator.evaluateAll(computeElementInfos)
    const max = this.config.maxElements ?? 200
    const truncated = infos.length > max
    const kept = truncated ? infos.slice(0, max) : infos
    const elements: SnapshotElement[] = []
    const refs = new Map<number, Locator>()
    for (let i = 0; i < kept.length; i++) {
      const ref = i + 1
      elements.push({ ref, ...kept[i] })
      refs.set(ref, locator.nth(i))
    }
    this.refs = refs
    const axNodes = await this.readAxNodes()
    const changes = this.lastAxNodes === null ? undefined : diffAxNodes(this.lastAxNodes, axNodes)
    this.lastAxNodes = axNodes
    const intervened = this.takeTakeoverNotice()
    return {
      title,
      url,
      elements,
      ...(truncated ? { truncated: true } : {}),
      ...(changes !== undefined && (changes.added.length > 0 || changes.deleted.length > 0 || changes.changed.length > 0) ? { changes } : {}),
      ...(intervened ? { notice: 'human took over — this snapshot reflects the current page state' } : {}),
    }
  }

  /**
   * Read the interactive nodes of the page's accessibility tree via CDP,
   * keyed by their stable `(frameId, backendNodeId)` handle for the diff.
   * Falls back to an empty list when the page is closing or CDP is unavailable.
   */
  private async readAxNodes(): Promise<AxNode[]> {
    let cdp: CDPSession
    try {
      cdp = await this.page.context().newCDPSession(this.page)
    } catch {
      return []
    }
    try {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree')
      const result: AxNode[] = []
      for (const node of nodes) {
        if (node.ignored) continue
        const role = node.role?.value
        if (typeof role !== 'string' || !INTERACTIVE_ROLE_SET.has(role)) continue
        if (node.backendDOMNodeId === undefined) continue
        const name = typeof node.name?.value === 'string' ? node.name.value : ''
        let state: string | undefined
        for (const prop of node.properties ?? []) {
          if (prop.name === 'checked' || prop.name === 'selected' || prop.name === 'expanded' || prop.name === 'disabled') {
            state = `${prop.name}=${String(prop.value?.value ?? true)}`
            break
          }
        }
        result.push({ key: `${node.frameId ?? ''}\u0000${node.backendDOMNodeId}`, role, name, state })
      }
      return result
    } catch {
      return []
    } finally {
      await cdp.detach().catch(() => {})
    }
  }

  /** Click the element addressed by `ref` from the most recent snapshot. */
  async click(ref: number): Promise<void> {
    this.assertWritable()
    const locator = this.refs.get(ref)
    if (locator === undefined) {
      throw this.staleRefError(ref)
    }
    try {
      await locator.click({ timeout: this.config.timeoutMs })
    } catch (e) {
      throw new Error(`browser-use: click on ref ${ref} failed (element detached or not clickable) — call browser_snapshot first. Details: ${(e as Error).message}`)
    }
  }

  /** Type text into the input addressed by `ref` from the most recent snapshot. */
  async type(ref: number, text: string): Promise<void> {
    this.assertWritable()
    const locator = this.refs.get(ref)
    if (locator === undefined) {
      throw this.staleRefError(ref)
    }
    try {
      await locator.fill(text, { timeout: this.config.timeoutMs })
    } catch (e) {
      throw new Error(`browser-use: type into ref ${ref} failed (element detached or not an input) — call browser_snapshot first. Details: ${(e as Error).message}`)
    }
  }

  /** Hover the element addressed by `ref` from the most recent snapshot. */
  async hover(ref: number): Promise<void> {
    this.assertWritable()
    const locator = this.refs.get(ref)
    if (locator === undefined) {
      throw this.staleRefError(ref)
    }
    await locator.hover({ timeout: this.config.timeoutMs })
  }

  /** Wait for content: a fixed delay, a visible selector, or body text. */
  async wait(opts: { ms?: number; selector?: string; text?: string; timeout?: number }): Promise<void> {
    const timeout = opts.timeout ?? this.config.timeoutMs
    if (opts.selector !== undefined) {
      await this.page.waitForSelector(opts.selector, { state: 'visible', timeout })
    } else if (opts.text !== undefined) {
      await this.page.waitForFunction((t) => (document.body.innerText ?? '').includes(t), opts.text, { timeout })
    } else if (opts.ms !== undefined) {
      await new Promise((r) => setTimeout(r, opts.ms))
    } else {
      throw new Error('browser-use: browser_wait needs one of ms, selector, or text')
    }
  }

  /** Evaluate a read-only expression in the page and return the result. */
  async evaluate(expression: string): Promise<unknown> {
    return await this.page.evaluate(expression)
  }

  /** Click `ref`, capture the triggered download, save it under `dir`, and preview its content. */
  async download(ref: number, dir: string): Promise<{ path: string; preview: string }> {
    this.assertWritable()
    const locator = this.refs.get(ref)
    if (locator === undefined) {
      throw this.staleRefError(ref)
    }
    const [download] = await Promise.all([
      this.page.waitForEvent('download', { timeout: this.config.timeoutMs }),
      locator.click({ timeout: this.config.timeoutMs }),
    ])
    const filename = download.suggestedFilename().replace(/[\\/:*?"<>|]/g, '_')
    const target = join(dir, filename)
    await download.saveAs(target)
    let preview = ''
    try {
      preview = readFileSync(target, 'utf8').slice(0, 500)
    } catch {
      /* binary or unreadable file: no preview */
    }
    return { path: target, preview }
  }

  /** Scroll the page by a pixel amount in the given direction. */
  async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    this.assertWritable()
    const delta = direction === 'down' ? amount : -amount
    await this.page.evaluate((n) => window.scrollBy(0, n), delta)
  }

  /** Capture the current viewport as a PNG at the given path, returning the encoded bytes. */
  async screenshot(path: string): Promise<Buffer> {
    return await this.page.screenshot({ path, timeout: this.config.timeoutMs })
  }

  /** Extract the page's text content, including hidden data tables that innerText skips. */
  async extractText(): Promise<string> {
    const text = await this.page.evaluate(() => {
      const body = document.body
      if (!body) return ''
      let out = body.innerText ?? ''
      // 数据表（含无障碍/屏幕阅读器用的隐藏表，如 Google Trends 的 x y1 数据表）innerText 可能漏掉；
      // 序列化所有 table（单元格 tab 分隔、行换行），若 innerText 里没有就补上。
      for (const table of Array.from(body.querySelectorAll('table'))) {
        const rows = Array.from((table as HTMLTableElement).rows).map((r) =>
          Array.from(r.cells).map((c) => (c.textContent ?? '').trim()).join('\t'),
        )
        if (!rows.length) continue
        const serialized = rows.join('\n')
        if (!out.includes(serialized)) out += `\n${serialized}`
      }
      return out
    }).catch(() => '')
    return truncate(text, this.config.maxChars ?? 20000)
  }

  /** Press a keyboard key on the focused element (e.g. Enter, Escape, Tab). */
  async pressKey(key: string): Promise<void> {
    this.assertWritable()
    await this.page.keyboard.press(key)
  }

  /** Whether the underlying browser is still connected and the page not closed. */
  isAlive(): boolean {
    if (!this.browser?.isConnected()) return false
    return !this.page.isClosed()
  }

  /** Close the browser and release its resources. */
  async close(): Promise<void> {
    if (!this.ownsBrowser) {
      // CDP: we borrowed the user's running Chrome — close only our page, leave their browser intact.
      await this.page.close().catch(() => {})
      return
    }
    // Close the context first: for a persistent profile this flushes cookies
    // to disk before the browser shuts down.
    await this.context.close().catch(() => {})
    await this.browser?.close().catch(() => {})
    if (this.homeDir) rmSync(this.homeDir, { recursive: true, force: true })
  }
}

/**
 * Lazily-created per-agent browser sessions. An `agent` key isolates one
 * session per agent; calls without a key share a default session. Disposal
 * closes every live session so plugin unload never leaks a browser process.
 */
export class BrowserSessionManager {
  private readonly config: BrowserConfig
  private readonly sessions = new WeakMap<object, BrowserSession>()
  private readonly live = new Set<BrowserSession>()
  private defaultSession: BrowserSession | undefined
  private recreateNotice: string | undefined
  /** The session the mirror should follow: the most recent agent-driven session. */
  private primarySession: BrowserSession | undefined
  private readonly primaryListeners: Array<(session: BrowserSession) => void> = []

  constructor(config: BrowserConfig) {
    this.config = config
  }

  /** Resolve (creating if needed) the session for one agent key. */
  async requireSession(key?: object): Promise<BrowserSession> {
    if (key !== undefined) {
      const existing = this.sessions.get(key)
      if (existing !== undefined) {
        if (existing.isAlive()) {
          this.setPrimary(existing)
          return existing
        }
        this.sessions.delete(key)
        this.live.delete(existing)
        void existing.close() // don't orphan the old browser window/process
        this.recreateNotice = 'session was recreated (previous page lost) — navigate again'
      }
      const created = await this.createSession()
      this.sessions.set(key, created)
      this.setPrimary(created)
      return created
    }
    // Mirror path (no key): follow the agent's primary session when one exists,
    // otherwise fall back to a shared default.
    if (this.primarySession !== undefined && this.primarySession.isAlive()) return this.primarySession
    if (this.defaultSession !== undefined && !this.defaultSession.isAlive()) {
      const dead = this.defaultSession
      this.live.delete(dead)
      this.defaultSession = undefined
      void dead.close() // don't orphan the old browser window/process
      this.recreateNotice = 'session was recreated (previous page lost) — navigate again'
    }
    this.defaultSession ??= await this.createSession()
    this.setPrimary(this.defaultSession)
    return this.defaultSession
  }

  /** The session the mirror should stream, without creating one (undefined until the agent drives). */
  getPrimarySession(): BrowserSession | undefined {
    return this.primarySession !== undefined && this.primarySession.isAlive() ? this.primarySession : undefined
  }

  private setPrimary(session: BrowserSession): void {
    if (this.primarySession === session) return
    this.primarySession = session
    for (const listener of this.primaryListeners) listener(session)
  }

  /** Subscribe to the primary (mirrored) session changing. Returns a disposer. */
  onPrimaryChange(listener: (session: BrowserSession) => void): () => void {
    this.primaryListeners.push(listener)
    return () => {
      const i = this.primaryListeners.indexOf(listener)
      if (i >= 0) this.primaryListeners.splice(i, 1)
    }
  }

  /** One-shot notice explaining why the agent's previous page is gone (consumed by tools). */
  takeRecreateNotice(): string | undefined {
    const notice = this.recreateNotice
    this.recreateNotice = undefined
    return notice
  }

  /** Close the session for one agent key (or the default when key is absent). */
  async closeSession(key?: object): Promise<boolean> {
    let session: BrowserSession | undefined
    if (key !== undefined) {
      session = this.sessions.get(key)
      if (session !== undefined) this.sessions.delete(key)
    } else {
      session = this.defaultSession
      this.defaultSession = undefined
    }
    if (session === undefined) return false
    this.live.delete(session)
    if (this.primarySession === session) this.primarySession = undefined
    await session.close()
    return true
  }

  /** Close every live session. */
  async dispose(): Promise<void> {
    const sessions = [...this.live]
    this.live.clear()
    this.defaultSession = undefined
    this.primarySession = undefined
    await Promise.all(sessions.map((session) => session.close()))
  }

  /** Number of currently-live sessions (test hook). */
  get liveSessionCount(): number {
    return this.live.size
  }

  private async createSession(): Promise<BrowserSession> {
    const session = await BrowserSession.create(this.config)
    this.live.add(session)
    return session
  }
}
