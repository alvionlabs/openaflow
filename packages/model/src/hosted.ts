// Hosted sessions: the sessions the app started in its terminal host, on the runs list.
// Which run a session joins, the one a row shows, and its view, word and dot.
// Pure. The shapes are sprint terminal-tab's shared contract §4 and session-life's §4; the rules and why are in
// pod-docs/feature-details/runs-and-pipeline.md.

import type { BoardRepo, HostedSession } from './board.ts'
import { fixRunNames } from './fix-runs.ts'
import { isRun } from './pipeline.ts'
import { runAgents } from './replies.ts'

/** What a session shows: its stored state, with `live` read as `waiting` while Claude waits for you. */
export type SessionView = 'starting' | 'live' | 'waiting' | 'ended' | 'stopped'

/** The status dot of a view, as the runs list names them. */
export type SessionDot = 'run' | 'you' | 'idle'

/** How long a live session can go without a `SessionStart` line before it reads `waiting`. */
export const WAITING_AFTER_MS = 10_000

/** `id` is a session the app hosts: one any hosted session held, in any state. */
export const isHostedSession = (repo: Pick<BoardRepo, 'hosted'>, id: string): boolean =>
  (repo.hosted ?? []).some((s) => s.sessions.includes(id))

/** The runs a session can join: the ones the runs list shows, in its run order before sorting (plans, then one-off runs). */
function listedRuns(repo: BoardRepo, now: number): string[] {
  if (repo.error !== undefined || !repo.model.docs.supported) return []
  return [...repo.model.plans.filter((p) => isRun(repo, p, now)).map((p) => p.slug), ...fixRunNames(repo)]
}

/**
 * The plan or one-off run a session joins: the listed run whose agents hold one of its `sessions`. With several,
 * the run of the newest such agent (`lastAt`; none is oldest), then run order. `undefined`: the repo row.
 */
export function joinedRun(repo: BoardRepo, session: HostedSession, now: number): string | undefined {
  const ids = new Set(session.sessions)
  let best: { run: string; at: number } | undefined
  for (const run of listedRuns(repo, now)) {
    const held = runAgents(repo, run, now).filter((a) => a.session !== '' && ids.has(a.session))
    if (held.length === 0) continue
    const at = Math.max(...held.map((a) => a.lastAt ?? Number.NEGATIVE_INFINITY))
    if (!best || at > best.at) best = { run, at }
  }
  return best?.run
}

/** The hosted sessions on one row, oldest first: a run's (`run` its plan slug or claim name), or the repo row's (`undefined`). */
export function rowSessions(repo: BoardRepo, run: string | undefined, now: number): HostedSession[] {
  return (repo.hosted ?? []).filter((s) => joinedRun(repo, s, now) === run)
}

const isOpen = (s: HostedSession) => s.state === 'starting' || s.state === 'live'

/** The session a row shows: the newest `starting` or `live` by `startedAt`, else the newest. A tie goes to the later record. */
export function shownSession(sessions: readonly HostedSession[]): HostedSession | undefined {
  const newest = (xs: readonly HostedSession[]) => xs.reduce<HostedSession | undefined>((b, s) => (!b || s.startedAt >= b.startedAt ? s : b), undefined)
  return newest(sessions.filter(isOpen)) ?? newest(sessions)
}

/** A live session with no `SessionStart` line `WAITING_AFTER_MS` after its start waits for you (a trust or sign-in prompt). */
export function sessionView(s: HostedSession, now: number): SessionView {
  if (s.state === 'live' && !s.hooked && now - s.startedAt >= WAITING_AFTER_MS) return 'waiting'
  return s.state
}

/** The session's status words. */
export function sessionWord(s: HostedSession, now: number): string {
  switch (sessionView(s, now)) {
    case 'starting':
      return 'Starting'
    case 'live':
      return 'Live'
    case 'waiting':
      return 'Waiting for you'
    case 'ended':
      return s.exitCode !== undefined && s.exitCode !== 0 ? `Ended · Claude exited with code ${s.exitCode}` : 'Ended · Claude exited'
    case 'stopped':
      return s.stopReason ? `Stopped · ${s.stopReason}` : 'Stopped'
  }
}

const DOTS: Record<SessionView, SessionDot> = { starting: 'run', live: 'run', waiting: 'you', ended: 'idle', stopped: 'idle' }

export const sessionDot = (view: SessionView): SessionDot => DOTS[view]

/** The session's name in the quit dialog: `<repo name> · <joined run>`, or `<repo name> · no plan yet` on the repo row. */
export const sessionLabel = (repo: BoardRepo, session: HostedSession, now: number): string =>
  `${repo.name} · ${joinedRun(repo, session, now) ?? 'no plan yet'}`
