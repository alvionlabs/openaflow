import { describe, expect, it } from 'vitest'
import { WAITING_AFTER_MS, type HostedSession } from '@openaflow/model'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DESKTOP_TERMINAL } from './next-step.ts'
import { runChip } from './view.ts'
import { TerminalNote, TerminalTab } from './TerminalTab.tsx'
import { browserView, clock, ENDED_NO_TIME, stopBar, tabDot, terminalBody, UNAVAILABLE } from './terminal-tab.ts'

// Local times, so the HH:MM checks hold in any time zone.
const START = new Date(2026, 10, 15, 13, 40).getTime()
const END = new Date(2026, 10, 15, 14, 2).getTime()
const NOW = START + 60_000

const session = (over: Partial<HostedSession> = {}): HostedSession => ({
  marker: '7f3c9a12-0000-4000-8000-000000000001',
  sessionId: 'sess-1',
  liveSession: 'sess-1',
  sessions: ['sess-1'],
  skill: 'plan',
  startedAt: START,
  state: 'live',
  hooked: true,
  prompted: true,
  ...over,
})
const STARTING = session({ state: 'starting', hooked: false })
const LIVE = session()
// Live with no SessionStart line 10 s after the start: Claude waits for you.
const WAITING = session({ hooked: false })
const ENDED = session({ state: 'ended', exitCode: 0, endedAt: END })
const ENDED_CODE = session({ state: 'ended', exitCode: 3, endedAt: END })
const RESTARTED = session({ state: 'stopped', stopReason: 'terminals restarted', endedAt: END })
// S1 sets no endedAt on `stopped · app closed` or on reconcile's `ended`.
const APP_CLOSED = session({ state: 'stopped', stopReason: 'app closed' })
const ENDED_UNTIMED = session({ state: 'ended' })

const tab = (s: HostedSession) => renderToStaticMarkup(createElement(TerminalTab, { repoId: 'notes', repoPath: '/notes', session: s, now: NOW, bridge: undefined }))
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''))

describe('terminal tab', () => {
  it('clock', () => {
    expect(clock(END)).toBe('14:02')
    expect(clock(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05')
    expect(clock(new Date(2026, 0, 1, 0, 0).getTime())).toBe('00:00')
  })

  it('tab dot', () => {
    // The run dot while the shown session is starting or live.
    expect(tabDot(STARTING, NOW)).toBe('s-run')
    expect(tabDot(LIVE, NOW)).toBe('s-run')
    // Waiting for you: the needs-you dot, the class the sidebar's `needs-you` row uses (`runChip`).
    expect(tabDot(WAITING, START + WAITING_AFTER_MS)).toBe(runChip('needs-you').cls)
    expect(tabDot(WAITING, START + WAITING_AFTER_MS)).toBe('s-you')
    // Just before the waiting time, it is still live: the run dot.
    expect(tabDot(WAITING, START + WAITING_AFTER_MS - 1)).toBe('s-run')
    // None once it ended or stopped, for any reason.
    for (const s of [ENDED, ENDED_CODE, RESTARTED, APP_CLOSED, ENDED_UNTIMED]) expect(tabDot(s, NOW)).toBeUndefined()
    // None with no session.
    expect(tabDot(undefined, NOW)).toBeUndefined()
  })

  it('stop bar', () => {
    // Starting, live, and waiting give the terminal.
    for (const s of [STARTING, LIVE, WAITING]) expect(terminalBody(s, START + WAITING_AFTER_MS).kind).toBe('terminal')
    // Ended and stopped give the stop bar: the session's idle dot, its word, when it ended.
    expect(terminalBody(ENDED, NOW)).toEqual({ kind: 'stopped', bar: { dot: 's-idle', word: 'Ended · Claude exited', line: 'The terminal ended at 14:02.' } })
    expect(stopBar(ENDED_CODE, NOW)).toEqual({ dot: 's-idle', word: 'Ended · Claude exited with code 3', line: 'The terminal ended at 14:02.' })
    expect(stopBar(RESTARTED, NOW)).toEqual({ dot: 's-idle', word: 'Stopped · terminals restarted', line: 'The terminal ended at 14:02.' })
    // No end time: the line says it ended, with no time.
    expect(stopBar(APP_CLOSED, NOW)).toEqual({ dot: 's-idle', word: 'Stopped · app closed', line: ENDED_NO_TIME })
    expect(stopBar(ENDED_UNTIMED, NOW).line).toBe(ENDED_NO_TIME)

    // Drawn: the bar has Dismiss and nothing else (no Resume in this sprint), over the faded last screen.
    for (const s of [ENDED, ENDED_CODE, RESTARTED, APP_CLOSED]) {
      const html = tab(s)
      expect(buttons(html)).toEqual(['Dismiss'])
      expect(html).not.toContain('Resume')
      expect(html).toContain('class="stop-bar"')
      expect(html).toContain('class="status s-idle"')
      expect(html).toContain(stopBar(s, NOW).word)
      expect(html).toContain(stopBar(s, NOW).line)
      expect(html).toMatch(/class="term[^"]*\bfaded\b/)
    }
    // A live session draws the terminal: no stop bar, no button, input on.
    for (const s of [LIVE, WAITING]) {
      const html = tab(s)
      expect(html).not.toContain('stop-bar')
      expect(buttons(html)).toEqual([])
      expect(html).toMatch(/class="term"/)
      expect(html).not.toContain('faded')
    }
    // With no link (it can't connect), a live session says the terminal is not available only once the link says so.
    expect(tab(LIVE)).not.toContain(UNAVAILABLE)
  })

  it('browser rule', () => {
    // The browser build: the dot, the word, one line, and the desktop note. No button.
    expect(browserView(LIVE, NOW)).toEqual({ dot: 's-run', word: 'Live', line: 'The terminal started at 13:40.', note: DESKTOP_TERMINAL })
    expect(browserView(STARTING, NOW)).toEqual({ dot: 's-run', word: 'Starting', line: 'The terminal started at 13:40.', note: DESKTOP_TERMINAL })
    expect(browserView(WAITING, START + WAITING_AFTER_MS)).toEqual({ dot: 's-you', word: 'Waiting for you', line: 'The terminal started at 13:40.', note: DESKTOP_TERMINAL })
    expect(browserView(ENDED, NOW)).toEqual({ dot: 's-idle', word: 'Ended · Claude exited', line: 'The terminal ended at 14:02.', note: DESKTOP_TERMINAL })
    expect(browserView(APP_CLOSED, NOW)).toEqual({ dot: 's-idle', word: 'Stopped · app closed', line: ENDED_NO_TIME, note: DESKTOP_TERMINAL })

    for (const s of [LIVE, ENDED, APP_CLOSED]) {
      const html = renderToStaticMarkup(createElement(TerminalNote, { session: s, now: NOW }))
      const v = browserView(s, NOW)
      expect(html).toContain(`class="status ${v.dot}"`)
      expect(html).toContain(v.word)
      expect(html).toContain(v.line)
      expect(html).toContain(DESKTOP_TERMINAL)
      expect(html).not.toContain('<button')
      expect(html).not.toContain('Dismiss')
      expect(html).not.toContain('Resume')
    }
  })
})
