import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrowserSessionManager } from './session.ts'
import { browserTools } from './tools.ts'
import { detectProxy } from './proxy.ts'
import { registerMirrorRoutes, type WebServerLike } from './mirror.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-use'

/** The tool registry plus the durable image attachment store the plugin registers into. */
export const inject = ['tools', 'attachments']

/** Plugin configuration. Invalid values fail plugin load. */
export interface Config {
  /** Launch browsers headless when true; default is a visible window. */
  headless: boolean
  /** Path to a system browser executable. Omit to use Playwright's bundled chromium. */
  executablePath?: string
  /** Navigation timeout in milliseconds. */
  timeoutMs: number
  /** Directory where screenshots land when no path is requested. */
  screenshotDir: string
  /** Proxy server for the browser, e.g. http://127.0.0.1:7897. Auto-detected when omitted. */
  proxy?: string
  /** Cap on characters returned by browser_extract. */
  maxChars: number
  /** Cap on elements listed in a snapshot; beyond it the snapshot is truncated. */
  maxElements: number
  /** Browser channel (e.g. 'chrome') to use the installed Chrome instead of bundled chromium. */
  channel?: string
  /** Persistent profile directory; login/cookies survive across sessions when set. */
  userDataDir?: string
  /** Start the browser minimized to the taskbar. */
  minimized?: boolean
  /** CDP endpoint (e.g. http://127.0.0.1:9222) to attach to an already-running Chrome. */
  cdpUrl?: string
}

/** Schemastery schema validating {@link Config}; deployment-varying fields default here. */
export const Config: z<Config> = z.object({
  headless: z.boolean().default(false),
  executablePath: z.string(),
  timeoutMs: z.number().default(30000),
  screenshotDir: z.string().default('.'),
  proxy: z.string(),
  maxChars: z.number().default(20000),
  maxElements: z.number().default(200),
  channel: z.string(),
  userDataDir: z.string(),
  minimized: z.boolean().default(false),
  cdpUrl: z.string(),
})

/**
 * Mount the browser-use plugin: create the per-agent session manager, register
 * the browser tools, and make sure live browser processes never outlive the
 * plugin.
 */
export function apply(ctx: Context, config: Config): void {
  const proxy = detectProxy(config.proxy)
  const manager = new BrowserSessionManager({
    headless: config.headless,
    timeoutMs: config.timeoutMs,
    maxChars: config.maxChars,
    maxElements: config.maxElements,
    ...(config.executablePath !== undefined ? { executablePath: config.executablePath } : {}),
    ...(config.channel !== undefined ? { channel: config.channel } : {}),
    ...(config.userDataDir !== undefined ? { userDataDir: config.userDataDir } : {}),
    ...(config.minimized !== undefined ? { minimized: config.minimized } : {}),
    ...(config.cdpUrl !== undefined ? { cdpUrl: config.cdpUrl } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
  })
  // Teardown is fire-and-forget so plugin unload never blocks on browser shutdown.
  ctx.effect(() => {
    return () => {
      void manager.dispose()
    }
  })
  for (const tool of browserTools(manager, config.screenshotDir, ctx.attachments)) {
    ctx.tools.register(tool)
  }
  // Sidebar mirror (web profile only): stream the live page over the web server.
  ctx.inject(['webServer'], (scope) => {
    const webServer = (scope as { webServer?: WebServerLike }).webServer
    if (webServer !== undefined) registerMirrorRoutes(manager, webServer)
  })
}
