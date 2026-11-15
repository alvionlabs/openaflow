// The Terminal tab (sprint terminal-tab T1, §7 and §8): when a row has it, its dot, and what it draws for the row's
// shown session: the live terminal, or the stop bar over the faded last screen. Also the browser build's note in
// place of the tab. Pure; TerminalTab.tsx and TerminalView.tsx are the glue.

import { sessionDot, sessionView, sessionWord, type HostedSession, type SessionDot } from '@openaflow/model'
import { DESKTOP_TERMINAL } from './next-step.ts'
import type { ChipClass } from './view.ts'

/** A live session's terminal that the host can't give: it has no such session, or the host can't be used. */
export const UNAVAILABLE = 'This terminal is not available.'
/** The stop bar's line when the record has no end time (`stopped · app closed`, and reconcile's `ended`). */
export const ENDED_NO_TIME = 'The terminal has ended.'

export type StopBar = { dot: ChipClass; word: string; line: string }
export type TerminalBody = { kind: 'terminal' } | { kind: 'stopped'; bar: StopBar }
export type BrowserView = StopBar & { note: string }

const DOT_CLASS: Record<SessionDot, ChipClass> = { run: 's-run', you: 's-you', idle: 's-idle' }

/** The Terminal tab shows only in the desktop app (its terminal bridge) and only on a row with a hosted session. */
export const hasTerminalTab = (terminals: boolean, shown: HostedSession | undefined): boolean => terminals && shown !== undefined

/** A local time as HH:MM. */
export function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const isOpen = (s: HostedSession, now: number) => {
  const v = sessionView(s, now)
  return v === 'starting' || v === 'live' || v === 'waiting'
}

/**
 * The tab's dot class, from the session's dot (§4): the run dot while the shown session is starting or live, the
 * needs-you dot while it waits for you (as the sidebar's row). None once it ended or stopped, or with no session.
 */
export const tabDot = (s: HostedSession | undefined, now: number): ChipClass | undefined =>
  s !== undefined && isOpen(s, now) ? DOT_CLASS[sessionDot(sessionView(s, now))] : undefined

const endLine = (s: HostedSession) => (s.endedAt === undefined ? ENDED_NO_TIME : `The terminal ended at ${clock(s.endedAt)}.`)

const status = (s: HostedSession, now: number) => ({ dot: DOT_CLASS[sessionDot(sessionView(s, now))], word: sessionWord(s, now) })

/** The stop bar of an ended or stopped session: its dot, its word (§4), and when the terminal ended. */
export const stopBar = (s: HostedSession, now: number): StopBar => ({ ...status(s, now), line: endLine(s) })

/** Starting, live, and waiting draw the terminal; ended and stopped draw the stop bar. */
export const terminalBody = (s: HostedSession, now: number): TerminalBody => (isOpen(s, now) ? { kind: 'terminal' } : { kind: 'stopped', bar: stopBar(s, now) })

/** The browser build (no terminal bridge): the session's dot, word, and one line, with the desktop note in place of buttons. */
export function browserView(s: HostedSession, now: number): BrowserView {
  const line = isOpen(s, now) ? `The terminal started at ${clock(s.startedAt)}.` : endLine(s)
  return { ...status(s, now), line, note: DESKTOP_TERMINAL }
}
