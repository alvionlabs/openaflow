import type { StartSpec } from '@openaflow/pty-host/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  BEAT_LOG_MS,
  createPtyHostStarter,
  FLUSH_WAIT_MS,
  MAX_RESTARTS,
  READY_LIMIT_MS,
  STOP_KILL_MS,
  UNRESPONSIVE_MS,
  type HostProcess,
  type StarterEvent,
} from './pty-host-starter.ts'

type FakeHost = HostProcess & {
  sent: { message: unknown; transfer: unknown[] | undefined }[]
  kills: number
  message(m: unknown): void
  exit(code?: number): void
  types(): string[]
}

function fakeHost(pid: number): FakeHost {
  let onMessage: (m: unknown) => void = () => {}
  let onExit: (code: number) => void = () => {}
  const h: FakeHost = {
    pid,
    sent: [],
    kills: 0,
    postMessage: (message, transfer) => void h.sent.push({ message, transfer }),
    kill: () => {
      h.kills++
      return true
    },
    onMessage: (fn) => void (onMessage = fn),
    onExit: (fn) => void (onExit = fn),
    message: (m) => onMessage(m),
    exit: (code = 1) => onExit(code),
    types: () => h.sent.map((s) => (s.message as { type: string }).type),
  }
  return h
}

function setup(o: { forkThrows?: number[] } = {}) {
  const hosts: FakeHost[] = []
  let forks = 0
  const fork = vi.fn(() => {
    forks++
    if (o.forkThrows?.includes(forks)) throw new Error('no fork')
    const h = fakeHost(100 + forks)
    hosts.push(h)
    return h
  })
  const log = vi.fn()
  const starter = createPtyHostStarter({ fork, log })
  const events: StarterEvent[] = []
  starter.onEvent((e) => events.push(e))
  const last = () => {
    expect(hosts.length).toBeGreaterThan(0)
    return hosts.at(-1)!
  }
  return { hosts, fork, log, starter, events, last }
}

const SPEC: StartSpec = { id: 'run-1', program: '/bin/sh', args: [], cwd: '/tmp', env: {}, cols: 80, rows: 24 }
const spec = (id: string): StartSpec => ({ ...SPEC, id })
const READY = { type: 'ready', version: 1 }
const settle = () => vi.advanceTimersByTimeAsync(0)
/** Records how a promise ends, so a test can check it without awaiting. */
const track = <T,>(p: Promise<T>) => {
  const out: { value?: T; error?: string; done: boolean } = { done: false }
  p.then(
    (value) => Object.assign(out, { value, done: true }),
    (err: unknown) => Object.assign(out, { error: err instanceof Error ? err.message : String(err), done: true }),
  )
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the pty host starter', () => {
  test('a start before ready waits for ready', async () => {
    const s = setup()
    // Before the fork too: the starter is made before the server is ready.
    const early = track(s.starter.startSession(spec('early')))
    s.starter.start()
    const h = s.last()
    const late = track(s.starter.startSession(spec('late')))
    await settle()
    expect(h.types()).toEqual([])

    h.message(READY)
    await settle()
    expect(h.sent.map((x) => x.message)).toEqual([
      { type: 'start', spec: spec('early') },
      { type: 'start', spec: spec('late') },
    ])
    h.message({ type: 'started', id: 'late', pid: 7 })
    h.message({ type: 'start-failed', id: 'early', error: 'no folder' })
    await settle()
    expect(late).toEqual({ done: true, value: { pid: 7 } })
    expect(early).toEqual({ done: true, error: 'no folder' })
    expect(s.events).toEqual([{ type: 'ready', restarted: false }])
    expect(s.starter.state()).toBe('ready')
    expect(s.starter.pid()).toBe(h.pid)
  })

  test('no ready in 20 s', async () => {
    const s = setup()
    s.starter.start()
    const first = s.last()
    const waiting = track(s.starter.startSession(SPEC))
    await vi.advanceTimersByTimeAsync(READY_LIMIT_MS - 1)
    expect(first.kills).toBe(0)
    expect(s.fork).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(first.kills).toBe(1)
    expect(s.fork).toHaveBeenCalledTimes(2)
    expect(s.events).toEqual([{ type: 'crashed', lost: [], restartsLeft: MAX_RESTARTS - 1 }])
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining('no ready in 20 s'))
    // The killed host's exit counts no second time.
    first.exit(1)
    expect(s.fork).toHaveBeenCalledTimes(2)
    expect(s.events).toHaveLength(1)

    // A start that waited for the first host goes to the next one.
    expect(waiting.done).toBe(false)
    s.last().message(READY)
    await settle()
    expect(s.last().sent.map((x) => x.message)).toEqual([{ type: 'start', spec: SPEC }])
    // No host was ready before, so no window holds a port: this is a first ready.
    expect(s.events.at(-1)).toEqual({ type: 'ready', restarted: false })
  })

  test('restarts, then failed', async () => {
    const s = setup()
    s.starter.start()
    for (let restart = 1; restart <= MAX_RESTARTS; restart++) {
      const h = s.last()
      h.message(READY)
      h.message({ type: 'started', id: `a${restart}`, pid: 10 })
      h.message({ type: 'started', id: `b${restart}`, pid: 11 })
      h.message({ type: 'exit', id: `b${restart}`, exitCode: 0 })
      const inFlight = track(s.starter.startSession(spec(`c${restart}`)))
      await settle()
      h.exit(1)
      await settle()
      expect(s.events.at(-1), `restart ${restart}`).toEqual({ type: 'crashed', lost: [`a${restart}`], restartsLeft: MAX_RESTARTS - restart })
      expect(inFlight, `restart ${restart}`).toEqual({ done: true, error: 'terminal host exited' })
      expect(s.starter.live()).toEqual([])
      expect(s.fork).toHaveBeenCalledTimes(restart + 1)
    }
    s.last().message(READY)
    expect(s.events.at(-1)).toEqual({ type: 'ready', restarted: true })
    s.last().message({ type: 'started', id: 'z', pid: 12 })
    const waiting = track(s.starter.snapshot('z'))
    await settle()

    s.last().exit(1)
    await settle()
    expect(s.fork).toHaveBeenCalledTimes(MAX_RESTARTS + 1)
    expect(s.events.slice(-2)).toEqual([{ type: 'crashed', lost: ['z'], restartsLeft: 0 }, { type: 'failed' }])
    expect(s.starter.state()).toBe('failed')
    expect(waiting).toEqual({ done: true, error: 'terminal host exited' })
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining('failed for good'))

    for (const p of [s.starter.startSession(SPEC), s.starter.snapshot('z'), s.starter.list(), s.starter.kill('z')]) {
      await expect(p).rejects.toThrow(/^terminals unavailable$/)
    }
    expect(s.starter.connect({})).toBe(false)
    // A start with no host left forks nothing.
    s.starter.start()
    expect(s.fork).toHaveBeenCalledTimes(MAX_RESTARTS + 1)
  })

  test('restarts never reset, and a fork that throws counts as a crash', async () => {
    const s = setup({ forkThrows: [2, 3] })
    s.starter.start()
    s.last().message(READY)
    // A long healthy run between crashes gives no restart back.
    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
      s.last().message({ type: 'beat' })
    }
    s.last().exit(1)
    // Forks 2 and 3 throw, fork 4 runs: three restarts used.
    expect(s.fork).toHaveBeenCalledTimes(4)
    expect(s.events.map((e) => (e.type === 'crashed' ? e.restartsLeft : e.type))).toEqual(['ready', 4, 3, 2])
    for (let i = 0; i < 3; i++) s.last().exit(1)
    expect(s.events.at(-1)).toEqual({ type: 'failed' })
    expect(s.fork).toHaveBeenCalledTimes(6)
  })

  test('a waiting start goes to the restarted host', async () => {
    const s = setup()
    s.starter.start()
    s.last().message(READY)
    s.last().exit(1)
    const waiting = track(s.starter.startSession(SPEC))
    await settle()
    const next = s.last()
    expect(next.types()).toEqual([])
    next.message(READY)
    await settle()
    expect(next.types()).toEqual(['start'])
    next.message({ type: 'started', id: SPEC.id, pid: 9 })
    await settle()
    expect(waiting).toEqual({ done: true, value: { pid: 9 } })
  })

  test('a host that ends during the wait for ready leaves its waiting starts to the next one; failed rejects them', async () => {
    const s = setup()
    const waiting = track(s.starter.startSession(SPEC))
    s.starter.start()
    for (let i = 0; i < MAX_RESTARTS; i++) s.last().exit(1)
    await settle()
    expect(waiting.done).toBe(false)
    s.last().exit(1)
    await settle()
    expect(waiting).toEqual({ done: true, error: 'terminals unavailable' })
  })

  test('heartbeat', async () => {
    const s = setup()
    s.starter.start()
    const h = s.last()
    // No beat is due before ready.
    await vi.advanceTimersByTimeAsync(READY_LIMIT_MS - 1)
    expect(s.events).toEqual([])
    h.message(READY)

    await vi.advanceTimersByTimeAsync(BEAT_LOG_MS - 1)
    expect(s.log).not.toHaveBeenCalledWith(expect.stringContaining('no beat'))
    await vi.advanceTimersByTimeAsync(1)
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: terminal host sent no beat for 6 s')
    expect(s.events.map((e) => e.type)).toEqual(['ready'])

    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_MS - BEAT_LOG_MS - 1)
    expect(s.starter.state()).toBe('ready')
    await vi.advanceTimersByTimeAsync(1)
    expect(s.events.map((e) => e.type)).toEqual(['ready', 'unresponsive'])
    expect(s.starter.state()).toBe('unresponsive')
    // Once per spell: a long silence gives no second one, and one log line.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.events.map((e) => e.type)).toEqual(['ready', 'unresponsive'])
    expect(s.log.mock.calls.filter(([l]) => String(l).includes('no beat'))).toHaveLength(1)
    // Unresponsive is only a report: the host is not killed, and requests still go out.
    expect(h.kills).toBe(0)
    void s.starter.snapshot('x')
    await settle()
    expect(h.types()).toEqual(['snapshot'])

    h.message({ type: 'beat' })
    expect(s.events.map((e) => e.type)).toEqual(['ready', 'unresponsive', 'responsive'])
    expect(s.starter.state()).toBe('ready')
    // A beat starts the clock again; regular beats keep it quiet.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
      h.message({ type: 'beat' })
    }
    expect(s.events.map((e) => e.type)).toEqual(['ready', 'unresponsive', 'responsive'])
    // The next spell gets its own log line and its own unresponsive.
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_MS)
    expect(s.events.map((e) => e.type)).toEqual(['ready', 'unresponsive', 'responsive', 'unresponsive'])
    expect(s.log.mock.calls.filter(([l]) => String(l).includes('no beat'))).toHaveLength(2)
  })

  test('stop', async () => {
    const s = setup()
    s.starter.start()
    const h = s.last()
    h.message(READY)
    h.message({ type: 'started', id: 'a', pid: 5 })
    const inFlight = track(s.starter.list())
    await settle()

    const stopped = track(s.starter.stop())
    // A second stop is the same stop.
    const again = track(s.starter.stop())
    expect(h.types()).toEqual(['list', 'shutdown'])
    await settle()
    expect(inFlight).toEqual({ done: true, error: 'terminals unavailable' })
    await vi.advanceTimersByTimeAsync(STOP_KILL_MS - 1)
    expect(h.kills).toBe(0)
    expect(stopped.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.kills).toBe(1)
    expect(stopped).toEqual({ done: true, value: 'killed' })
    expect(again).toEqual({ done: true, value: 'killed' })

    // The exit after the kill restarts nothing, and nothing reads as unresponsive later.
    h.exit(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.fork).toHaveBeenCalledTimes(1)
    expect(s.events.map((e) => e.type)).toEqual(['ready'])
    expect(s.starter.state()).toBe('stopped')
    await expect(s.starter.startSession(SPEC)).rejects.toThrow(/^terminals unavailable$/)

    // Messages during the shutdown change nothing: a beat re-arms no clock, and a late ready reports nothing.
    const w = setup()
    w.starter.start()
    w.last().message(READY)
    void w.starter.stop()
    w.last().message({ type: 'beat' })
    w.last().message({ type: 'started', id: 'late', pid: 3 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.starter.state()).toBe('stopped')
    expect(w.starter.live()).toEqual([])
    expect(w.events.map((e) => e.type)).toEqual(['ready'])
    const x = setup()
    x.starter.start()
    void x.starter.stop()
    x.last().message(READY)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(x.starter.state()).toBe('stopped')
    expect(x.events).toEqual([])

    // A host that exits on its own within 3 s is stopped, not killed.
    const t = setup()
    t.starter.start()
    t.last().message(READY)
    const done = track(t.starter.stop())
    t.last().exit(0)
    await settle()
    expect(done).toEqual({ done: true, value: 'stopped' })
    expect(t.last().kills).toBe(0)
    await vi.advanceTimersByTimeAsync(STOP_KILL_MS)
    expect(t.last().kills).toBe(0)
    expect(t.fork).toHaveBeenCalledTimes(1)

    // A stop before ready still sends shutdown; a stop before the fork forks nothing later.
    const u = setup()
    u.starter.start()
    void u.starter.stop()
    expect(u.last().types()).toEqual(['shutdown'])
    await vi.advanceTimersByTimeAsync(READY_LIMIT_MS)
    expect(u.fork).toHaveBeenCalledTimes(1)
    const v = setup()
    await expect(v.starter.stop()).resolves.toBe('not running')
    v.starter.start()
    expect(v.fork).not.toHaveBeenCalled()
  })

  test('exits', async () => {
    const s = setup()
    s.starter.start()
    const h = s.last()
    h.message(READY)
    h.message({ type: 'started', id: 'a', pid: 5 })
    h.message({ type: 'started', id: 'b', pid: 6 })
    expect(s.starter.live()).toEqual(['a', 'b'])
    h.message({ type: 'exit', id: 'a', exitCode: 0 })
    expect(s.starter.live()).toEqual(['b'])
    // An exit for an id that is not live changes nothing.
    h.message({ type: 'exit', id: 'zz', exitCode: 0 })
    expect(s.starter.live()).toEqual(['b'])
    // A failed start never enters the set.
    h.message({ type: 'start-failed', id: 'c', error: 'bad id' })
    expect(s.starter.live()).toEqual(['b'])
    h.exit(1)
    expect(s.events.at(-1)).toEqual({ type: 'crashed', lost: ['b'], restartsLeft: MAX_RESTARTS - 1 })
  })

  test('dispose and exit events', async () => {
    const s = setup()
    s.starter.start()
    const h = s.last()
    // Before ready no host holds a session, so a dispose sends nothing.
    s.starter.dispose('a')
    expect(h.sent).toEqual([])
    h.message(READY)
    h.message({ type: 'started', id: 'a', pid: 5 })
    h.message({ type: 'started', id: 'b', pid: 6 })
    h.message({ type: 'started', id: 'c', pid: 7 })
    const exits = () => s.events.filter((e) => e.type === 'exit')

    h.message({ type: 'exit', id: 'a', exitCode: 3, signal: 9 })
    h.message({ type: 'exit', id: 'a', exitCode: 3 })
    // Not live, or not a number: no event.
    h.message({ type: 'exit', id: 'zz', exitCode: 0 })
    h.message({ type: 'exit', id: 'b', exitCode: 'x' })
    expect(exits()).toEqual([{ type: 'exit', id: 'a', exitCode: 3 }])
    expect(s.starter.live()).toEqual(['b', 'c'])

    // The host sends no exit for a disposed live session, so it leaves the live set here, with no event.
    s.starter.dispose('b')
    expect(h.sent.at(-1)).toEqual({ message: { type: 'dispose', id: 'b' }, transfer: undefined })
    expect(s.starter.live()).toEqual(['c'])
    h.message({ type: 'exit', id: 'b', exitCode: 0 })
    expect(exits()).toHaveLength(1)
    h.exit(1)
    expect(s.events.at(-1)).toEqual({ type: 'crashed', lost: ['c'], restartsLeft: MAX_RESTARTS - 1 })
    // The old host's late exit is not the new host's.
    h.message({ type: 'exit', id: 'c', exitCode: 0 })
    expect(exits()).toHaveLength(1)

    const next = s.last()
    next.message(READY)
    next.message({ type: 'started', id: 'c', pid: 8 })
    next.message({ type: 'exit', id: 'c', exitCode: 0 })
    expect(exits()).toEqual([
      { type: 'exit', id: 'a', exitCode: 3 },
      { type: 'exit', id: 'c', exitCode: 0 },
    ])

    // A stopped starter has no host: a dispose sends nothing and never throws.
    void s.starter.stop()
    const sent = next.sent.length
    s.starter.dispose('c')
    expect(next.sent).toHaveLength(sent)
  })

  test('list, kill, snapshot, and connect', async () => {
    const s = setup()
    s.starter.start()
    const h = s.last()
    expect(s.starter.connect('port')).toBe(false)
    h.message(READY)
    const listed = track(s.starter.list())
    const second = track(s.starter.list())
    const shot = track(s.starter.snapshot('a'))
    const killed = track(s.starter.kill('a'))
    await settle()
    expect(h.sent.map((x) => x.message)).toEqual([{ type: 'list' }, { type: 'list' }, { type: 'snapshot', id: 'a' }, { type: 'kill', id: 'a' }])
    expect(killed).toEqual({ done: true, value: undefined })
    // A session still waiting for its pid is listed with pid 0.
    const sessions = [{ id: 'a', pid: 0, live: true, startedAt: 1 }]
    h.message({ type: 'list', sessions })
    h.message({ type: 'list', sessions: [] })
    h.message({ type: 'snapshot', id: 'a', text: 'hi' })
    await settle()
    expect(listed).toEqual({ done: true, value: sessions })
    expect(second).toEqual({ done: true, value: [] })
    expect(shot).toEqual({ done: true, value: 'hi' })

    expect(s.starter.connect('port')).toBe(true)
    expect(h.sent.at(-1)).toEqual({ message: { type: 'connect' }, transfer: ['port'] })
    // Odd messages are ignored, never thrown.
    for (const odd of [undefined, null, 7, 'ready', {}, { type: 'started' }, { type: 'list', sessions: 'x' }, { type: 'exit' }]) {
      expect(() => h.message(odd)).not.toThrow()
    }
  })

  test('log lines', async () => {
    const s = setup()
    s.starter.start()
    s.last().message(READY)
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: terminal host ready')
    s.last().message({ type: 'load-failed', error: 'no binary' })
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: terminal host could not load node-pty: no binary')
    s.last().message({ type: 'started', id: 'a1', pid: 5 })
    s.last().message({ type: 'started', id: 'b2', pid: 6 })
    s.last().exit(3)
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: terminal host exited with code 3')
    // The lost ids reach desktop.log, not only the event.
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: terminal host lost sessions: a1, b2')
    s.last().exit(1)
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: terminal host lost sessions: none')
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining('restarting (4 restarts left)'))
    for (let i = 0; i < 2; i++) s.last().exit(1)
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: terminal host restarting (1 restart left)')
  })

  test('flush', async () => {
    const s = setup()
    // No host yet: nothing to save, so it resolves at once and sends nothing.
    const early = track(s.starter.flush())
    await settle()
    expect(early).toEqual({ done: true, value: undefined })
    s.starter.start()
    const h = s.last()
    const unready = track(s.starter.flush())
    await settle()
    expect(unready.done).toBe(true)
    expect(h.types()).toEqual([])

    // A ready host: one `flush` per call; `flushed` resolves every flush that waits.
    h.message(READY)
    const a = track(s.starter.flush())
    const b = track(s.starter.flush())
    await settle()
    expect(h.types()).toEqual(['flush', 'flush'])
    expect(a.done).toBe(false)
    h.message({ type: 'flushed' })
    await settle()
    expect(a).toEqual({ done: true, value: undefined })
    expect(b).toEqual({ done: true, value: undefined })

    // No answer: it resolves at 2 s, not before.
    const slow = track(s.starter.flush())
    await vi.advanceTimersByTimeAsync(FLUSH_WAIT_MS - 1)
    expect(slow.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(slow).toEqual({ done: true, value: undefined })
    // A late `flushed` finds no one waiting.
    expect(() => h.message({ type: 'flushed' })).not.toThrow()

    // A crash during the flush resolves it at once.
    const crashed = track(s.starter.flush())
    await settle()
    h.exit(1)
    await settle()
    expect(crashed.done).toBe(true)

    // A stop resolves a waiting flush, and a flush after the stop sends nothing.
    const t = setup()
    t.starter.start()
    t.last().message(READY)
    const waiting = track(t.starter.flush())
    void t.starter.stop()
    await settle()
    expect(waiting.done).toBe(true)
    const after = track(t.starter.flush())
    await settle()
    expect(after.done).toBe(true)
    expect(t.last().types()).toEqual(['flush', 'shutdown'])
    expect(FLUSH_WAIT_MS).toBe(2_000)
  })

  test('held ids: live, and starts that wait for their pid', async () => {
    const s = setup()
    s.starter.start()
    const h = s.last()
    void s.starter.startSession(spec('a')).catch(() => {})
    // Before ready the start waits in main: no host holds it yet, but main does.
    expect(s.starter.held()).toEqual(['a'])
    h.message(READY)
    void s.starter.startSession(spec('b')).catch(() => {})
    await settle()
    expect(s.starter.held().sort()).toEqual(['a', 'b'])
    h.message({ type: 'started', id: 'a', pid: 7 })
    h.message({ type: 'start-failed', id: 'b', error: 'no folder' })
    await settle()
    expect(s.starter.held()).toEqual(['a'])
    h.message({ type: 'exit', id: 'a', exitCode: 0 })
    expect(s.starter.held()).toEqual([])
  })
})
