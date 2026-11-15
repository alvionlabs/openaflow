// The one open tab under the Next step card (Waiting, Log, or Terminal), remembered per browser, not per run.
// Nothing stored means every tab is closed. A stored Terminal reads closed on a row without the tab (no hosted
// session, or the browser build), and stays stored for the next row that has it. Pure; the screen passes `localStorage`.

import type { RunSummary } from '@openaflow/model'
import { hashFor, type View } from '../../selection.ts'

export type Tab = 'waiting' | 'log' | 'terminal'

/** The part of `Storage` the tab memory needs, so tests can pass a plain object. */
export type TabStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The tabs a row lists, in order: Terminal last, and only on a row that has it (`hasTerminalTab`). */
export const tabsFor = (at: { terminal: boolean }): Tab[] => (at.terminal ? ['waiting', 'log', 'terminal'] : ['waiting', 'log'])

export const TAB_KEY = 'openaflow-tab'

// A `plan` stored before the flow replaced the Plan tab is unknown now, so it reads as closed.
const TABS: readonly string[] = ['waiting', 'log', 'terminal'] satisfies Tab[]

const isTab = (value: unknown): value is Tab => typeof value === 'string' && TABS.includes(value)

/** The stored tab; anything missing, unknown, or unreadable reads as closed. */
export function readTab(storage: TabStorage | null | undefined): Tab | undefined {
  try {
    const value = storage?.getItem(TAB_KEY)
    return isTab(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Stores the open tab; `undefined` (every tab closed) removes the key. A storage that refuses is ignored. */
export function saveTab(storage: TabStorage | null | undefined, tab: Tab | undefined): void {
  try {
    if (tab === undefined) storage?.removeItem(TAB_KEY)
    else storage?.setItem(TAB_KEY, tab)
  } catch {
    // The tab still opens for this page view; it just isn't remembered.
  }
}

/** Clicking the open tab closes it; any other click opens the clicked tab. */
export const toggleTab = (open: Tab | undefined, clicked: Tab): Tab | undefined => (open === clicked ? undefined : clicked)

/**
 * The tab to show: the stored one, except an engineer's view always shows Log (the caller doesn't save it), and a
 * stored Terminal reads closed where the row has no Terminal tab (`terminal` false or left out).
 */
export function shownTab(stored: Tab | undefined, at: { view: View; terminal?: boolean }): Tab | undefined {
  if (at.view === 'agent') return 'log'
  return stored === 'terminal' && at.terminal !== true ? undefined : stored
}

/** What a tab request does: store `save`, and go to `go` first when given. */
export type TabRequest = { save: Tab; go?: string }

/**
 * The page's answer to a request to open `tab` (Open terminal, a started New session). It stores the tab, and on
 * an engineer's view, which always shows Log, goes to its run's own page: unless the page already moved on
 * (`hash` is no longer that view's), or there is no run.
 */
export function tabRequest(tab: Tab, at: { view: View; run: Pick<RunSummary, 'repoId' | 'plan' | 'fix'> | undefined; agent: string | undefined; hash: string }): TabRequest {
  if (at.view === 'agent' && at.run && at.hash === hashFor(at.run, 'agent', at.agent)) return { save: tab, go: hashFor(at.run) }
  return { save: tab }
}
