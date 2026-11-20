import { describe, expect, it } from 'vitest'
import type { HostedSession } from '@openaflow/model'
import { hashFor } from '../../selection.ts'
import { readTab, saveTab, shownTab, TAB_KEY, tabRequest, tabsFor, toggleTab, type TabStorage } from './tab-memory.ts'
import { hasTerminalTab } from './terminal-tab.ts'

/** A plain-object storage; `fail` makes each call throw, as a browser with blocked site data does. */
function store(initial: Record<string, string> = {}, fail = false): TabStorage & { data: Record<string, string> } {
  const data = { ...initial }
  const guard = () => {
    if (fail) throw new Error('SecurityError')
  }
  return {
    data,
    getItem: (k) => (guard(), data[k] ?? null),
    setItem: (k, v) => {
      guard()
      data[k] = v
    },
    removeItem: (k) => {
      guard()
      delete data[k]
    },
  }
}

describe('tab memory', () => {
  it('remembers one open tab', () => {
    expect(TAB_KEY).toBe('openaflow-tab')

    // Read: each known value; nothing stored, an unknown value, or a throwing storage → closed.
    for (const tab of ['waiting', 'log'] as const) expect(readTab(store({ [TAB_KEY]: tab }))).toBe(tab)
    // The Plan tab is gone (the flow replaced it): a `plan` left from before reads as closed.
    expect(readTab(store({ [TAB_KEY]: 'plan' }))).toBeUndefined()
    expect(readTab(store())).toBeUndefined()
    expect(readTab(store({ [TAB_KEY]: 'board' }))).toBeUndefined()
    expect(readTab(store({ [TAB_KEY]: '' }))).toBeUndefined()
    expect(readTab(store({ [TAB_KEY]: 'Plan' }))).toBeUndefined()
    expect(readTab(store({ [TAB_KEY]: 'plan' }, true))).toBeUndefined()
    expect(readTab(undefined)).toBeUndefined()
    expect(readTab(null)).toBeUndefined()

    // Save: a tab is stored under the key; undefined removes the key; other keys stay.
    const s = store({ 'openaflow-theme': 'dark' })
    saveTab(s, 'waiting')
    expect(s.data).toEqual({ 'openaflow-theme': 'dark', [TAB_KEY]: 'waiting' })
    saveTab(s, 'log')
    expect(readTab(s)).toBe('log')
    saveTab(s, undefined)
    expect(s.data).toEqual({ 'openaflow-theme': 'dark' })
    // A throwing storage (set or remove), or none, is ignored.
    expect(() => saveTab(store({}, true), 'log')).not.toThrow()
    expect(() => saveTab(store({ [TAB_KEY]: 'log' }, true), undefined)).not.toThrow()
    expect(() => saveTab(undefined, 'log')).not.toThrow()

    // Toggle: clicking the open tab closes it; another tab, or none open, opens the clicked one.
    expect(toggleTab('log', 'log')).toBeUndefined()
    expect(toggleTab('waiting', 'log')).toBe('log')
    expect(toggleTab(undefined, 'waiting')).toBe('waiting')

    // Shown: the stored tab, except an engineer's view always shows Log.
    expect(shownTab('waiting', { view: 'pipeline' })).toBe('waiting')
    expect(shownTab('log', { view: 'pipeline' })).toBe('log')
    expect(shownTab(undefined, { view: 'pipeline' })).toBeUndefined()
    expect(shownTab('waiting', { view: 'board' })).toBe('waiting')
    expect(shownTab(undefined, { view: 'agent' })).toBe('log')
    expect(shownTab('waiting', { view: 'agent' })).toBe('log')
  })

  it('an engineer view shows Log without saving it', () => {
    // shownTab reads only; the stored value stays what the user picked.
    const s = store({ [TAB_KEY]: 'waiting' })
    expect(shownTab(readTab(s), { view: 'agent' })).toBe('log')
    expect(s.data[TAB_KEY]).toBe('waiting')
  })

  it('terminal tab', () => {
    const session = (state: HostedSession['state']): HostedSession => ({
      marker: 'm1',
      sessionId: 's1',
      liveSession: 's1',
      sessions: ['s1'],
      skill: 'plan',
      startedAt: 0,
      state,
      hooked: true,
      prompted: false,
    })
    // The tab shows only in the desktop app (a terminal bridge) and only on a row with a hosted session, in any state.
    for (const state of ['starting', 'live', 'ended', 'stopped'] as const) {
      expect(hasTerminalTab(true, session(state))).toBe(true)
      expect(hasTerminalTab(false, session(state))).toBe(false)
    }
    expect(hasTerminalTab(true, undefined)).toBe(false)
    expect(hasTerminalTab(false, undefined)).toBe(false)

    // The tab list: Waiting and Log, then Terminal only where the row has it.
    expect(tabsFor({ terminal: false })).toEqual(['waiting', 'log'])
    expect(tabsFor({ terminal: true })).toEqual(['waiting', 'log', 'terminal'])

    // A stored terminal is remembered like the other tabs.
    const s = store()
    saveTab(s, 'terminal')
    expect(s.data[TAB_KEY]).toBe('terminal')
    expect(readTab(s)).toBe('terminal')
    // It shows on a row with the tab; on a row with no session, or in the browser (no tab), it reads closed.
    expect(shownTab('terminal', { view: 'pipeline', terminal: true })).toBe('terminal')
    expect(shownTab('terminal', { view: 'pipeline', terminal: false })).toBeUndefined()
    expect(shownTab('terminal', { view: 'board', terminal: false })).toBeUndefined()
    expect(shownTab('terminal', { view: 'pipeline' })).toBeUndefined()
    // Reading it closed doesn't clear it: the next row with a session opens it again.
    expect(s.data[TAB_KEY]).toBe('terminal')
    // The other tabs don't care; an engineer's view still shows Log.
    expect(shownTab('log', { view: 'pipeline', terminal: false })).toBe('log')
    expect(shownTab('terminal', { view: 'agent', terminal: true })).toBe('log')

    // A tab request (Open terminal, a started New session) stores the tab. On an engineer's view, which always
    // shows Log, it also goes to that run's own page, where the Terminal tab can show.
    const fix = { repoId: 'notes', plan: 'fix-a', fix: 'fix-a' }
    const agentHash = hashFor(fix, 'agent', 'eng-1')
    expect(agentHash).toBe('#/notes/fix-a/agent/eng-1')
    expect(tabRequest('terminal', { view: 'agent', run: fix, agent: 'eng-1', hash: agentHash })).toEqual({ save: 'terminal', go: '#/notes/fix-a' })
    // The page already moved on (another run, or a request that came late): no move.
    expect(tabRequest('terminal', { view: 'agent', run: fix, agent: 'eng-1', hash: '#/notes/other' })).toEqual({ save: 'terminal' })
    expect(tabRequest('terminal', { view: 'agent', run: undefined, agent: undefined, hash: agentHash })).toEqual({ save: 'terminal' })
    // Any other view stays where it is.
    for (const view of ['pipeline', 'board'] as const) {
      expect(tabRequest('terminal', { view, run: fix, agent: undefined, hash: hashFor(fix, view) })).toEqual({ save: 'terminal' })
    }
  })
})
