import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from 'playwright'
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

  private constructor(browser: Browser | null, context: BrowserContext, page: Page, config: BrowserConfig, homeDir: string, ownsBrowser: boolean) {
    this.browser = browser
    this.context = context
    this.config = config
    this.homeDir = homeDir
    this.ownsBrowser = ownsBrowser
    this.attachPage(page)
    // Follow new tabs opened via target=_blank / window.open.
    context.on('page', (newPage) => this.attachPage(newPage))
  }

  /** Bind a page as the current one: capture its JSON responses and drop stale refs. */
  private attachPage(page: Page): void {
    this.page = page
    this.refs.clear()
    page.on('response', (resp) => this.captureJson(resp))
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
      // Headful must not carry a fixed viewport: it locks the page to a
      // thumbnail size instead of following the window. Headless keeps the default.
      ...(config.headless ? {} : { viewport: null }),
    }
    if (config.cdpUrl !== undefined) {
      // Attach to an already-running Chrome: reuse its login state and profile.
      const browser = await chromium.connectOverCDP(config.cdpUrl)
      const context = browser.contexts()[0]
      const page = await context.newPage()
      return new BrowserSession(browser, context, page, config, '', false)
    }
    if (config.userDataDir !== undefined) {
      // Persistent profile: login/cookies survive across sessions.
      const context = await chromium.launchPersistentContext(config.userDataDir, options)
      const browser = context.browser()
      const page = context.pages()[0] ?? await context.newPage()
      return new BrowserSession(browser, context, page, config, '', true)
    }
    // A private HOME keeps the browser self-contained: profile, crashpad, and
    // cache land under this temp dir instead of the user's real profile.
    const homeDir = mkdtempSync(join(tmpdir(), 'dsh-browser-use-'))
    const browser = await chromium.launch({ ...options, env: { ...process.env, HOME: homeDir } })
    const context = await browser.newContext(config.headless ? {} : { viewport: null })
    const page = await context.newPage()
    return new BrowserSession(browser, context, page, config, homeDir, true)
  }

  /** Open a URL and wait for its load event. */
  async navigate(url: string): Promise<void> {
    // Stale refs from a previous page must not survive a navigation.
    this.refs.clear()
    await this.page.goto(url, { waitUntil: 'load', timeout: this.config.timeoutMs })
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
    return { title, url, elements, ...(truncated ? { truncated: true } : {}) }
  }

  /** Click the element addressed by `ref` from the most recent snapshot. */
  async click(ref: number): Promise<void> {
    const locator = this.refs.get(ref)
    if (locator === undefined) {
      throw new Error(`browser-use: ref ${ref} not in the most recent snapshot — the page may have changed; call browser_snapshot first`)
    }
    try {
      await locator.click({ timeout: this.config.timeoutMs })
    } catch (e) {
      throw new Error(`browser-use: click on ref ${ref} failed (element detached or not clickable) — call browser_snapshot first. Details: ${(e as Error).message}`)
    }
  }

  /** Type text into the input addressed by `ref` from the most recent snapshot. */
  async type(ref: number, text: string): Promise<void> {
    const locator = this.refs.get(ref)
    if (locator === undefined) {
      throw new Error(`browser-use: ref ${ref} not in the most recent snapshot — the page may have changed; call browser_snapshot first`)
    }
    try {
      await locator.fill(text, { timeout: this.config.timeoutMs })
    } catch (e) {
      throw new Error(`browser-use: type into ref ${ref} failed (element detached or not an input) — call browser_snapshot first. Details: ${(e as Error).message}`)
    }
  }

  /** Hover the element addressed by `ref` from the most recent snapshot. */
  async hover(ref: number): Promise<void> {
    const locator = this.refs.get(ref)
    if (locator === undefined) {
      throw new Error(`browser-use: ref ${ref} not in the most recent snapshot — the page may have changed; call browser_snapshot first`)
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
    const locator = this.refs.get(ref)
    if (locator === undefined) {
      throw new Error(`browser-use: ref ${ref} not in the most recent snapshot — the page may have changed; call browser_snapshot first`)
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
    await this.page.keyboard.press(key)
  }

  /** Whether the underlying browser is still connected. */
  isAlive(): boolean {
    return this.browser?.isConnected() ?? false
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

  constructor(config: BrowserConfig) {
    this.config = config
  }

  /** Resolve (creating if needed) the session for one agent key. */
  async requireSession(key?: object): Promise<BrowserSession> {
    if (key !== undefined) {
      const existing = this.sessions.get(key)
      if (existing !== undefined) {
        if (existing.isAlive()) return existing
        this.sessions.delete(key)
        this.live.delete(existing)
        this.recreateNotice = 'session was recreated (previous page lost) — navigate again'
      }
      const created = await this.createSession()
      this.sessions.set(key, created)
      return created
    }
    if (this.defaultSession !== undefined && !this.defaultSession.isAlive()) {
      this.live.delete(this.defaultSession)
      this.defaultSession = undefined
      this.recreateNotice = 'session was recreated (previous page lost) — navigate again'
    }
    this.defaultSession ??= await this.createSession()
    return this.defaultSession
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
    await session.close()
    return true
  }

  /** Close every live session. */
  async dispose(): Promise<void> {
    const sessions = [...this.live]
    this.live.clear()
    this.defaultSession = undefined
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
