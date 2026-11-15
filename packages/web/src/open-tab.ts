// A request to open a tab on the run screen, sent as a `window` CustomEvent so no screen imports another.

export type TabName = 'terminal'

const EVENT = 'openaflow:open-tab'
const TABS: readonly string[] = ['terminal']

/** Asks the run screen to open `tab`. Does nothing with no window. */
export function requestTab(tab: TabName, win: Window | undefined = globalThis.window): void {
  win?.dispatchEvent(new CustomEvent(EVENT, { detail: { tab } }))
}

/** Calls `fn` for each request for a known tab; returns a function that stops the calls. */
export function onTabRequest(fn: (tab: TabName) => void, win: Window | undefined = globalThis.window): () => void {
  if (win === undefined) return () => {}
  const on = (e: Event) => {
    const tab = (e as CustomEvent<{ tab?: unknown } | null>).detail?.tab
    if (typeof tab === 'string' && TABS.includes(tab)) fn(tab as TabName)
  }
  win.addEventListener(EVENT, on)
  return () => win.removeEventListener(EVENT, on)
}
