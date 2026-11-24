// The Terminal tab (sprint terminal-tab T1, §7 and §8): when a row has it, its dot, and what it draws for the row's
// shown session: the live terminal, or the stop bar over the faded last screen. Also the browser build's note in
// place of the tab. Pure; TerminalTab.tsx and TerminalView.tsx are the glue.

import { sessionDot, sessionView, sessionWord, type HostedSession, type SessionDot, type SessionResume } from '@openaflow/model'
import { hashFor, parseHash } from '../../selection.ts'
import type { TerminalHandlers } from '../../terminal-link.ts'
import { DESKTOP_TERMINAL } from './next-step.ts'
import type { ITerminalOptions } from '@xterm/xterm'
import type { TerminalLook } from '../../theme/terminal-theme.ts'
import type { ChipClass } from './view.ts'

/** A live session's terminal that the host can't give: it has no such session, or the host can't be used. */
export const UNAVAILABLE = 'This terminal is not available.'
/** The stop bar's line when the record has no end time (`stopped · app closed`, and reconcile's `ended`). */
export const ENDED_NO_TIME = 'The terminal has ended.'

/** After the end line, when Resume can start the session again (session-life §9). */
export const RESUME_LINE = 'Resume starts the same Claude session again.'
export const CANT_RESUME = "Can't resume"
/** Why Resume can't start the session again: the stop bar's line, and the alert's words for `can't resume: <reason>`. */
export const RESUME_BLOCKED: Readonly<Record<Exclude<SessionResume, 'ok'>, string>> = {
  'no folder': 'The repo folder is gone.',
  'no conversation': 'The session file is gone.',
  'in use': 'Another terminal holds this session.',
}

/** The sideload stop line (§7), and the word the page draws in mono. */
export const SIDELOAD_FLAG = 'disableSideloadFlags'
export const SIDELOAD_LINE = `Claude couldn't start. Your organization's ${SIDELOAD_FLAG} setting blocks the plugins OpenAFlow loads.`

/** `resume`: the bar offers Resume. `sideload`: the line is the sideload stop line, with `SIDELOAD_FLAG` in mono. */
export type StopBar = { dot: ChipClass; word: string; line: string; resume: boolean; sideload?: true }
export type TerminalBody = { kind: 'terminal' } | { kind: 'stopped'; bar: StopBar }
export type BrowserView = Omit<StopBar, 'resume'> & { note: string }

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

/**
 * The stop bar of an ended or stopped session (session-life §9). Resume `ok`: its dot, its word (§4), when the terminal
 * ended, and that Resume starts it again. A reason it can't resume: the blocked dot, Can't resume, and the reason. No
 * resume field: the dot, the word, and when it ended. `terminals` false (the browser build): never Resume.
 */
export function stopBar(s: HostedSession, now: number, terminals: boolean): StopBar {
  // The server says why (§7); the page never reads Claude's text. No Resume, whatever `resume` says.
  if (s.blocked === 'sideload') return { ...status(s, now), line: SIDELOAD_LINE, resume: false, sideload: true }
  const today: StopBar = { ...status(s, now), line: endLine(s), resume: false }
  if (!terminals || s.resume === undefined) return today
  if (s.resume === 'ok') return { ...today, line: `${today.line} ${RESUME_LINE}`, resume: true }
  // A word this page doesn't know (a newer server): today's bar, with no Resume.
  const why = (RESUME_BLOCKED as Record<string, string | undefined>)[s.resume]
  return why === undefined ? today : { dot: 's-bad', word: CANT_RESUME, line: why, resume: false }
}

/** Starting, live, and waiting draw the terminal; ended and stopped draw the stop bar. */
export const terminalBody = (s: HostedSession, now: number, terminals: boolean): TerminalBody => (isOpen(s, now) ? { kind: 'terminal' } : { kind: 'stopped', bar: stopBar(s, now, terminals) })

/** The browser build (no terminal bridge): the session's dot, word, and one line, with the desktop note in place of buttons. */
export function browserView(s: HostedSession, now: number): BrowserView {
  const line = isOpen(s, now) ? `The terminal started at ${clock(s.startedAt)}.` : endLine(s)
  return { ...status(s, now), line, note: DESKTOP_TERMINAL }
}

/**
 * Open terminal, and the move to the tab after a New session, ask for focus in the live terminal. `take` it once the
 * view is attached, `wait` while it attaches, or `drop` the request on a screen that can't take keys (ended, stopped,
 * not available), so it never fires later.
 */
export type FocusMove = 'take' | 'drop' | 'wait'

/**
 * The run a focus request is for, as the screen's run key (`hashFor` of the run): the run the page's hash names, since
 * the ⋯ New session moves the page in the same tick, before the screen shows it; else (no hash, or junk) the shown run.
 */
export function focusRun(hash: string, shown: string): string {
  const route = parseHash(hash)
  return route === undefined ? shown : hashFor({ repoId: route.repoId, plan: route.plan, fix: undefined })
}

/** A request is dropped once another run shows: it never takes focus on a run it wasn't made for. */
export const keepFocusAsk = (ask: string | undefined, shown: string): boolean => ask === undefined || ask === shown

export function focusMove(v: { attached: boolean; ended: boolean; lost: boolean }): FocusMove {
  if (v.ended || v.lost) return 'drop'
  return v.attached ? 'take' : 'wait'
}

/** Why the host can't give a session's screen: it has no such session (`gone`), or it can't be used (`unavailable`). */
export type Lost = 'gone' | 'unavailable' | undefined

/** A `starting` session holds its attach until it is live: the host may not hold it yet, and an early attach would read as gone. */
export const canAttach = (s: HostedSession, now: number): boolean => sessionView(s, now) !== 'starting'

/** The view's handlers on the terminal link: a replay draws the whole screen again and brings the terminal back. */
export function screenHandlers(t: { reset(): void; write(data: string, done?: () => void): void }, setLost: (l: Lost) => void): TerminalHandlers {
  return {
    replay(data) {
      // A replay after the host restarted draws the whole screen again.
      t.reset()
      t.write(data)
      setLost(undefined)
    },
    data(data, written) {
      t.write(data, written)
    },
    exit() {
      // The Board says it ended; the stop bar comes from there.
    },
    gone: () => setLost('gone'),
    unavailable: () => setLost('unavailable'),
  }
}

/** The saved screen is asked for once the host lacks an ended session. */
export const wantSaved = (v: { ended: boolean; lost: Lost }): boolean => v.ended && v.lost !== undefined

/**
 * What the view draws (session-life §9). A live session: the terminal, or the unavailable line once the host lacks it.
 * Under the stop bar: the host's replay while it holds the session; else the saved screen; else nothing.
 */
export function screenUnder(v: { ended: boolean; lost: Lost; saved: string | undefined }): { show: 'terminal' | 'saved' | 'none'; line?: string } {
  if (v.lost === undefined) return { show: 'terminal' }
  if (!v.ended) return { show: 'none', line: UNAVAILABLE }
  return { show: v.saved === undefined ? 'none' : 'saved' }
}

/** Lines a terminal view keeps above its screen when the session has no `scrollback` (an older record). xterm's own default is 1,000. */
export const DEFAULT_SCROLLBACK = 5_000

/** The xterm options for one session's view: the page's look, 4.5:1 for every colour, and the session's own scrollback. */
export function terminalOptions(o: { look: TerminalLook; scrollback: number | undefined; ended: boolean }): ITerminalOptions {
  // 4.5:1 for every colour: xterm's own ANSI green is about 2.5:1 on the light --surface.
  return { ...o.look, minimumContrastRatio: 4.5, cursorBlink: true, disableStdin: o.ended, scrollback: o.scrollback ?? DEFAULT_SCROLLBACK }
}
