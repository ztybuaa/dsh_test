import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The client half is a hand-written lazy-CJS module served to the Web GUI: it
 * calls `window.__ModuleLoader__.load({ id, factory })` and the factory builds
 * the plugin's `apply`. T1's load-bearing behaviour is the mount decision — a
 * native dsh-better-sidebar tab when that service is present, and a safe
 * fallback to the legacy `shell.overlay` panel when it is absent. This test
 * drives that decision without a DOM by capturing the spec and invoking the
 * factory with stub services.
 */

interface LoadedSpec {
  id: string
  factory: (require: (name: string) => unknown) => { apply: (ctx: unknown) => void; inject?: string[] }
}

/** Minimal react stub — the mount decision never renders. */
const reactStub = {
  createElement: () => null,
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
}

/** Evaluate client.js in a sandbox that provides the module loader, and return its exported half. */
function loadClient(): { apply: (ctx: unknown) => void; inject?: string[] } {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let captured: LoadedSpec | undefined
  // client.js opens with `window.__ModuleLoader__.load({...})`; injecting a local
  // `window` in front of the source keeps the evaluation self-contained.
  const wrapped = 'var window = { __ModuleLoader__: { load: __capture } };\n' + source
  // eslint-disable-next-line no-new-func
  new Function('__capture', wrapped)((spec: LoadedSpec) => { captured = spec })
  if (captured === undefined) throw new Error('client.js did not call window.__ModuleLoader__.load')
  const require = (name: string): unknown => (name === 'react' ? reactStub : {})
  return captured.factory(require)
}

/** A ctx whose only interesting surface is `get`, `effect` and `slots`. */
function makeCtx(options: {
  betterSidebar?: unknown
  slots?: { inject: (name: string, fn: () => void) => void; register: (spec: unknown) => unknown }
}): { ctx: Record<string, unknown>; registered: unknown[]; slotNames: string[] } {
  const registered: unknown[] = []
  const slotNames: string[] = []
  const ctx: Record<string, unknown> = {
    get: (name: string) => (name === 'betterSidebar' ? options.betterSidebar : undefined),
    effect: (fn: () => unknown) => fn(),
    slots:
      options.slots ??
      {
        inject: (name: string) => { slotNames.push(name) },
        register: (spec: unknown) => { registered.push(spec); return () => {} },
      },
  }
  return { ctx, registered, slotNames }
}

describe('client: Agent browser mount decision', () => {
  it('registers a native better-sidebar tab when the service is available', () => {
    const tabs: Record<string, unknown>[] = []
    const betterSidebar = {
      features: ['targetedOpen'],
      registerTab: (descriptor: Record<string, unknown>) => { tabs.push(descriptor); return () => {} },
      openTab: () => {},
    }
    const { ctx } = makeCtx({ betterSidebar })

    loadClient().apply(ctx)

    expect(tabs).toHaveLength(1)
    const tab = tabs[0]!
    expect(tab.id).toBe('dsh-browser-use:agent-browser')
    expect(typeof tab.component).toBe('function')
    // Title is i18n-friendly: either a string or a () => string.
    const title = typeof tab.title === 'function' ? (tab.title as () => string)() : tab.title
    expect(title).toBe('Agent 浏览器')
  })

  it('falls back to the legacy shell.overlay panel when better-sidebar is absent', () => {
    const { ctx, slotNames } = makeCtx({})

    loadClient().apply(ctx)

    expect(slotNames).toContain('shell.overlay')
  })

  it('never throws when neither service is present', () => {
    const ctx = { get: () => undefined, effect: (fn: () => unknown) => fn() }
    expect(() => loadClient().apply(ctx)).not.toThrow()
  })
})
