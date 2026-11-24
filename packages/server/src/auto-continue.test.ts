import { realpathSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRepoModel, type AgentRun, type Board, type BoardRepo, type HostedSession, type NewActionEntry, type PrStatus, type RepoFiles } from '@openaflow/model'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AUTO_TICK_MS, createAutoContinue, runResume } from './auto-continue.ts'
import { createAutoContinueStore, type AutoContinueStore } from './auto-continue-store.ts'
import type { StartResult } from './claude-runner.ts'
import type { WorkflowResolver } from './workflow-resolver.ts'

let root: string
let file: string

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'openaflow-s1-auto-')))
  file = join(root, 'cfg', 'auto-continue.json')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

type Start = { session: string; word: string; cwd: string; plugins?: readonly string[] }

/** A fake runner: records each start and answers with `result`. No real claude, ever. */
function fakeRunner(result: () => Promise<StartResult> | StartResult = () => ({ outcome: 'started' })) {
  const starts: Start[] = []
  const running = new Set<string>()
  return {
    starts,
    running,
    start: async (r: Start) => {
      starts.push(r)
      return result()
    },
    isRunning: (s: string) => running.has(s),
  }
}

/** The check over a Board you set, with fakes for everything outside the server. */
function setup(o: { board: Board; store?: AutoContinueStore; runner?: ReturnType<typeof fakeRunner>; idle?: (repo: BoardRepo, session: string) => boolean; inFlight?: Set<string>; onError?: (err: unknown) => void; owner?: () => boolean; workflows?: Pick<WorkflowResolver, 'forRepo'> }) {
  let board = o.board
  const subscribers = new Set<(b: Board) => void>()
  const logged: NewActionEntry[] = []
  const events: string[] = []
  const runner = o.runner ?? fakeRunner()
  const store = o.store ?? createAutoContinueStore({ file })
  const inFlight = o.inFlight ?? new Set<string>()
  let idle = o.idle ?? (() => true)
  const auto = createAutoContinue({
    board: () => board,
    subscribe: (fn) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    rebuild: async () => {
      events.push('rebuild')
    },
    log: {
      append: async (e) => {
        events.push('log')
        logged.push(e)
        return true
      },
    },
    runner,
    store,
    idle: (repo, session) => idle(repo, session),
    inFlight,
    workflows: o.workflows ?? { forRepo: () => ({ source: 'claude-pod', version: '0.11.10', dir: join(root, 'workflows', 'claude-pod'), template: join(root, 't') }) },
    pluginDir: join(root, 'hooks-plugin'),
    now: () => NOW,
    onError: o.onError,
    ...(o.owner ? { owner: o.owner } : {}),
  })
  /** A new Board from the watcher. */
  const emit = (b: Board = board) => {
    board = b
    for (const fn of subscribers) fn(b)
  }
  return { auto, runner, store, logged, events, inFlight, emit, setIdle: (f: (repo: BoardRepo, session: string) => boolean) => (idle = f), subscribers }
}


describe('automatic check', () => {
  /** A real store whose `list` throws, as a broken disk read would. */
  const throwingStore = () => ({ ...createAutoContinueStore({ file }), list: (): never => { throw new Error('list failed') } }) as AutoContinueStore

  test('a check that throws is logged and holds no session', async () => {
    const errors: unknown[] = []
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), store: throwingStore(), onError: (e) => errors.push(e) })
    expect(() => s.auto.check()).not.toThrow()
    await s.auto.check()
    expect(errors.length).toBe(2)
    expect(errors.every((e) => e instanceof Error && e.message === 'list failed')).toBe(true)
    expect(s.inFlight.size).toBe(0)
    expect(s.runner.starts).toEqual([])
  })

  test('start survives a check that throws', () => {
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), store: throwingStore(), onError: () => {} })
    expect(() => s.auto.start()).not.toThrow()
    s.auto.stop()
  })

  test('only the owner sends', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    let owns = false
    const asked: boolean[] = []
    const s = setup({
      board: boardOf(planRepo(SPRINT_DONE)),
      store,
      owner: () => {
        asked.push(owns)
        return owns
      },
    })
    await s.auto.check()
    expect(asked).toEqual([false])
    expect(s.runner.starts).toEqual([])
    expect(s.logged).toEqual([])
    expect(s.inFlight.size).toBe(0)
    // The key isn't saved either, so the stop stays due for the owner.
    expect(s.store.list()).toEqual([{ path: '/r', run: 'alpha' }])

    owns = true
    await s.auto.check()
    expect(s.runner.starts).toHaveLength(1)

    // With no owner check, it sends as it always did.
    const free = createAutoContinueStore({ file: join(root, 'cfg', 'other.json') })
    await free.set('/r', 'alpha', true)
    const none = setup({ board: boardOf(planRepo(SPRINT_DONE)), store: free })
    await none.auto.check()
    expect(none.runner.starts).toHaveLength(1)
  })

  test('an owner check that throws sends nothing and is logged', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    const errors: unknown[] = []
    const s = setup({
      board: boardOf(planRepo(SPRINT_DONE)),
      store,
      onError: (e) => errors.push(e),
      owner: () => {
        throw new Error('owner failed')
      },
    })
    await s.auto.check()
    expect(s.runner.starts).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('sends only with the toggle on', async () => {
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)) })
    await s.auto.check()
    expect(s.runner.starts).toEqual([])
    expect(s.logged).toEqual([])

    await s.store.set('/r', 'alpha', true)
    await s.auto.check()
    expect(s.runner.starts).toEqual([{ session: 'sess-1', word: 'continue', cwd: '/r' }])
    expect(s.logged).toEqual([{ action: 'resume', repoId: 'id-r', repo: 'r', target: 'alpha · continue', result: 'started', reply: 'continue', auto: true }])
    expect(s.events).toEqual(['log', 'rebuild'])
    expect(s.store.list()).toEqual([{ path: '/r', run: 'alpha', lastKey: 'sprint-done:one' }])

    // Off again: nothing more, on any Board.
    await s.store.set('/r', 'alpha', false)
    s.emit(boardOf(planRepo(NEXT_SPRINT_DONE)))
    await s.auto.check()
    expect(s.runner.starts).toHaveLength(1)
  })

  test('one send per stop, across restarts', async () => {
    const results: StartResult[] = [{ outcome: 'failed', message: 'claude not found' }]
    const runner = fakeRunner(() => results.shift() ?? { outcome: 'started' })
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), store, runner })
    s.auto.start()
    await s.auto.settled()
    expect(runner.starts).toHaveLength(1)
    // The send failed: it's logged, and not retried for this stop.
    expect(s.logged).toEqual([
      { action: 'resume', repoId: 'id-r', repo: 'r', target: 'alpha · continue', result: 'failed', message: 'claude not found', reply: 'continue', auto: true },
    ])
    // The toggle marks the failure, before the rebuild, so the Board raises the stop again (attention.ts).
    expect(store.list()).toEqual([{ path: '/r', run: 'alpha', lastKey: expect.any(String), lastFailed: true }])

    // New Boards and more checks on the same stop send nothing.
    s.emit(boardOf(planRepo(SPRINT_DONE)))
    await s.auto.check()
    await s.auto.check()
    expect(runner.starts).toHaveLength(1)
    s.auto.stop()

    // A restart: a new store read from the file, a new check.
    const again = setup({ board: boardOf(planRepo(SPRINT_DONE)), store: createAutoContinueStore({ file }), runner })
    again.auto.start()
    await again.auto.settled()
    await again.auto.check()
    expect(runner.starts).toHaveLength(1)

    // A new stop gets its own send.
    again.emit(boardOf(planRepo(NEXT_SPRINT_DONE)))
    await again.auto.settled()
    await again.auto.check()
    expect(runner.starts).toHaveLength(2)
    expect(again.logged.at(-1)).toMatchObject({ result: 'started', auto: true })
    // A send that starts clears the mark.
    expect(again.store.list()[0]).not.toHaveProperty('lastFailed')
    again.auto.stop()
  })

  test('checks on a tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    expect(AUTO_TICK_MS).toBe(15_000)
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), store, idle: () => false })
    s.auto.start()
    await s.auto.settled()
    expect(s.runner.starts).toEqual([])

    // The session goes quiet; the Board doesn't change. The next tick sends.
    s.setIdle(() => true)
    await vi.advanceTimersByTimeAsync(AUTO_TICK_MS - 1)
    expect(s.runner.starts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await s.auto.settled()
    expect(s.runner.starts).toHaveLength(1)

    // Stopped: no more ticks, and no more Board subscriptions.
    s.auto.stop()
    expect(s.subscribers.size).toBe(0)
  })

  test('no send without a saved key', async () => {
    const real = createAutoContinueStore({ file })
    await real.set('/r', 'alpha', true)
    let fail = true
    const store: AutoContinueStore = {
      list: () => real.list(),
      set: (...a) => real.set(...a),
      forgetPath: (...a) => real.forgetPath(...a),
      saveFailed: (...a) => real.saveFailed(...a),
      saveKey: async (...a) => {
        if (fail) throw new Error('disk full')
        return real.saveKey(...a)
      },
    }
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), store })
    await s.auto.check()
    expect(s.runner.starts).toEqual([])
    expect(s.logged).toEqual([])
    // The session is free again for the next check.
    expect(s.inFlight.size).toBe(0)

    fail = false
    await s.auto.check()
    expect(s.runner.starts).toHaveLength(1)
    expect(real.list()[0]?.lastKey).toBe('sprint-done:one')
  })

  test('skips a session already resuming', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), store })

    // A request in flight (the route, or another check) for that session.
    s.inFlight.add('sess-1')
    await s.auto.check()
    expect(s.runner.starts).toEqual([])
    s.inFlight.delete('sess-1')

    // A child the runner started is still alive.
    s.runner.running.add('sess-1')
    await s.auto.check()
    expect(s.runner.starts).toEqual([])
    s.runner.running.delete('sess-1')

    // Two checks at once start one run, and the session is held while it starts.
    let release!: (r: StartResult) => void
    const slow = fakeRunner(() => new Promise<StartResult>((r) => (release = r)))
    const t = setup({ board: boardOf(planRepo(SPRINT_DONE)), store, runner: slow })
    const first = t.auto.check()
    const second = t.auto.check()
    await vi.waitFor(() => expect(slow.starts).toHaveLength(1))
    expect(t.inFlight.has('sess-1')).toBe(true)
    release({ outcome: 'started' })
    await Promise.all([first, second])
    expect(slow.starts).toHaveLength(1)
    expect(t.inFlight.size).toBe(0)
  })

  test('a runner that throws is logged as failed', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    const runner = fakeRunner(() => {
      throw new Error('spawn EPERM')
    })
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE)), store, runner })
    await s.auto.check()
    expect(s.logged).toEqual([
      { action: 'resume', repoId: 'id-r', repo: 'r', target: 'alpha · continue', result: 'failed', message: 'spawn EPERM', reply: 'continue', auto: true },
    ])
    expect(store.list()[0]).toMatchObject({ lastFailed: true })
    expect(s.inFlight.size).toBe(0)
  })

  test('never sends go', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    await store.set('/id-d', 'alpha', true)
    // A fresh plan beside a run at a send stop, both toggled on: only the send stop gets one continue.
    const done = () => planRepo(SPRINT_DONE, { id: 'id-d', session: 'sess-2' })
    const s = setup({ board: boardOf(planRepo(FRESH), done()), store })
    s.auto.start()
    await s.auto.settled()
    s.emit(boardOf(planRepo(FRESH), done()))
    await vi.advanceTimersByTimeAsync(AUTO_TICK_MS * 3)
    await s.auto.check()
    // A wave waiting on your merge isn't sent either.
    s.emit(boardOf(planRepo(WAVE_WAITING), done()))
    await vi.advanceTimersByTimeAsync(AUTO_TICK_MS)
    await s.auto.settled()
    expect(s.runner.starts).toEqual([{ session: 'sess-2', word: 'continue', cwd: '/id-d' }])
    expect(s.logged.map((e) => e.target)).toEqual(['alpha · continue'])
    expect(s.logged.every((e) => e.action === 'resume' && e.reply === 'continue')).toBe(true)
    s.auto.stop()
  })

  test('an idle check that throws counts as busy', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    const s = setup({
      board: boardOf(planRepo(SPRINT_DONE)),
      store,
      idle: () => {
        throw new Error('EACCES')
      },
    })
    await s.auto.check()
    expect(s.runner.starts).toEqual([])
  })
})

describe('workflow plugin folders', () => {
  test('an automatic send in a set-up repo carries the hooks and workflow folders', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE, { setUp: true })), store })
    await s.auto.check()
    expect(s.runner.starts).toStrictEqual([{ session: 'sess-1', word: 'continue', cwd: '/r', plugins: [join(root, 'hooks-plugin'), join(root, 'workflows', 'claude-pod')] }])
  })

  test('an automatic send in a set-up repo with no bundle fails as workflow missing', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    const s = setup({ board: boardOf(planRepo(SPRINT_DONE, { setUp: true })), store, workflows: { forRepo: () => undefined } })
    await s.auto.check()
    expect(s.runner.starts).toEqual([])
    expect(s.logged).toEqual([{ action: 'resume', repoId: 'id-r', repo: 'r', target: 'alpha · continue', result: 'failed', reply: 'continue', auto: true, message: 'workflow missing' }])
    expect(store.list()).toEqual([{ path: '/r', run: 'alpha', lastKey: 'sprint-done:one', lastFailed: true }])
  })

  test('runResume with no resolver refuses a set-up repo', async () => {
    const runner = fakeRunner()
    const result = await runResume({ runner, log: { append: async () => true } }, { repo: planRepo(SPRINT_DONE, { setUp: true }), run: 'alpha', session: 'sess-1', word: 'go', auto: false })
    expect(result).toEqual({ outcome: 'failed', message: 'workflow missing', logged: true })
    expect(runner.starts).toEqual([])
  })
})

describe('hosted sessions', () => {
  test('runResume refuses a hosted session', async () => {
    const states: [HostedSession['state'], Partial<HostedSession>][] = [
      ['starting', {}],
      ['live', {}],
      ['ended', { exitCode: 3 }],
      ['stopped', { stopReason: 'terminals restarted' }],
    ]
    for (const [state, over] of states) {
      for (const word of ['continue', 'go'] as const) {
        for (const auto of [true, false]) {
          const runner = fakeRunner()
          const logged: NewActionEntry[] = []
          const log = { append: async (e: NewActionEntry) => (logged.push(e), true) }
          // The run's agent writes under the id the session got after /clear.
          const repo = hostedIn(planRepo(SPRINT_DONE, { session: 'sess-new' }), state, ['sess-start', 'sess-new'], over)
          const label = `${state} ${word} ${auto}`
          const result = await runResume({ runner, log }, { repo, run: 'alpha', session: 'sess-new', word, auto })
          expect(result, label).toEqual({ outcome: 'failed', message: 'hosted session', logged: true })
          expect(runner.starts, label).toEqual([])
          expect(logged, label).toEqual([{ action: 'resume', repoId: 'id-r', repo: 'r', target: `alpha · ${word}`, result: 'failed', message: 'hosted session', reply: word, auto }])
        }
      }
    }
    // A session the app doesn't host, beside a hosted one in the same repo, still starts.
    const runner = fakeRunner()
    const repo = hostedIn(planRepo(SPRINT_DONE), 'live', ['sess-other'])
    expect(await runResume({ runner, log: { append: async () => true } }, { repo, run: 'alpha', session: 'sess-1', word: 'continue', auto: false })).toEqual({ outcome: 'started', logged: true })
    expect(runner.starts).toHaveLength(1)
  })

  test('the check skips hosted sessions quietly', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    const s = setup({ board: boardOf(hostedIn(planRepo(SPRINT_DONE), 'live', ['sess-1'])), store })
    s.auto.start()
    await s.auto.settled()
    // New Boards, ticks, and a stopped session: still nothing.
    s.emit(boardOf(hostedIn(planRepo(SPRINT_DONE), 'stopped', ['sess-1'], { stopReason: 'app closed' })))
    await vi.advanceTimersByTimeAsync(AUTO_TICK_MS * 2)
    await s.auto.settled()
    expect(s.runner.starts).toEqual([])
    // No log entry, no rebuild, no saved key, no failed mark, and no session held.
    expect(s.logged).toEqual([])
    expect(s.events).toEqual([])
    expect(store.list()).toEqual([{ path: '/r', run: 'alpha' }])
    expect(s.inFlight.size).toBe(0)
    s.auto.stop()
  })

  test('dismissed is not hosted', async () => {
    const store = createAutoContinueStore({ file })
    await store.set('/r', 'alpha', true)
    const s = setup({ board: boardOf(hostedIn(planRepo(SPRINT_DONE), 'ended', ['sess-1'], { exitCode: 0 })), store })
    await s.auto.check()
    expect(s.runner.starts).toEqual([])
    // Dismiss removes the record: the next Board has no hosted session, and the same stop is sent once, by today's rules.
    s.emit(boardOf(planRepo(SPRINT_DONE)))
    await s.auto.settled()
    await s.auto.check()
    expect(s.runner.starts).toEqual([{ session: 'sess-1', word: 'continue', cwd: '/r' }])
    expect(s.logged).toEqual([{ action: 'resume', repoId: 'id-r', repo: 'r', target: 'alpha · continue', result: 'started', reply: 'continue', auto: true }])
    expect(store.list()).toEqual([{ path: '/r', run: 'alpha', lastKey: 'sprint-done:one' }])
  })
})

// ---- Inline Boards: a plan run at a chosen stop, built with the model's own parser. ----



const NOW = Date.UTC(2026, 9, 22, 12)
const MIN = 60_000
const README = '# pod docs\n\npod docs: 2\n'

type SprintRow = [slug: string, status: string]
type BoardRow = [wave: number, code: string, pr: string, status: string]

function planDoc(slug: string, sprints: SprintRow[]): string {
  return [
    `# Plan: ${slug}`,
    '',
    '_Generated: 2026-10-22 · Status: active · Grilled-with: grilling_',
    '',
    '## Sprint sequence',
    '',
    '| Sprint | Goal | Status | Depends on |',
    '|--------|------|--------|------------|',
    ...sprints.map(([s, st]) => `| ${s} | goal of ${s} | ${st} | — |`),
    '',
  ].join('\n')
}

function sprintDoc(slug: string, plan: string, rows: BoardRow[]): string {
  return [
    `# Sprint: ${slug}`,
    '',
    `_From plan: pod-docs/plans/${plan}.md · Slug: ${slug} · Status: active · Generated: 2026-10-22_`,
    '',
    '## Status board',
    '',
    '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |',
    '|------|-------|-------|--------|----|--------|------------|------------|',
    ...rows.map(([w, code, pr, status]) => `| ${w} | ${code} | Title ${code} | ${slug}-${code} | ${pr} | ${status} | medium | — |`),
    '',
  ].join('\n')
}

type Stop = { sprints: SprintRow[]; docs?: Record<string, BoardRow[]>; prs?: PrStatus[] }

const link = (n: number) => `[#${n}](https://github.com/o/r/pull/${n})`
const gh = (number: number, state: PrStatus['state'], over: Partial<PrStatus> = {}): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW, ...over })

const PUSHED: BoardRow[] = [
  [1, 'A1', `${link(5)} merged`, 'done'],
  [2, 'B1', link(7), 'pushed'],
]

/** Sprint one done, two not drafted yet: `continue`, key `sprint-done:one`. */
const SPRINT_DONE: Stop = { sprints: [['one', 'done'], ['two', 'planned']], docs: { one: [[1, 'A1', 'merged', 'done']] } }
/** Sprints one and two done, three next: `continue`, key `sprint-done:two`. */
const NEXT_SPRINT_DONE: Stop = {
  sprints: [['one', 'done'], ['two', 'done'], ['three', 'planned']],
  docs: { one: [[1, 'A1', 'merged', 'done']], two: [[1, 'B1', 'merged', 'done']] },
}
/** Wave 2's PR open: `continue` after your merge (not sendable). */
const WAVE_WAITING: Stop = { sprints: [['one', 'active']], docs: { one: PUSHED }, prs: [gh(7, 'open')] }
/** Wave 2's PR merged: `continue`, key `wave-merged:7`. */
const WAVE_MERGED: Stop = { sprints: [['one', 'active']], docs: { one: PUSHED }, prs: [gh(7, 'merged')] }
/** No sprint started: `go`, key `not-started:alpha`. */
const FRESH: Stop = { sprints: [['one', 'planned'], ['two', 'planned']] }
/** Sprint one in progress with work left: no reply at all. */
const WORKING: Stop = { sprints: [['one', 'active']], docs: { one: [[1, 'A1', '', 'in progress']] } }

let seq = 0
function agent(over: Partial<AgentRun>): AgentRun {
  seq += 1
  return { id: `a${seq}`, session: 'sess-1', type: 'pod:engineer', tokens: 0, ended: true, startedAt: NOW - 60 * MIN, lastAt: NOW - 40 * MIN, ...over }
}

/** A repo whose plan `alpha` is at `stop`, with one ended agent in `session` (none when `session` is empty). */
function planRepo(stop: Stop, o: { session?: string; id?: string; path?: string; setUp?: true } = {}): BoardRepo {
  // A set-up repo keeps the same docs in its workflow's state folder.
  const dir = o.setUp ? '.openaflow/workflows/claude-pod/state' : 'pod-docs'
  const files: RepoFiles = {
    [`${dir}/README.md`]: README,
    [`${dir}/plans/alpha.md`]: planDoc('alpha', stop.sprints),
    [`${dir}/handoff-queue.md`]: '',
  }
  for (const [s, rows] of Object.entries(stop.docs ?? {})) files[`${dir}/sprints/${s}.md`] = sprintDoc(s, 'alpha', rows)
  if (o.setUp) Object.assign(files, { '.openaflow/': '', '.openaflow/workflows/claude-pod/': '' })
  const session = o.session ?? 'sess-1'
  return {
    id: o.id ?? 'id-r',
    name: 'r',
    path: o.path ?? (o.id === undefined || o.id === 'id-r' ? '/r' : `/${o.id}`),
    source: 'registered',
    model: buildRepoModel(files),
    agents: session === '' ? [] : [agent({ plan: 'alpha', session })],
    prs: stop.prs ?? [],
    claims: [],
  }
}

const boardOf = (...repos: BoardRepo[]): Board => ({ generatedAt: NOW, gh: 'ok', repos })

/** `repo` with one hosted session in `state`, holding `sessions`. */
function hostedIn(repo: BoardRepo, state: HostedSession['state'], sessions: string[], over: Partial<HostedSession> = {}): BoardRepo {
  const hosted: HostedSession = { marker: `m-${repo.id}`, sessionId: sessions[0]!, liveSession: sessions.at(-1)!, sessions, skill: 'plan', startedAt: NOW - 30 * MIN, state, hooked: true, prompted: true, ...over }
  return { ...repo, hosted: [hosted] }
}
