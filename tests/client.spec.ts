import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The client half is a hand-written lazy-CJS module served to the Web GUI: it
 * calls `window.__ModuleLoader__.load({ id, factory })` and the factory builds
 * the plugin's `apply`. T1's load-bearing behaviour is the mount decision — the
 * Agent browser must land in the sidebar's "+" menu as a native
 * dsh-better-sidebar tab, and that service may appear AFTER this plugin boots
 * (a profile's bundle order decides who goes first), so the decision waits on
 * the dependency instead of sampling it once. The legacy shell.overlay panel is
 * only the fallback for hosts without better-sidebar.
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

/** A betterSidebar stand-in that records every tab it is asked to register. */
function fakeBetterSidebar(tabs: Record<string, unknown>[]) {
  return {
    features: ['targetedOpen'],
    registerTab: (descriptor: Record<string, unknown>) => {
      tabs.push(descriptor)
      return () => {}
    },
  }
}

/** The tab title is i18n-friendly: either a string or a () => string. */
function titleOf(tab: Record<string, unknown>): unknown {
  return typeof tab.title === 'function' ? (tab.title as () => string)() : tab.title
}

/**
 * A ctx whose interesting surface is `effect`, `inject` (Cordis's dependency
 * subscription) and `slots`. When a betterSidebar stand-in is supplied, `inject`
 * fires its callback straight away — standing in for the service appearing —
 * which is exactly how the plugin reaches the "+" menu in a real host.
 */
function makeCtx(options: { betterSidebar?: unknown }): {
  ctx: Record<string, unknown>
  slotNames: string[]
  disposedSlots: string[]
} {
  const slotNames: string[] = []
  const disposedSlots: string[] = []
  const ctx: Record<string, unknown> = {
    effect: (fn: () => unknown) => fn(),
    inject: (deps: string[], cb: (scope: unknown) => void) => {
      if (deps.indexOf('betterSidebar') >= 0 && options.betterSidebar !== undefined) {
        cb({ betterSidebar: options.betterSidebar, effect: (fn: () => unknown) => fn() })
      }
    },
    slots: {
      inject: (name: string, fn: () => unknown) => {
        slotNames.push(name)
        fn()
        return () => { disposedSlots.push(name) }
      },
      register: () => () => {},
    },
  }
  return { ctx, slotNames, disposedSlots }
}

describe('client: Agent browser mount decision', () => {
  it('registers the tab for the sidebar "+" menu once betterSidebar appears', () => {
    const tabs: Record<string, unknown>[] = []
    const { ctx, slotNames, disposedSlots } = makeCtx({ betterSidebar: fakeBetterSidebar(tabs) })

    loadClient().apply(ctx)

    expect(tabs).toHaveLength(1)
    const tab = tabs[0]!
    expect(tab.id).toBe('dsh-browser-use:agent-browser')
    expect(typeof tab.component).toBe('function')
    expect(titleOf(tab)).toBe('Agent 浏览器')
    // The floating fallback mounted first and then came back down, so nothing
    // is left floating beside the native tab.
    expect(slotNames).toContain('shell.overlay')
    expect(disposedSlots).toContain('shell.overlay')
  })

  it('keeps the legacy shell.overlay panel when better-sidebar never appears', () => {
    const { ctx, slotNames, disposedSlots } = makeCtx({})

    loadClient().apply(ctx)

    expect(slotNames).toContain('shell.overlay')
    expect(disposedSlots).toHaveLength(0)
  })

  it('never throws when neither service is present', () => {
    const ctx = { effect: (fn: () => unknown) => fn(), inject: () => {} }
    expect(() => loadClient().apply(ctx)).not.toThrow()
  })
})
