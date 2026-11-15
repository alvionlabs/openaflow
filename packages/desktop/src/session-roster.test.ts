import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { JobControl, SessionEnder } from './session-ender.ts'
import { createSessionRoster, FLUSH_LIMIT_MS } from './session-roster.ts'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const C = 'cccccccc-0000-4000-8000-000000000003'
const D = 'dddddddd-0000-4000-8000-000000000004'
const STOP = (id: string) => ['/usr/bin/systemctl', '--user', 'stop', `openaflow-run-${id}.scope`]

type Deferred = { promise: Promise<void>; resolve(): void }
const deferred = (): Deferred => {
  let resolve = () => {}
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function setup(o: { platform?: NodeJS.Platform; jobs?: JobControl; flush?: () => Promise<unknown> } = {}) {
  const calls: string[] = []
  const pending: Deferred[] = []
  const ender: SessionEnder = {
    end: vi.fn((id: string, pid: number, stop?: string[]) => {
      calls.push(`end ${id.slice(0, 1)} ${pid} ${stop ? 'stop' : '-'}`)
      const d = deferred()
      pending.push(d)
      return d.promise
    }),
    sweep: vi.fn((id: string, stop?: string[]) => {
      calls.push(`sweep ${id.slice(0, 1)} ${stop ? 'stop' : '-'}`)
      const d = deferred()
      pending.push(d)
      return d.promise
    }),
  }
  const flush = vi.fn(o.flush ?? (async () => void calls.push('flush')))
  const log = vi.fn()
  const roster = createSessionRoster({ platform: o.platform ?? 'linux', ender, jobs: o.jobs, flush, log })
  const finish = () => {
    for (const d of pending.splice(0)) d.resolve()
  }
  return { roster, calls, finish, flush, log, ender }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('end all', () => {
  test('flushes first, then ends live ones and sweeps ended ones, all at once', async () => {
    const { roster, calls, finish, flush } = setup()
    roster.starting(A, STOP(A))
    roster.started(A, 1000)
    roster.starting(B, STOP(B))
    roster.started(B, 2000)
    roster.ended(B)
    roster.starting(C) // still waiting for its pid
    roster.setLabels([{ id: A, label: 'chess · plan-x' }])
    expect(roster.live().map((s) => [s.id, s.pid, s.label])).toEqual([
      [A, 1000, 'chess · plan-x'],
      [C, 0, undefined],
    ])
    let done = false
    const p = roster.endAll().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(flush).toHaveBeenCalledOnce()
    // Every end began before any finished.
    expect(calls).toEqual(['flush', 'end a 1000 stop', 'sweep b stop', 'end c 0 -'])
    expect(done).toBe(false)
    finish()
    await p
    expect(roster.live()).toEqual([])
    expect(roster.sessions().map((s) => s.state)).toEqual(['ended', 'ended', 'ended'])
  })

  test('a hung flush waits only 2 s; a failed flush waits for nothing', async () => {
    const hung = setup({ flush: () => new Promise(() => {}) })
    hung.roster.starting(A)
    hung.roster.started(A, 1000)
    void hung.roster.endAll()
    await vi.advanceTimersByTimeAsync(FLUSH_LIMIT_MS - 1)
    expect(hung.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(hung.calls).toEqual(['end a 1000 -'])

    const failed = setup({ flush: () => Promise.reject(new Error('host gone')) })
    failed.roster.started(A, 1000)
    void failed.roster.endAll()
    await vi.advanceTimersByTimeAsync(0)
    expect(failed.calls).toEqual(['end a 1000 -'])
  })

  test('a second endAll while one runs is the same; after it, only new sessions are ended', async () => {
    const { roster, calls, finish, flush } = setup()
    roster.started(A, 1000)
    const one = roster.endAll()
    const two = roster.endAll()
    await vi.advanceTimersByTimeAsync(0)
    // The host's exit for A arrives during the end: no second sweep later.
    roster.ended(A)
    finish()
    await Promise.all([one, two])
    expect(calls).toEqual(['flush', 'end a 1000 -'])
    roster.started(D, 4000)
    const three = roster.endAll()
    await vi.advanceTimersByTimeAsync(0)
    finish()
    await three
    expect(calls).toEqual(['flush', 'end a 1000 -', 'flush', 'end d 4000 -'])
    expect(flush).toHaveBeenCalledTimes(2)
  })

  test('an ender that throws still lets endAll resolve', async () => {
    const { roster, ender } = setup()
    vi.mocked(ender.end).mockImplementation(() => Promise.reject(new Error('boom')))
    roster.started(A, 1000)
    await expect(roster.endAll()).resolves.toBeUndefined()
  })
})

describe('sweeps', () => {
  test('a server sweep skips live and pid-waiting ids and sweeps the rest', async () => {
    const { roster, calls, finish } = setup()
    roster.started(A, 1000)
    roster.starting(B, STOP(B))
    roster.started(C, 3000)
    roster.ended(C)
    const p = roster.sweep([{ id: A, stop: STOP(A) }, { id: B }, { id: C }, { id: D, stop: STOP(D) }])
    await vi.advanceTimersByTimeAsync(0)
    finish()
    await p
    expect(calls).toEqual(['sweep c -', 'sweep d stop'])
    // Each id once.
    await roster.sweep([{ id: C }, { id: D }])
    expect(calls).toEqual(['sweep c -', 'sweep d stop'])
  })

  test('lost ids are swept once, with their own stop', async () => {
    const { roster, calls, finish } = setup()
    roster.starting(A, STOP(A))
    roster.started(A, 1000)
    roster.started(B, 2000)
    const p = roster.lost([A, B])
    const again = roster.lost([A])
    await vi.advanceTimersByTimeAsync(0)
    finish()
    await Promise.all([p, again])
    expect(calls).toEqual(['sweep a stop', 'sweep b -'])
    expect(roster.live()).toEqual([])
    // Neither a later quit nor a server sweep takes them again.
    const q = roster.endAll()
    await vi.advanceTimersByTimeAsync(0)
    finish()
    await q
    await roster.sweep([{ id: A }, { id: B }])
    expect(calls).toEqual(['sweep a stop', 'sweep b -', 'flush'])
  })
})

describe('jobs', () => {
  const jobsFake = (answer: () => Promise<boolean>) => ({ assign: vi.fn(answer), close: vi.fn(async () => {}), dispose: vi.fn() })

  test('started assigns the job on Windows only', async () => {
    const win = jobsFake(async () => true)
    const w = setup({ platform: 'win32', jobs: win })
    w.roster.starting(A)
    w.roster.started(A, 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(win.assign.mock.calls).toEqual([[A, 1000]])
    expect(w.log).not.toHaveBeenCalled()

    const lin = jobsFake(async () => true)
    const l = setup({ platform: 'linux', jobs: lin })
    l.roster.started(A, 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(lin.assign).not.toHaveBeenCalled()
  })

  test('a refused or failed assign logs one line and the session stays live', async () => {
    const refused = setup({ platform: 'win32', jobs: jobsFake(async () => false) })
    refused.roster.started(A, 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(refused.log.mock.calls).toEqual([['openaflow desktop: session aaaaaaaa has no job; quit ends it by taskkill only']])
    const failed = setup({ platform: 'win32', jobs: jobsFake(() => Promise.reject(new Error('helper gone'))) })
    failed.roster.started(A, 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(failed.log.mock.calls).toEqual([['openaflow desktop: session aaaaaaaa has no job; quit ends it by taskkill only']])
    expect(failed.roster.live().map((s) => s.id)).toEqual([A])
  })
})
