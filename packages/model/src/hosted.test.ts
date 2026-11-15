import { describe, expect, it } from 'vitest'
import type { AgentRun, BoardRepo, HostedSession } from './board.ts'
import { isHostedSession, joinedRun, rowSessions, sessionDot, sessionLabel, sessionView, sessionWord, shownSession, WAITING_AFTER_MS } from './hosted.ts'
import { buildRepoModel, type RepoFiles } from './run-model.ts'

// Every snapshot is built inline: test/no-io.test.ts scans this folder, so no file reads here.

const NOW = Date.UTC(2026, 10, 14, 12)
const MIN = 60_000

function planDoc(slug: string, sprintStatus = 'planned', status = 'active'): string {
  return [
    `# Plan: ${slug.toUpperCase()}`,
    '',
    `_Generated: 2026-11-10 · Status: ${status}_`,
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    `| ${slug}-one | goal | ${sprintStatus} | — |`,
    '',
  ].join('\n')
}

/** Plans `alpha` and `beta`, both runs (a sprint not done), and no agents. */
function files(extra: RepoFiles = {}): RepoFiles {
  return {
    'pod-docs/README.md': '# pod docs\n\npod docs: 2\n',
    'pod-docs/plans/alpha.md': planDoc('alpha'),
    'pod-docs/plans/beta.md': planDoc('beta'),
    'pod-docs/handoff-queue.md': '',
    ...extra,
  }
}

function repoOf(agents: AgentRun[], hosted?: HostedSession[], extra: Partial<BoardRepo> = {}, repoFiles: RepoFiles = files()): BoardRepo {
  return { id: 'r', name: 'r', path: '/r', source: 'registered', model: buildRepoModel(repoFiles), agents, prs: [], claims: [], ...(hosted ? { hosted } : {}), ...extra }
}

let seq = 0
function agent(over: Partial<AgentRun>): AgentRun {
  seq += 1
  return { id: `a${seq}`, session: 's', type: 'pod:engineer', tokens: 0, ended: true, startedAt: NOW - 30 * MIN, lastAt: NOW - 20 * MIN, ...over }
}

function hosted(over: Partial<HostedSession> = {}): HostedSession {
  const sessionId = over.sessionId ?? 'sess-start'
  return {
    marker: 'mark-0000-1111',
    sessionId,
    liveSession: sessionId,
    sessions: [sessionId],
    skill: 'plan',
    startedAt: NOW - 5 * MIN,
    state: 'live',
    hooked: true,
    prompted: true,
    ...over,
  }
}

describe('join', () => {
  it('join follows every id the session held', () => {
    // The session dispatched alpha's agent under its start id.
    const start = hosted()
    const first = repoOf([agent({ plan: 'alpha', session: 'sess-start' })], [start])
    expect(joinedRun(first, start, NOW)).toBe('alpha')
    expect(rowSessions(first, 'alpha', NOW)).toEqual([start])
    expect(rowSessions(first, undefined, NOW)).toEqual([])
    expect(rowSessions(first, 'beta', NOW)).toEqual([])

    // After /clear the session runs under a new id; the agent pod dispatched since holds only that one.
    const cleared = hosted({ liveSession: 'sess-new', sessions: ['sess-start', 'sess-new'] })
    const after = repoOf([agent({ plan: 'alpha', session: 'sess-new' })], [cleared])
    expect(joinedRun(after, cleared, NOW)).toBe('alpha')
    expect(rowSessions(after, 'alpha', NOW)).toEqual([cleared])

    // A one-off run joins the same way, by its engineer's session.
    const task = hosted({ sessions: ['sess-start', 'sess-task'] })
    const oneOff = repoOf([agent({ branch: 'task-fix-x', session: 'sess-task' })], [task], { claims: [{ portBase: 3000, repoPath: '/r', plan: 'task-fix-x' }] })
    expect(joinedRun(oneOff, task, NOW)).toBe('task-fix-x')
    expect(rowSessions(oneOff, 'task-fix-x', NOW)).toEqual([task])
  })

  it('join edges', () => {
    const s = hosted({ sessions: ['sess-start', 'sess-new'] })
    // Two runs hold its ids: the run of the newest agent wins, whichever id it holds.
    const older = agent({ plan: 'alpha', session: 'sess-start', lastAt: NOW - 9 * MIN })
    const newer = agent({ plan: 'beta', session: 'sess-new', lastAt: NOW - 2 * MIN })
    expect(joinedRun(repoOf([older, newer], [s]), s, NOW)).toBe('beta')
    expect(joinedRun(repoOf([{ ...older, lastAt: NOW - MIN }, newer], [s]), s, NOW)).toBe('alpha')
    // A tie goes to run order: plans as the model lists them.
    expect(joinedRun(repoOf([{ ...older, lastAt: NOW - 2 * MIN }, newer], [s]), s, NOW)).toBe('alpha')
    // An agent with no last write loses to one with a write, but still joins when it is the only one.
    expect(joinedRun(repoOf([{ ...older, lastAt: undefined }, newer], [s]), s, NOW)).toBe('beta')
    expect(joinedRun(repoOf([{ ...older, lastAt: undefined }], [s]), s, NOW)).toBe('alpha')

    // None: a new plan doc beside it, with no agent yet, doesn't take it; the repo row does.
    const fresh = hosted()
    const repo = repoOf([], [fresh])
    expect(joinedRun(repo, fresh, NOW)).toBeUndefined()
    expect(rowSessions(repo, undefined, NOW)).toEqual([fresh])
    expect(rowSessions(repo, 'alpha', NOW)).toEqual([])

    // An agent on another session, or one that belongs to no run, joins nothing.
    expect(joinedRun(repoOf([agent({ plan: 'alpha', session: 'other' })], [fresh]), fresh, NOW)).toBeUndefined()
    expect(joinedRun(repoOf([agent({ type: 'Explore', session: 'sess-start' })], [fresh]), fresh, NOW)).toBeUndefined()
    // An agent with no session never joins, even a record that names an empty id.
    const blank = hosted({ sessionId: '', sessions: [''] })
    expect(joinedRun(repoOf([agent({ plan: 'alpha', session: '' })], [blank]), blank, NOW)).toBeUndefined()

    // A plan the list doesn't show (all sprints done, nothing running) is no row: the repo row takes the session.
    const done = files({ 'pod-docs/plans/alpha.md': planDoc('alpha', 'done') })
    const unlisted = repoOf([agent({ plan: 'alpha', session: 'sess-start' })], [fresh], {}, done)
    expect(joinedRun(unlisted, fresh, NOW)).toBeUndefined()
    expect(rowSessions(unlisted, undefined, NOW)).toEqual([fresh])

    // A repo the board can't read lists no runs: the session is on its one row.
    const broken = repoOf([agent({ plan: 'alpha', session: 'sess-start' })], [fresh], { error: 'cannot read repo' })
    expect(joinedRun(broken, fresh, NOW)).toBeUndefined()
    expect(rowSessions(broken, undefined, NOW)).toEqual([fresh])

    // Each row keeps the store's order: oldest first.
    const a = hosted({ marker: 'm-a', sessionId: 'x-a', startedAt: NOW - 9 * MIN })
    const b = hosted({ marker: 'm-b', sessionId: 'x-b', startedAt: NOW - 3 * MIN })
    expect(rowSessions(repoOf([], [a, b]), undefined, NOW).map((x) => x.marker)).toEqual(['m-a', 'm-b'])
  })
})

describe('shown session', () => {
  const at = (marker: string, state: HostedSession['state'], ago: number) => hosted({ marker, state, startedAt: NOW - ago * MIN })

  it('shown session', () => {
    expect(shownSession([])).toBeUndefined()
    // The newest starting or live, even when a stopped one is newer.
    expect(shownSession([at('live-old', 'live', 9), at('ended-new', 'ended', 1)])?.marker).toBe('live-old')
    expect(shownSession([at('live-old', 'live', 9), at('starting-new', 'starting', 3), at('stopped', 'stopped', 1)])?.marker).toBe('starting-new')
    // None starting or live: the newest.
    expect(shownSession([at('ended', 'ended', 9), at('stopped', 'stopped', 1)])?.marker).toBe('stopped')
    expect(shownSession([at('stopped', 'stopped', 1), at('ended', 'ended', 9)])?.marker).toBe('stopped')
    // A tie on startedAt goes to the later record.
    expect(shownSession([at('first', 'live', 4), at('second', 'live', 4)])?.marker).toBe('second')
  })
})

describe('view', () => {
  it('waiting after 10 s', () => {
    const s = hosted({ hooked: false, prompted: false, startedAt: NOW })
    expect(WAITING_AFTER_MS).toBe(10_000)
    expect(sessionView(s, NOW + 9_999)).toBe('live')
    expect(sessionView(s, NOW + 10_000)).toBe('waiting')
    expect(sessionView(s, NOW + 60 * MIN)).toBe('waiting')
    // Hooked reads live, however long ago it started.
    expect(sessionView({ ...s, hooked: true }, NOW + 60 * MIN)).toBe('live')
    // Only a live session can wait: starting, ended and stopped keep their own view.
    expect(sessionView({ ...s, state: 'starting' }, NOW + 60 * MIN)).toBe('starting')
    expect(sessionView({ ...s, state: 'ended' }, NOW + 60 * MIN)).toBe('ended')
    expect(sessionView({ ...s, state: 'stopped', stopReason: 'app closed' }, NOW + 60 * MIN)).toBe('stopped')
  })

  it('words', () => {
    const later = NOW + 60 * MIN
    const cases: [Partial<HostedSession>, string, string][] = [
      [{ state: 'starting', hooked: false }, 'Starting', 'run'],
      [{ state: 'live' }, 'Live', 'run'],
      [{ state: 'live', hooked: false }, 'Waiting for you', 'you'],
      [{ state: 'ended', exitCode: 0 }, 'Ended · Claude exited', 'idle'],
      [{ state: 'ended', exitCode: 3 }, 'Ended · Claude exited with code 3', 'idle'],
      // reconcile can end a session with no code
      [{ state: 'ended' }, 'Ended · Claude exited', 'idle'],
      [{ state: 'stopped', stopReason: 'app closed' }, 'Stopped · app closed', 'idle'],
      [{ state: 'stopped', stopReason: 'terminals restarted' }, 'Stopped · terminals restarted', 'idle'],
      // a stopped record with no reason names none
      [{ state: 'stopped' }, 'Stopped', 'idle'],
    ]
    const read = cases.map(([over]) => {
      const s = hosted(over)
      return [sessionWord(s, later), sessionDot(sessionView(s, later))]
    })
    expect(read).toEqual(cases.map(([, word, dot]) => [word, dot]))
  })
})

describe('hosted ids', () => {
  it('hosted ids', () => {
    const states: HostedSession['state'][] = ['starting', 'live', 'ended', 'stopped']
    for (const state of states) {
      const s = hosted({ state, liveSession: 'sess-c', sessions: ['sess-start', 'sess-b', 'sess-c'] })
      const repo = repoOf([], [hosted({ marker: 'other', sessionId: 'sess-other' }), s])
      for (const id of ['sess-start', 'sess-b', 'sess-c', 'sess-other']) expect(isHostedSession(repo, id), `${state} ${id}`).toBe(true)
      expect(isHostedSession(repo, 'sess-x')).toBe(false)
      expect(isHostedSession(repo, '')).toBe(false)
    }
    // No hosted field, or an empty one: nothing is hosted.
    expect(isHostedSession(repoOf([]), 'sess-start')).toBe(false)
    expect(isHostedSession(repoOf([], []), 'sess-start')).toBe(false)
  })
})

describe('session label', () => {
  it('session label', () => {
    // Joined to a plan: the repo name, then the plan slug.
    const s = hosted()
    expect(sessionLabel(repoOf([agent({ plan: 'alpha', session: 'sess-start' })], [s], { name: 'shop' }), s, NOW)).toBe('shop · alpha')
    // Joined to a one-off run: its claim name.
    const task = hosted({ sessions: ['sess-start', 'sess-task'] })
    const oneOff = repoOf([agent({ branch: 'task-fix-x', session: 'sess-task' })], [task], { name: 'shop', claims: [{ portBase: 3000, repoPath: '/r', plan: 'task-fix-x' }] })
    expect(sessionLabel(oneOff, task, NOW)).toBe('shop · task-fix-x')
    // On the repo row: no plan yet. A plan doc with no agent of the session doesn't count.
    expect(sessionLabel(repoOf([], [s], { name: 'shop' }), s, NOW)).toBe('shop · no plan yet')
    expect(sessionLabel(repoOf([agent({ plan: 'alpha', session: 'other' })], [s], { name: 'shop' }), s, NOW)).toBe('shop · no plan yet')
    // A repo the board can't read lists no runs: no plan yet.
    expect(sessionLabel(repoOf([agent({ plan: 'alpha', session: 'sess-start' })], [s], { name: 'shop', error: 'cannot read repo' }), s, NOW)).toBe('shop · no plan yet')
    // The same join as the runs list: the newest agent's run wins.
    const both = hosted({ sessions: ['sess-start', 'sess-new'] })
    const older = agent({ plan: 'alpha', session: 'sess-start', lastAt: NOW - 9 * MIN })
    const newer = agent({ plan: 'beta', session: 'sess-new', lastAt: NOW - 2 * MIN })
    expect(sessionLabel(repoOf([older, newer], [both], { name: 'shop' }), both, NOW)).toBe('shop · beta')
  })
})
