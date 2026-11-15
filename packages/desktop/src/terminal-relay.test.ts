import type { StartSpec } from '@openaflow/pty-host/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createPtyHostStarter, MAX_RESTARTS, type HostProcess } from './pty-host-starter.ts'
import { startTerminalRelay, TERMINAL_MESSAGE } from './terminal-relay.ts'

// The real starter runs here, with a fake host process: the words `terminal host exited` and `terminals unavailable`
// are the starter's.

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
  const stop = startTerminalRelay({ server, starter, log })
  const ask = (op: Record<string, unknown>) => {
    for (const fn of [...listeners]) fn({ type: TERMINAL_MESSAGE, ...op }, (m) => out.push({ via: 'reply', m }))
  }
  const host = () => {
    expect(hosts.length).toBeGreaterThan(0)
    return hosts.at(-1)!
  }
  const ready = () => host().message({ type: 'ready', version: 1 })
  const posted = () => host().sent as { type: string }[]
  return { starter, out, log, stop, ask, host, ready, posted, listeners }
}

const SPEC: StartSpec = { id: 'run-a', program: '/bin/sh', args: ['/pod:plan secret words'], cwd: '/tmp', env: {}, cols: 120, rows: 30 }
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
    s.ask({ op: 'start', req: 1, spec: spec('run-a') })
    s.ask({ op: 'start', req: 2, spec: spec('run-b') })
    await settle()
    expect(s.posted()).toEqual([
      { type: 'start', spec: spec('run-a') },
      { type: 'start', spec: spec('run-b') },
    ])
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
})
