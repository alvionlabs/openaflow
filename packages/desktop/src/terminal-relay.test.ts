import type { StartSpec } from '@openaflow/pty-host/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createPtyHostStarter, MAX_RESTARTS, type HostProcess } from './pty-host-starter.ts'
import { createSessionRoster } from './session-roster.ts'
import { startTerminalRelay, TERMINAL_MESSAGE } from './terminal-relay.ts'

// The real starter and the real roster run here, with a fake host process and a fake ender: the words `terminal host
// exited` and `terminals unavailable` are the starter's, and the roster decides who is ended or swept.

type FakeHost = HostProcess & { sent: unknown[]; message(m: unknown): void; exit(code?: number): void }

function fakeHost(pid: number): FakeHost {
  let onMessage: (m: unknown) => void = () => {}
  let onExit: (code: number) => void = () => {}
  const h: FakeHost = {
    pid,
    sent: [],
    postMessage: (m) => void h.sent.push(m),
    kill: () => true,
    onMessage: (fn) => void (onMessage = fn),
    onExit: (fn) => void (onExit = fn),
    message: (m) => onMessage(m),
    exit: (code = 1) => onExit(code),
  }
  return h
}

function setup() {
  const hosts: FakeHost[] = []
  const starter = createPtyHostStarter({
    fork: () => {
      const h = fakeHost(100 + hosts.length)
      hosts.push(h)
      return h
    },
    log: () => {},
  })
  const listeners = new Set<(m: unknown, reply: (m: unknown) => void) => void>()
  /** What reached the server: `reply` answers the message that asked, `send` goes to the current process. */
  const out: { via: 'reply' | 'send'; m: unknown }[] = []
  const server = {
    send: (m: unknown) => void out.push({ via: 'send', m }),
    onMessage(fn: (m: unknown, reply: (m: unknown) => void) => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
  }
  const log = vi.fn()
  /** What the roster asked the ender to do. */
  const ender = { end: vi.fn(async (_id: string, _pid: number, _stop?: string[]) => {}), sweep: vi.fn(async (_id: string, _stop?: string[]) => {}) }
  const roster = createSessionRoster({ platform: 'linux', ender, flush: () => starter.flush(), log: () => {} })
  const relay = startTerminalRelay({ server, starter, roster, log })
  const stop = () => relay.stop()
  const ask = (op: Record<string, unknown>) => {
    for (const fn of [...listeners]) fn({ type: TERMINAL_MESSAGE, ...op }, (m) => out.push({ via: 'reply', m }))
  }
  const host = () => {
    expect(hosts.length).toBeGreaterThan(0)
    return hosts.at(-1)!
  }
  const ready = () => host().message({ type: 'ready', version: 1 })
  const posted = () => host().sent as { type: string }[]
  return { starter, out, log, stop, relay, roster, ender, ask, host, ready, posted, listeners }
}

const SPEC: StartSpec = { id: 'run-a', program: '/bin/sh', args: ['/pod:plan secret words'], cwd: '/tmp', env: {}, cols: 120, rows: 30, screenFile: '/tmp/cfg/screens/run-a.txt' }
const STOP = ['/usr/bin/systemctl', '--user', 'stop', 'openaflow-run-secret.scope']
const BAD_LINE = /^openaflow desktop: terminal link ignored a bad message/
const spec = (id: string): StartSpec => ({ ...SPEC, id })
const T = TERMINAL_MESSAGE
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the terminal relay', () => {
  test('start answers once', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    s.ask({ op: 'start', req: 1, spec: spec('run-a'), stop: STOP })
    s.ask({ op: 'start', req: 2, spec: spec('run-b') })
    await settle()
    // The spec reaches the host unchanged, screenFile included, and the stop stays in main.
    expect(s.posted()).toEqual([
      { type: 'start', spec: spec('run-a') },
      { type: 'start', spec: spec('run-b') },
    ])
    expect((s.posted()[0] as unknown as { spec: StartSpec }).spec.screenFile).toBe('/tmp/cfg/screens/run-a.txt')
    s.host().message({ type: 'started', id: 'run-a', pid: 4242 })
    s.host().message({ type: 'start-failed', id: 'run-b', error: 'no folder' })
    // A repeat from the host finds no one waiting.
    s.host().message({ type: 'started', id: 'run-a', pid: 4242 })
    await settle()
    expect(s.out).toEqual([
      { via: 'reply', m: { type: T, op: 'started', req: 1, id: 'run-a', pid: 4242 } },
      { via: 'reply', m: { type: T, op: 'start-failed', req: 2, id: 'run-b', error: 'no folder' } },
    ])
  })

  test('start timing', async () => {
    const s = setup()
    // Before the fork: the server is ready before the host is.
    s.ask({ op: 'start', req: 1, spec: spec('run-a') })
    s.starter.start()
    await settle()
    expect(s.posted()).toEqual([])
    s.ready()
    await settle()
    expect(s.posted()).toEqual([{ type: 'start', spec: spec('run-a') }])
    s.host().message({ type: 'started', id: 'run-a', pid: 7 })
    await settle()
    expect(s.out).toEqual([{ via: 'reply', m: { type: T, op: 'started', req: 1, id: 'run-a', pid: 7 } }])

    // Every restart used, then the last host ends: failed.
    for (let i = 0; i <= MAX_RESTARTS; i++) s.host().exit(1)
    expect(s.starter.state()).toBe('failed')
    s.out.length = 0
    s.ask({ op: 'start', req: 2, spec: spec('run-b') })
    s.ask({ op: 'list', req: 3 })
    await settle()
    expect(s.out).toEqual([
      { via: 'reply', m: { type: T, op: 'start-failed', req: 2, id: 'run-b', error: 'terminals unavailable' } },
      { via: 'reply', m: { type: T, op: 'list-failed', req: 3, error: 'terminals unavailable' } },
    ])
  })

  test('host crash', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    s.ask({ op: 'start', req: 1, spec: spec('run-a') })
    s.ask({ op: 'start', req: 2, spec: spec('run-b') })
    s.ask({ op: 'start', req: 3, spec: spec('run-c') })
    await settle()
    s.host().message({ type: 'started', id: 'run-a', pid: 5 })
    s.host().message({ type: 'started', id: 'run-b', pid: 6 })
    await settle()
    s.out.length = 0
    // run-c waits for its pid when the host dies.
    s.host().exit(1)
    await settle()
    expect(s.out).toEqual([
      { via: 'send', m: { type: T, op: 'lost', ids: ['run-a', 'run-b'] } },
      { via: 'reply', m: { type: T, op: 'start-failed', req: 3, id: 'run-c', error: 'terminal host exited' } },
    ])
    // Each crash sends lost, with no live id too.
    s.out.length = 0
    s.host().exit(1)
    await settle()
    expect(s.out).toEqual([{ via: 'send', m: { type: T, op: 'lost', ids: [] } }])
  })

  test('list and dispose', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    s.ask({ op: 'list', req: 4 })
    await settle()
    const sessions = [{ id: 'run-a', pid: 5, live: true, startedAt: 1 }]
    s.host().message({ type: 'list', sessions })
    await settle()
    expect(s.out).toEqual([{ via: 'reply', m: { type: T, op: 'list', req: 4, sessions } }])

    s.host().message({ type: 'started', id: 'run-a', pid: 5 })
    s.ask({ op: 'dispose', id: 'run-a' })
    expect(s.posted().at(-1)).toEqual({ type: 'dispose', id: 'run-a' })
    // A disposed live session is not lost in a later crash: the host ended it.
    s.out.length = 0
    s.host().exit(1)
    expect(s.out).toEqual([{ via: 'send', m: { type: T, op: 'lost', ids: [] } }])
  })

  test('exit once', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    s.ask({ op: 'start', req: 1, spec: spec('run-a') })
    await settle()
    // A program that ends at once: started and exit in the same tick. The server still hears started first.
    s.host().message({ type: 'started', id: 'run-a', pid: 5 })
    s.host().message({ type: 'exit', id: 'run-a', exitCode: 2 })
    s.host().message({ type: 'exit', id: 'run-a', exitCode: 2 })
    await settle()
    expect(s.out).toEqual([
      { via: 'reply', m: { type: T, op: 'started', req: 1, id: 'run-a', pid: 5 } },
      { via: 'send', m: { type: T, op: 'exit', id: 'run-a', exitCode: 2 } },
    ])

    s.ask({ op: 'start', req: 2, spec: spec('run-b') })
    await settle()
    s.host().message({ type: 'started', id: 'run-b', pid: 6 })
    await settle()
    s.host().message({ type: 'exit', id: 'run-b', exitCode: 0 })
    s.host().message({ type: 'exit', id: 'run-b', exitCode: 0 })
    await settle()
    expect(s.out.slice(2)).toEqual([
      { via: 'reply', m: { type: T, op: 'started', req: 2, id: 'run-b', pid: 6 } },
      { via: 'send', m: { type: T, op: 'exit', id: 'run-b', exitCode: 0 } },
    ])
  })

  test('bad messages', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    // Not the terminal type: the server's ready and anything else pass with no line.
    for (const other of [undefined, null, 7, 'start', [], {}, { type: 'openaflow:ready', port: 3110 }, { type: 'other', op: 'start' }]) {
      for (const fn of [...s.listeners]) fn(other, () => s.out.push({ via: 'reply', m: 'answered' }))
    }
    expect(s.log).not.toHaveBeenCalled()

    const bad: Record<string, unknown>[] = [
      { op: 'kill', id: 'run-a' },
      { op: 'shutdown' },
      { op: 'connect' },
      {},
      { op: 7 },
      { op: 'start', spec: spec('run-a') },
      { op: 'start', req: 0, spec: spec('run-a') },
      { op: 'start', req: 1.5, spec: spec('run-a') },
      { op: 'start', req: '1', spec: spec('run-a') },
      { op: 'start', req: 1 },
      { op: 'start', req: 1, spec: 'run-a' },
      { op: 'start', req: 1, spec: { ...SPEC, id: 3 } },
      { op: 'list' },
      { op: 'list', req: -1 },
      { op: 'dispose' },
      { op: 'dispose', id: 5 },
    ]
    for (const m of bad) {
      s.log.mockClear()
      s.ask(m)
      expect(s.log, JSON.stringify(m)).toHaveBeenCalledOnce()
      expect(s.log.mock.calls[0]![0]).toMatch(/^openaflow desktop: terminal link ignored a bad message/)
      // The line never holds the message: a start's args carry the user's text.
      expect(s.log.mock.calls[0]![0]).not.toContain('secret')
    }
    await settle()
    expect(s.posted()).toEqual([])
    expect(s.out).toEqual([])
    expect(s.starter.live()).toEqual([])
  })

  test('a stopped starter answers nothing', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    s.ask({ op: 'start', req: 1, spec: spec('run-a') })
    s.ask({ op: 'list', req: 2 })
    await settle()
    // The quit: the server stops too. A refusal now would read as a host failure.
    void s.starter.stop()
    s.ask({ op: 'start', req: 3, spec: spec('run-b') })
    s.ask({ op: 'list', req: 4 })
    s.ask({ op: 'dispose', id: 'run-a' })
    await settle()
    expect(s.out).toEqual([])
  })

  test('stop ends the relay', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    s.stop()
    s.ask({ op: 'list', req: 1 })
    s.host().exit(1)
    await settle()
    expect(s.posted()).toEqual([])
    expect(s.out).toEqual([])
  })

  test('start stop argv', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    s.ask({ op: 'start', req: 1, spec: spec('run-a'), stop: STOP })
    s.ask({ op: 'start', req: 2, spec: spec('run-b') })
    await settle()
    // Waiting for their pids: in the roster, with the stop, and the quit asks about them.
    expect(s.roster.sessions()).toEqual([
      { id: 'run-a', pid: 0, stop: STOP, state: 'starting' },
      { id: 'run-b', pid: 0, state: 'starting' },
    ])
    s.host().message({ type: 'started', id: 'run-a', pid: 41 })
    s.host().message({ type: 'start-failed', id: 'run-b', error: 'no folder' })
    await settle()
    expect(s.roster.sessions()).toEqual([
      { id: 'run-a', pid: 41, stop: STOP, state: 'live' },
      { id: 'run-b', pid: 0, state: 'ended' },
    ])
    s.host().message({ type: 'exit', id: 'run-a', exitCode: 0 })
    await settle()
    expect(s.roster.live()).toEqual([])
    expect(s.log).not.toHaveBeenCalled()

    // A bad stop: the start goes on with no stop, and one line that never holds the argv.
    const long = `/${'x'.repeat(1_024)}`
    const bad: unknown[] = [[], 'x', [STOP[0], 3], ['usr/bin/systemctl', 'stop'], [''], Array.from({ length: 33 }, () => '/bin/true'), [long], ['/bin/true', long], { 0: '/bin/true' }, null]
    let req = 10
    for (const stop of bad) {
      const id = `run-bad-${req}`
      s.log.mockClear()
      s.ask({ op: 'start', req, spec: spec(id), stop })
      await settle()
      expect(s.log, JSON.stringify(stop)).toHaveBeenCalledOnce()
      expect(s.log.mock.calls[0]![0]).toMatch(/^openaflow desktop: terminal link dropped a bad stop/)
      expect(s.log.mock.calls[0]![0]).not.toContain('systemctl')
      expect(s.posted().at(-1)).toEqual({ type: 'start', spec: spec(id) })
      expect(s.roster.sessions().find((x) => x.id === id)).toEqual({ id, pid: 0, state: 'starting' })
      req++
    }
    // 32 strings of 1,024 characters is the most.
    s.log.mockClear()
    const most = ['/bin/true', ...Array.from({ length: 31 }, () => 'y'.repeat(1_024))]
    s.ask({ op: 'start', req: 99, spec: spec('run-most'), stop: most })
    await settle()
    expect(s.log).not.toHaveBeenCalled()
    expect(s.roster.sessions().find((x) => x.id === 'run-most')?.stop).toEqual(most)
  })

  test('sweeps', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    s.ask({ op: 'start', req: 1, spec: spec('run-live'), stop: STOP })
    s.ask({ op: 'start', req: 2, spec: spec('run-wait') })
    await settle()
    s.host().message({ type: 'started', id: 'run-live', pid: 5 })
    // A start main holds that never went through the relay (the test hook's).
    void s.starter.startSession(spec('run-hook')).catch(() => {})
    await settle()
    s.host().message({ type: 'started', id: 'run-hook', pid: 6 })
    await settle()

    s.ask({
      op: 'sweep',
      sessions: [{ id: 'run-old', stop: STOP }, { id: 'run-live' }, { id: 'run-wait' }, { id: 'run-hook' }, { id: 'run-other' }],
    })
    await settle()
    expect(s.ender.sweep.mock.calls).toEqual([
      ['run-old', STOP],
      ['run-other', undefined],
    ])
    expect(s.ender.end).not.toHaveBeenCalled()
    // A repeat sweeps nothing twice.
    s.ask({ op: 'sweep', sessions: [{ id: 'run-old' }] })
    await settle()
    expect(s.ender.sweep).toHaveBeenCalledTimes(2)

    // A host crash: the lost live ids are swept, once, with their stop; the server hears lost.
    s.out.length = 0
    s.host().exit(1)
    await settle()
    expect(s.out).toContainEqual({ via: 'send', m: { type: T, op: 'lost', ids: ['run-live', 'run-hook'] } })
    expect(s.ender.sweep.mock.calls.slice(2)).toEqual([
      ['run-live', STOP],
      ['run-hook', undefined],
    ])

    // Bad shapes: one line each, and nothing is swept.
    const bad: Record<string, unknown>[] = [
      { op: 'sweep' },
      { op: 'sweep', sessions: 'run-x' },
      { op: 'sweep', sessions: [null] },
      { op: 'sweep', sessions: [{}] },
      { op: 'sweep', sessions: [{ id: 5 }] },
      { op: 'sweep', sessions: [{ id: '../secret' }] },
      { op: 'sweep', sessions: [{ id: 'run-x' }, { id: 'RUN-Y' }] },
      { op: 'sweep', sessions: [{ id: 'run-x', stop: ['secret/rel'] }] },
      { op: 'sweep', sessions: [{ id: 'run-x', stop: 'secret' }] },
    ]
    for (const m of bad) {
      s.log.mockClear()
      s.ask(m)
      await settle()
      expect(s.log, JSON.stringify(m)).toHaveBeenCalledOnce()
      expect(s.log.mock.calls[0]![0]).toMatch(BAD_LINE)
      expect(s.log.mock.calls[0]![0]).not.toContain('secret')
    }
    expect(s.ender.sweep).toHaveBeenCalledTimes(4)
    // An empty list sweeps nothing and logs nothing.
    s.log.mockClear()
    s.ask({ op: 'sweep', sessions: [] })
    await settle()
    expect(s.log).not.toHaveBeenCalled()
    expect(s.ender.sweep).toHaveBeenCalledTimes(4)
  })

  test('labels', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    s.ask({ op: 'start', req: 1, spec: spec('run-a') })
    await settle()
    s.host().message({ type: 'started', id: 'run-a', pid: 5 })
    await settle()
    s.ask({ op: 'labels', labels: [{ id: 'run-a', label: 'alpha-repo · alpha' }] })
    expect(s.roster.live()).toEqual([{ id: 'run-a', pid: 5, state: 'live', label: 'alpha-repo · alpha' }])

    // The newest list replaces the last: cut to 120 characters, control characters dropped, at most 100.
    const many = Array.from({ length: 101 }, (_, i) => ({ id: `run-${i}`, label: `repo ${i}` }))
    many[0] = { id: 'run-a', label: `a\u0007b\u001b[31m\u009bc\u007f${'d'.repeat(200)}` }
    s.ask({ op: 'labels', labels: many })
    const label = s.roster.live()[0]!.label!
    expect(label).toBe(`ab[31mc${'d'.repeat(113)}`)
    expect(label).toHaveLength(120)
    s.ask({ op: 'start', req: 2, spec: spec('run-99') })
    s.ask({ op: 'start', req: 3, spec: spec('run-100') })
    await settle()
    expect(s.roster.live().map((x) => [x.id, x.label])).toEqual([
      ['run-a', label],
      ['run-99', 'repo 99'],
      ['run-100', undefined],
    ])

    // Bad shapes: one line each, and the last list stays.
    for (const m of [{ op: 'labels' }, { op: 'labels', labels: {} }, { op: 'labels', labels: [{ id: 'run-a' }] }, { op: 'labels', labels: [{ id: 3, label: 'secret' }] }]) {
      s.log.mockClear()
      s.ask(m)
      expect(s.log, JSON.stringify(m)).toHaveBeenCalledOnce()
      expect(s.log.mock.calls[0]![0]).toMatch(BAD_LINE)
      expect(s.log.mock.calls[0]![0]).not.toContain('secret')
    }
    expect(s.roster.live()[0]!.label).toBe(label)

    // The server goes (its listeners with it): the quit still reads the last list.
    s.listeners.clear()
    s.stop()
    expect(s.roster.live()[0]!.label).toBe(label)
    // An empty list clears them.
    const t = setup()
    t.ask({ op: 'labels', labels: [] })
    expect(t.log).not.toHaveBeenCalled()
  })

  test('silent after the quit', async () => {
    const s = setup()
    s.starter.start()
    s.ready()
    s.ask({ op: 'start', req: 1, spec: spec('run-a') })
    s.ask({ op: 'start', req: 2, spec: spec('run-b') })
    s.ask({ op: 'start', req: 3, spec: spec('run-c') })
    await settle()
    s.host().message({ type: 'started', id: 'run-a', pid: 5 })
    s.host().message({ type: 'started', id: 'run-b', pid: 6 })
    await settle()
    s.out.length = 0

    s.relay.silence()
    // The answer to a start in flight still goes: the server waits on it.
    s.host().message({ type: 'started', id: 'run-c', pid: 7 })
    s.host().message({ type: 'exit', id: 'run-a', exitCode: 129 })
    await settle()
    s.host().exit(1)
    await settle()
    expect(s.out).toEqual([{ via: 'reply', m: { type: T, op: 'started', req: 3, id: 'run-c', pid: 7 } }])
    // The roster still hears all of it.
    expect(s.roster.sessions().map((x) => [x.id, x.state])).toEqual([
      ['run-a', 'ended'],
      ['run-b', 'ended'],
      ['run-c', 'ended'],
    ])
    expect(s.ender.sweep.mock.calls.map((c) => c[0])).toEqual(['run-b', 'run-c'])
    // An exit held for its started stays held back too.
    const t = setup()
    t.starter.start()
    t.ready()
    t.ask({ op: 'start', req: 1, spec: spec('run-a') })
    await settle()
    t.relay.silence()
    t.host().message({ type: 'started', id: 'run-a', pid: 5 })
    t.host().message({ type: 'exit', id: 'run-a', exitCode: 0 })
    await settle()
    expect(t.out).toEqual([{ via: 'reply', m: { type: T, op: 'started', req: 1, id: 'run-a', pid: 5 } }])
    // The roster hears that exit after the start, so the session isn't left live.
    expect(t.roster.live()).toEqual([])
    expect(t.roster.sessions()).toEqual([{ id: 'run-a', pid: 5, state: 'ended' }])
  })
})
