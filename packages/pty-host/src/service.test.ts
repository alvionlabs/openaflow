import { isAbsolute } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { HostToMain, HostToWindow, StartSpec } from './protocol.ts'
import { startPtyHost, type PtyModule, type PtyProcess, type PtySpawnOptions } from './service.ts'
import type { WindowPort } from './session.ts'

type FakePty = PtyProcess & {
  file: string
  args: string[]
  options: PtySpawnOptions
  emit(data: string): void
  end(exitCode: number, signal?: number): void
  /** With `latePid`: the process starts now, as ConPTY's does after its output pipe connects. */
  connect(): void
  killed: string[]
  written: string[]
}

const DIR = isAbsolute('/work') ? '/work' : 'C:\\work'
const PROGRAM = isAbsolute('/bin/sh') ? '/bin/sh' : 'C:\\Windows\\System32\\cmd.exe'

/** `killThrowsBeforePid`: the kill throws until the pid shows, as a pty that can't take a kill yet. */
function fakePtyModule(o: { exitOnKill?: boolean; spawnError?: string; latePid?: boolean; killThrowsBeforePid?: boolean } = {}) {
  const spawned: FakePty[] = []
  let nextPid = 100
  const mod: PtyModule = {
    spawn(file, args, options) {
      if (o.spawnError !== undefined) throw new Error(o.spawnError)
      const data: ((d: string) => void)[] = []
      const exits: ((e: { exitCode: number; signal?: number }) => void)[] = []
      const pid = nextPid++
      let connected = o.latePid !== true
      const pty: FakePty = {
        get pid() {
          return connected ? pid : 0
        },
        connect: () => {
          connected = true
        },
        file,
        args,
        options,
        killed: [],
        written: [],
        write: (d) => void pty.written.push(d),
        resize: () => {},
        pause: () => {},
        resume: () => {},
        onData: (fn) => {
          data.push(fn)
          return { dispose() {} }
        },
        onExit: (fn) => {
          exits.push(fn)
          return { dispose() {} }
        },
        kill(signal) {
          if (o.killThrowsBeforePid === true && !connected) throw new Error('the pty is not ready')
          pty.killed.push(signal ?? 'default')
          if (o.exitOnKill !== false) queueMicrotask(() => pty.end(0, 1))
        },
        emit: (d) => data.forEach((fn) => fn(d)),
        end: (exitCode, signal) => exits.forEach((fn) => fn(signal === undefined ? { exitCode } : { exitCode, signal })),
      }
      spawned.push(pty)
      return pty
    },
  }
  return { mod, spawned }
}

function host(o: { pty?: ReturnType<typeof fakePtyModule>; load?: () => PtyModule; dirs?: string[]; shutdownWaitMs?: number } = {}) {
  const pty = o.pty ?? fakePtyModule()
  const sent: HostToMain[] = []
  const exits: number[] = []
  const dirs = new Set(o.dirs ?? [DIR])
  const service = startPtyHost({
    loadPty: o.load ?? (() => pty.mod),
    send: (m) => sent.push(m),
    exit: (code) => exits.push(code),
    isDir: (p) => dirs.has(p),
    scrollback: 100,
    ...(o.shutdownWaitMs === undefined ? {} : { shutdownWaitMs: o.shutdownWaitMs }),
  })
  const of = <T extends HostToMain['type']>(type: T) => sent.filter((m): m is Extract<HostToMain, { type: T }> => m.type === type)
  /** What main got, without `ready` and the beats. */
  const answers = () => sent.filter((m) => m.type !== 'ready' && m.type !== 'beat')
  /** A window port, given to the host as main's `connect` does. */
  const connect = () => {
    const w = fakePort()
    service.handle({ type: 'connect' }, [w.port])
    return w
  }
  return { service, sent, exits, spawned: pty.spawned, of, answers, connect }
}

/** A stand-in for Electron's MessagePortMain. */
function fakePort() {
  const on: { message: ((e: { data: unknown }) => void)[]; close: (() => void)[] } = { message: [], close: [] }
  const got: HostToWindow[] = []
  let started = false
  const port: WindowPort = {
    on: (event: 'message' | 'close', fn: never) => void on[event].push(fn),
    start: () => {
      started = true
    },
    postMessage: (m) => void got.push(m as HostToWindow),
  }
  return { port, got, started: () => started, send: (data: unknown) => on.message.forEach((fn) => fn({ data })), close: () => on.close.forEach((fn) => fn()) }
}

const spec = (o: Partial<StartSpec> = {}): StartSpec => ({ id: 'run-1', program: PROGRAM, args: ['-c', 'echo hi'], cwd: DIR, env: { TERM: 'xterm-256color' }, cols: 80, rows: 24, ...o })

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(ok()).toBe(true)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('pty host service', () => {
  test('ready once after node-pty loads', () => {
    const h = host()
    expect(h.sent).toEqual([{ type: 'ready', version: 1 }])
    expect(h.exits).toEqual([])
  })

  test('a node-pty that fails to load answers load-failed', () => {
    const h = host({
      load: () => {
        throw new Error('Failed to load native module: pty.node')
      },
    })
    expect(h.sent).toEqual([{ type: 'load-failed', error: 'Failed to load native module: pty.node' }])
    expect(h.exits).toEqual([1])
    // Nothing more: it never claims to be ready, and a start spawns nothing.
    h.service.handle({ type: 'start', spec: spec() })
    expect(h.sent).toHaveLength(1)
  })

  test('start spawns the program and answers started', () => {
    const h = host()
    h.service.handle({ type: 'start', spec: spec({ args: ['-c', 'printf "%s" "a b"'], env: { A: '1' }, cols: 100, rows: 30 }) })
    expect(h.spawned).toHaveLength(1)
    const [pty] = h.spawned
    expect(pty!.file).toBe(PROGRAM)
    expect(pty!.args).toEqual(['-c', 'printf "%s" "a b"'])
    expect(pty!.options).toMatchObject({ cwd: DIR, env: { A: '1' }, cols: 100, rows: 30 })
    expect(h.of('started')).toEqual([{ type: 'started', id: 'run-1', pid: pty!.pid }])
  })

  test('start refuses bad specs and spawns nothing', () => {
    const h = host()
    h.service.handle({ type: 'start', spec: spec({ id: 'in-use' }) })
    const cases: [unknown, string, string][] = [
      [spec({ id: 'Run-1' }), 'Run-1', 'bad id'],
      [spec({ id: '' }), '', 'bad id'],
      [spec({ id: 'a'.repeat(65) }), 'a'.repeat(65), 'bad id'],
      [spec({ id: 'run 1' }), 'run 1', 'bad id'],
      [spec({ id: '../x' }), '../x', 'bad id'],
      [spec({ id: 'in-use' }), 'in-use', 'id in use'],
      [spec({ program: 'sh' }), 'run-1', 'program not absolute'],
      [spec({ program: './bin/sh' }), 'run-1', 'program not absolute'],
      [spec({ cwd: isAbsolute('/nope') ? '/nope' : 'C:\\nope' }), 'run-1', 'no folder'],
      [spec({ cwd: 'work' }), 'run-1', 'no folder'],
      [spec({ cols: 1 }), 'run-1', 'bad size'],
      [spec({ cols: 501 }), 'run-1', 'bad size'],
      [spec({ rows: 0 }), 'run-1', 'bad size'],
      [spec({ rows: 201 }), 'run-1', 'bad size'],
      [spec({ cols: 80.5 }), 'run-1', 'bad size'],
      [spec({ args: [1] as unknown as string[] }), 'run-1', 'bad message'],
      [spec({ env: { A: 1 } as unknown as Record<string, string> }), 'run-1', 'bad message'],
    ]
    for (const [bad, id, error] of cases) {
      h.service.handle({ type: 'start', spec: bad })
      expect(h.sent.at(-1), error).toEqual({ type: 'start-failed', id, error })
    }
    expect(h.spawned).toHaveLength(1)
    // The bounds themselves are fine.
    for (const [cols, rows] of [[2, 1], [500, 200]] as const) h.service.handle({ type: 'start', spec: spec({ id: `edge-${cols}`, cols, rows }) })
    expect(h.spawned).toHaveLength(3)
  })

  test('a spawn that throws answers spawn failed', () => {
    const h = host({ pty: fakePtyModule({ spawnError: 'ENOENT' }) })
    h.service.handle({ type: 'start', spec: spec() })
    expect(h.sent.at(-1)).toEqual({ type: 'start-failed', id: 'run-1', error: 'spawn failed: ENOENT' })
    // The id is free again.
    h.service.handle({ type: 'snapshot', id: 'run-1' })
    expect(h.sent.at(-1)).toEqual({ type: 'snapshot', id: 'run-1', text: null })
  })

  test('exit is reported once', () => {
    const h = host()
    h.service.handle({ type: 'start', spec: spec() })
    h.spawned[0]!.end(3)
    h.spawned[0]!.end(3)
    expect(h.of('exit')).toEqual([{ type: 'exit', id: 'run-1', exitCode: 3 }])
    h.service.handle({ type: 'start', spec: spec({ id: 'run-2' }) })
    h.spawned[1]!.end(0, 15)
    expect(h.of('exit').at(-1)).toEqual({ type: 'exit', id: 'run-2', exitCode: 0, signal: 15 })
  })

  test('snapshot', async () => {
    const h = host()
    h.service.handle({ type: 'snapshot', id: 'nobody' })
    expect(h.sent.at(-1)).toEqual({ type: 'snapshot', id: 'nobody', text: null })

    h.service.handle({ type: 'start', spec: spec({ cols: 10 }) })
    const pty = h.spawned[0]!
    // Colour, a cursor move, trailing spaces, and a line longer than the screen is wide.
    pty.emit('\x1b[31mred\x1b[0m   \r\nsecond\r\n0123456789abc\r\n')
    h.service.handle({ type: 'snapshot', id: 'run-1' })
    await until(() => h.of('snapshot').length === 2)
    expect(h.of('snapshot')[1]).toEqual({ type: 'snapshot', id: 'run-1', text: 'red\nsecond\n0123456789abc' })

    // An exited session still answers, with its last screen, until dispose.
    pty.emit('last\r\n')
    pty.end(0)
    h.service.handle({ type: 'snapshot', id: 'run-1' })
    await until(() => h.of('snapshot').length === 3)
    expect(h.of('snapshot')[2]!.text).toBe('red\nsecond\n0123456789abc\nlast')
    h.service.handle({ type: 'dispose', id: 'run-1' })
    h.service.handle({ type: 'snapshot', id: 'run-1' })
    await until(() => h.of('snapshot').length === 4)
    expect(h.of('snapshot')[3]).toEqual({ type: 'snapshot', id: 'run-1', text: null })
    // After dispose the id is free.
    h.service.handle({ type: 'start', spec: spec() })
    expect(h.of('started')).toHaveLength(2)
  })

  test('snapshot keeps the newest lines within the scrollback', async () => {
    const h = host()
    h.service.handle({ type: 'start', spec: spec({ rows: 5 }) })
    h.spawned[0]!.emit(Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\r\n'))
    h.service.handle({ type: 'snapshot', id: 'run-1' })
    await until(() => h.of('snapshot').length === 1)
    const lines = h.of('snapshot')[0]!.text!.split('\n')
    // 100 lines of scrollback plus 5 on screen.
    expect(lines).toHaveLength(105)
    expect(lines.at(-1)).toBe('line 300')
    expect(lines[0]).toBe('line 196')
  })

  test('dispose kills a live session', () => {
    const h = host()
    h.service.handle({ type: 'start', spec: spec() })
    h.service.handle({ type: 'dispose', id: 'run-1' })
    expect(h.spawned[0]!.killed).toHaveLength(1)
    h.service.handle({ type: 'dispose', id: 'nobody' })
  })

  test('shutdown ends every session, then the host', async () => {
    const h = host()
    h.service.handle({ type: 'start', spec: spec({ id: 'a' }) })
    h.service.handle({ type: 'start', spec: spec({ id: 'b' }) })
    h.spawned[1]!.end(0)
    h.service.handle({ type: 'shutdown' })
    // Only the live one gets a kill. The host waits for its exit, then exits 0.
    expect(h.spawned[0]!.killed).toHaveLength(1)
    expect(h.spawned[1]!.killed).toHaveLength(0)
    await until(() => h.exits.length === 1)
    expect(h.exits).toEqual([0])
    expect(h.of('exit').map((m) => m.id)).toEqual(['b', 'a'])
    // A second shutdown, and a start after shutdown, do nothing.
    h.service.handle({ type: 'shutdown' })
    h.service.handle({ type: 'start', spec: spec({ id: 'c' }) })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.exits).toEqual([0])
    expect(h.spawned).toHaveLength(2)
  })

  test('shutdown exits within 3 s when a pty never ends', async () => {
    vi.useFakeTimers()
    const h = host({ pty: fakePtyModule({ exitOnKill: false }) })
    h.service.handle({ type: 'start', spec: spec() })
    h.service.handle({ type: 'shutdown' })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(h.exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.exits).toEqual([0])
  })

  test('shutdown with no session exits at once', async () => {
    const h = host()
    h.service.handle({ type: 'shutdown' })
    await until(() => h.exits.length === 1)
    expect(h.exits).toEqual([0])
  })

  test('a kill that throws still lets the host exit', async () => {
    const h = host()
    h.service.handle({ type: 'start', spec: spec() })
    h.spawned[0]!.kill = () => {
      throw new Error('already closed')
    }
    vi.useFakeTimers()
    h.service.handle({ type: 'shutdown' })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.exits).toEqual([0])
  })

  // On Windows node-pty starts the process after spawn returns, so its pid is 0 for a moment.
  describe('a pid that shows late', () => {
    test('started waits for the pid', async () => {
      vi.useFakeTimers()
      const h = host({ pty: fakePtyModule({ latePid: true }) })
      h.service.handle({ type: 'start', spec: spec() })
      expect(h.of('started')).toEqual([])
      await vi.advanceTimersByTimeAsync(50)
      expect(h.of('started')).toEqual([])
      h.spawned[0]!.connect()
      await vi.advanceTimersByTimeAsync(10)
      expect(h.of('started')).toEqual([{ type: 'started', id: 'run-1', pid: 100 }])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.of('started')).toHaveLength(1)
    })

    test('the first data announces it without waiting for the poll', () => {
      const h = host({ pty: fakePtyModule({ latePid: true }) })
      h.service.handle({ type: 'start', spec: spec() })
      h.spawned[0]!.connect()
      h.spawned[0]!.emit('hi')
      expect(h.of('started')).toEqual([{ type: 'started', id: 'run-1', pid: 100 }])
    })

    test('an exit that beats the poll comes after started, each once', () => {
      const h = host({ pty: fakePtyModule({ latePid: true }) })
      h.service.handle({ type: 'start', spec: spec() })
      h.spawned[0]!.connect()
      h.spawned[0]!.end(7)
      h.spawned[0]!.end(7)
      expect(h.answers()).toEqual([
        { type: 'started', id: 'run-1', pid: 100 },
        { type: 'exit', id: 'run-1', exitCode: 7 },
      ])
    })

    test('an exit with no pid answers spawn failed, frees the id, and reports no exit', async () => {
      vi.useFakeTimers()
      const h = host({ pty: fakePtyModule({ latePid: true }) })
      h.service.handle({ type: 'start', spec: spec() })
      h.spawned[0]!.end(-1)
      expect(h.answers()).toEqual([{ type: 'start-failed', id: 'run-1', error: 'spawn failed: the program ended before it started (exit code -1)' }])
      await vi.advanceTimersByTimeAsync(20_000)
      expect(h.answers()).toHaveLength(1)
      h.service.handle({ type: 'snapshot', id: 'run-1' })
      await vi.advanceTimersByTimeAsync(10)
      expect(h.of('snapshot')).toEqual([{ type: 'snapshot', id: 'run-1', text: null }])
      h.service.handle({ type: 'start', spec: spec() })
      expect(h.of('start-failed')).toHaveLength(1)
      expect(h.spawned).toHaveLength(2)
    })

    test('no pid within 10 s answers spawn failed and kills the pty', async () => {
      vi.useFakeTimers()
      const h = host({ pty: fakePtyModule({ latePid: true, exitOnKill: false }) })
      h.service.handle({ type: 'start', spec: spec() })
      await vi.advanceTimersByTimeAsync(9_990)
      expect(h.answers()).toEqual([])
      await vi.advanceTimersByTimeAsync(20)
      expect(h.answers()).toEqual([{ type: 'start-failed', id: 'run-1', error: 'spawn failed: no process ID after 10 s' }])
      expect(h.spawned[0]!.killed).toHaveLength(1)
      // A pid or exit that comes later sends nothing.
      h.spawned[0]!.connect()
      h.spawned[0]!.end(0)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.answers()).toHaveLength(1)
      h.service.handle({ type: 'start', spec: spec() })
      expect(h.spawned).toHaveLength(2)
    })

    test('a second start with the same id while waiting is refused', () => {
      const h = host({ pty: fakePtyModule({ latePid: true }) })
      h.service.handle({ type: 'start', spec: spec() })
      h.service.handle({ type: 'start', spec: spec() })
      expect(h.of('start-failed')).toEqual([{ type: 'start-failed', id: 'run-1', error: 'id in use' }])
      expect(h.spawned).toHaveLength(1)
    })

    test('shutdown while waiting answers spawn failed and the host still exits', async () => {
      vi.useFakeTimers()
      const h = host({ pty: fakePtyModule({ latePid: true, exitOnKill: false }) })
      h.service.handle({ type: 'start', spec: spec() })
      h.service.handle({ type: 'shutdown' })
      expect(h.answers()).toEqual([{ type: 'start-failed', id: 'run-1', error: 'spawn failed: the host is shutting down' }])
      expect(h.spawned[0]!.killed).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.exits).toEqual([0])
      h.spawned[0]!.connect()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(h.answers()).toHaveLength(1)
    })
  })

  test('a message it does not know never throws', () => {
    const h = host()
    for (const m of [null, 1, 'start', {}, { type: 'nope' }, { type: 'start' }, { type: 'snapshot' }, { type: 'snapshot', id: 5 }, { type: 'dispose', id: {} }]) {
      expect(() => h.service.handle(m)).not.toThrow()
    }
    expect(h.spawned).toHaveLength(0)
  })
  test('the host beats every 5 s', async () => {
    vi.useFakeTimers()
    const h = host()
    expect(h.sent).toEqual([{ type: 'ready', version: 1 }])
    await vi.advanceTimersByTimeAsync(4_999)
    expect(h.of('beat')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.of('beat')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.of('beat')).toHaveLength(3)
    expect(h.of('ready')).toHaveLength(1)
    // The beats stop once the host has shut down.
    h.service.handle({ type: 'shutdown' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.exits).toEqual([0])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.of('beat')).toHaveLength(3)
  })

  test('a host that failed to load never beats', async () => {
    vi.useFakeTimers()
    const h = host({
      load: () => {
        throw new Error('no pty.node')
      },
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.sent).toEqual([{ type: 'load-failed', error: 'no pty.node' }])
  })

  test('list', () => {
    vi.useFakeTimers({ now: 1_000 })
    const h = host()
    h.service.handle({ type: 'list' })
    expect(h.sent.at(-1)).toEqual({ type: 'list', sessions: [] })
    h.service.handle({ type: 'start', spec: spec({ id: 'a' }) })
    vi.setSystemTime(2_000)
    h.service.handle({ type: 'start', spec: spec({ id: 'b' }) })
    h.spawned[1]!.end(4)
    h.service.handle({ type: 'list' })
    expect(h.sent.at(-1)).toEqual({
      type: 'list',
      sessions: [
        { id: 'a', pid: 100, live: true, startedAt: 1_000 },
        { id: 'b', pid: 101, live: false, startedAt: 2_000 },
      ],
    })
  })

  test('a session waiting for its pid lists with pid 0', () => {
    vi.useFakeTimers({ now: 1_000 })
    const h = host({ pty: fakePtyModule({ latePid: true }) })
    h.service.handle({ type: 'start', spec: spec() })
    h.service.handle({ type: 'list' })
    expect(h.sent.at(-1)).toEqual({ type: 'list', sessions: [{ id: 'run-1', pid: 0, live: true, startedAt: 1_000 }] })
  })

  test('kill and dispose', async () => {
    const h = host()
    const w = h.connect()
    h.service.handle({ type: 'start', spec: spec() })
    w.send({ type: 'attach', id: 'run-1' })
    h.service.handle({ type: 'kill', id: 'run-1' })
    h.service.handle({ type: 'kill', id: 'run-1' })
    await until(() => w.got.some((m) => m.type === 'exit'))
    h.service.handle({ type: 'kill', id: 'run-1' })
    // The pty's own kill; one exit to main and one to the port.
    expect(h.spawned[0]!.killed).toEqual(['default', 'default'])
    expect(h.of('exit')).toEqual([{ type: 'exit', id: 'run-1', exitCode: 0, signal: 1 }])
    expect(w.got.filter((m) => m.type === 'exit')).toEqual([{ type: 'exit', id: 'run-1', exitCode: 0 }])
    h.service.handle({ type: 'list' })
    expect(h.of('list').at(-1)!.sessions).toMatchObject([{ id: 'run-1', live: false }])

    h.service.handle({ type: 'dispose', id: 'run-1' })
    h.service.handle({ type: 'list' })
    expect(h.of('list').at(-1)!.sessions).toEqual([])
    // A kill or dispose of an unknown id does nothing.
    h.service.handle({ type: 'kill', id: 'nobody' })
    h.service.handle({ type: 'dispose', id: 'nobody' })
    expect(h.answers().filter((m) => m.type !== 'list' && m.type !== 'started')).toHaveLength(1)
  })

  test('dispose of a live session kills it and sends no exit', async () => {
    const h = host()
    const w = h.connect()
    h.service.handle({ type: 'start', spec: spec() })
    w.send({ type: 'attach', id: 'run-1' })
    await until(() => w.got.length === 1)
    h.service.handle({ type: 'dispose', id: 'run-1' })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.spawned[0]!.killed).toHaveLength(1)
    expect(h.of('exit')).toEqual([])
    expect(w.got.map((m) => m.type)).toEqual(['replay'])
  })

  describe('kill before the pid', () => {
    for (const [type, word] of [
      ['kill', 'killed before it started'],
      ['dispose', 'disposed before it started'],
    ] as const) {
      test(`${type} answers start-failed at once and frees the id`, async () => {
        vi.useFakeTimers()
        const h = host({ pty: fakePtyModule({ latePid: true, exitOnKill: false }) })
        const w = h.connect()
        h.service.handle({ type: 'start', spec: spec() })
        h.service.handle({ type, id: 'run-1' })
        expect(h.answers()).toEqual([{ type: 'start-failed', id: 'run-1', error: `spawn failed: ${word}` }])
        // A pty that takes the kill now gets it now, once.
        expect(h.spawned[0]!.killed).toHaveLength(1)
        h.service.handle({ type: 'list' })
        expect(h.of('list').at(-1)!.sessions).toEqual([])
        // The pid, data, and exit that come later send nothing, to main or to a window.
        h.spawned[0]!.connect()
        h.spawned[0]!.emit('late\r\n')
        h.spawned[0]!.end(0)
        await vi.advanceTimersByTimeAsync(20_000)
        expect(h.answers().filter((m) => m.type !== 'list')).toHaveLength(1)
        expect(h.spawned[0]!.killed).toHaveLength(1)
        w.send({ type: 'attach', id: 'run-1' })
        expect(w.got).toEqual([{ type: 'error', id: 'run-1', error: 'no session' }])
        // The id is free.
        h.service.handle({ type: 'start', spec: spec() })
        expect(h.spawned).toHaveLength(2)
      })

      test(`${type} kills at the pid when the pty can't take the kill before it`, async () => {
        vi.useFakeTimers()
        const h = host({ pty: fakePtyModule({ latePid: true, exitOnKill: false, killThrowsBeforePid: true }) })
        h.service.handle({ type: 'start', spec: spec() })
        h.service.handle({ type, id: 'run-1' })
        expect(h.answers()).toEqual([{ type: 'start-failed', id: 'run-1', error: `spawn failed: ${word}` }])
        await vi.advanceTimersByTimeAsync(500)
        expect(h.spawned[0]!.killed).toEqual([])
        h.spawned[0]!.connect()
        await vi.advanceTimersByTimeAsync(10)
        expect(h.spawned[0]!.killed).toEqual(['default'])
        h.spawned[0]!.end(0)
        await vi.advanceTimersByTimeAsync(20_000)
        expect(h.spawned[0]!.killed).toHaveLength(1)
        expect(h.answers()).toHaveLength(1)
      })
    }

    test('a pid that never shows stops the kill tries at 10 s', async () => {
      vi.useFakeTimers()
      const h = host({ pty: fakePtyModule({ latePid: true, exitOnKill: false, killThrowsBeforePid: true }) })
      h.service.handle({ type: 'start', spec: spec() })
      h.service.handle({ type: 'kill', id: 'run-1' })
      await vi.advanceTimersByTimeAsync(10_100)
      h.spawned[0]!.connect()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.spawned[0]!.killed).toEqual([])
      expect(h.answers()).toHaveLength(1)
    })
  })

  describe('window ports', () => {
    test('connect starts the port; input reaches the pty; output and exit reach the port', async () => {
      const h = host()
      const w = h.connect()
      expect(w.started()).toBe(true)
      h.service.handle({ type: 'start', spec: spec() })
      w.send({ type: 'attach', id: 'run-1' })
      w.send({ type: 'input', id: 'run-1', data: 'echo hi\r' })
      expect(h.spawned[0]!.written).toEqual(['echo hi\r'])
      await until(() => w.got.length === 1)
      h.spawned[0]!.emit('hi\r\n')
      h.spawned[0]!.end(0)
      await until(() => w.got.length === 3)
      expect(w.got).toMatchObject([{ type: 'replay', id: 'run-1' }, { type: 'data', id: 'run-1', data: 'hi\r\n' }, { type: 'exit', id: 'run-1', exitCode: 0 }])
      // Input after the exit is ignored.
      w.send({ type: 'input', id: 'run-1', data: 'late' })
      expect(h.spawned[0]!.written).toEqual(['echo hi\r'])
    })

    test('attach edges', async () => {
      const h = host({ pty: fakePtyModule({ latePid: true }) })
      const w = h.connect()
      w.send({ type: 'attach', id: 'nobody' })
      expect(w.got).toEqual([{ type: 'error', id: 'nobody', error: 'no session' }])

      // A session still waiting for its pid is not there yet for a window.
      h.service.handle({ type: 'start', spec: spec() })
      w.send({ type: 'attach', id: 'run-1' })
      w.send({ type: 'input', id: 'run-1', data: 'x' })
      w.send({ type: 'resize', id: 'run-1', cols: 90, rows: 30 })
      expect(w.got.slice(1)).toEqual([
        { type: 'error', id: 'run-1', error: 'no session' },
        { type: 'error', id: 'run-1', error: 'no session' },
        { type: 'error', id: 'run-1', error: 'no session' },
      ])
      expect(h.spawned[0]!.written).toEqual([])

      // An exited session: replay, then exit.
      h.spawned[0]!.connect()
      h.spawned[0]!.emit('done\r\n')
      h.spawned[0]!.end(5)
      w.got.length = 0
      w.send({ type: 'attach', id: 'run-1' })
      await until(() => w.got.length === 2)
      expect(w.got.map((m) => m.type)).toEqual(['replay', 'exit'])
      expect(w.got[1]).toEqual({ type: 'exit', id: 'run-1', exitCode: 5 })
      expect((w.got[0] as { data: string }).data).toContain('done')

      // A disposed one is gone.
      h.service.handle({ type: 'dispose', id: 'run-1' })
      w.send({ type: 'attach', id: 'run-1' })
      expect(w.got.at(-1)).toEqual({ type: 'error', id: 'run-1', error: 'no session' })
    })

    test('resize applies to the pty, and a bad size answers bad resize', () => {
      const resized: string[] = []
      const pty = fakePtyModule()
      const h = host({ pty })
      const w = h.connect()
      h.service.handle({ type: 'start', spec: spec() })
      h.spawned[0]!.resize = (cols, rows) => void resized.push(`${cols}x${rows}`)
      w.send({ type: 'resize', id: 'run-1', cols: 120, rows: 40 })
      w.send({ type: 'resize', id: 'run-1', cols: 501, rows: 40 })
      expect(resized).toEqual(['120x40'])
      expect(w.got).toEqual([{ type: 'error', id: 'run-1', error: 'bad resize' }])
    })

    test("a window port can't start, kill, or dispose", async () => {
      const h = host()
      h.service.handle({ type: 'start', spec: spec() })
      const before = h.sent.length
      const w = h.connect()
      for (const m of [
        { type: 'start', spec: spec({ id: 'run-2' }) },
        { type: 'kill', id: 'run-1' },
        { type: 'dispose', id: 'run-1' },
        { type: 'list' },
        { type: 'snapshot', id: 'run-1' },
        { type: 'connect' },
        { type: 'shutdown' },
      ]) {
        w.got.length = 0
        expect(() => w.send(m)).not.toThrow()
        expect(w.got, m.type).toEqual([{ type: 'error', ...('id' in m ? { id: m.id } : {}), error: 'not allowed' }])
      }
      await new Promise((r) => setTimeout(r, 20))
      // Nothing changed: one pty, never killed, still live and listed; main heard nothing; no exit.
      expect(h.spawned).toHaveLength(1)
      expect(h.spawned[0]!.killed).toEqual([])
      expect(h.sent.length).toBe(before)
      expect(h.exits).toEqual([])
      h.service.handle({ type: 'list' })
      expect(h.of('list').at(-1)!.sessions).toMatchObject([{ id: 'run-1', live: true }])
    })

    test('bad messages', () => {
      const h = host()
      h.service.handle({ type: 'start', spec: spec() })
      const w = h.connect()
      const bad = [
        null,
        1,
        'attach',
        [],
        {},
        { type: 'nope', id: 'run-1' },
        { type: 'attach' },
        { type: 'attach', id: 5 },
        { type: 'detach' },
        { type: 'input', id: 'run-1' },
        { type: 'input', id: 'run-1', data: 5 },
        { type: 'resize', id: 'run-1', cols: '80', rows: 24 },
        { type: 'resize', id: 'run-1', cols: 80 },
        { type: 'ack', id: 'run-1' },
        { type: 'ack', id: 'run-1', chars: -1 },
        { type: 'ack', id: 'run-1', chars: 1.5 },
        { type: 'ack', id: 'run-1', chars: '10' },
      ]
      for (const m of bad) {
        w.got.length = 0
        expect(() => w.send(m)).not.toThrow()
        const id = typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string' ? { id: (m as { id: string }).id } : {}
        expect(w.got, JSON.stringify(m)).toEqual([{ type: 'error', ...id, error: 'bad message' }])
      }
      // From main, with no port to answer on: never throws, and changes nothing.
      for (const m of [{ type: 'connect' }, { type: 'kill' }, { type: 'kill', id: 5 }, { type: 'list', id: 'x' }, { type: 'dispose' }]) {
        expect(() => h.service.handle(m)).not.toThrow()
      }
      expect(() => h.service.handle({ type: 'connect' }, [{}])).not.toThrow()
      expect(() => h.service.handle({ type: 'connect' }, [null])).not.toThrow()
      expect(h.spawned[0]!.killed).toEqual([])
      expect(h.spawned[0]!.written).toEqual([])
    })

    test('a port that throws on post never throws out of the host', async () => {
      const h = host()
      const w = h.connect()
      w.port.postMessage = () => {
        throw new Error('closed')
      }
      h.service.handle({ type: 'start', spec: spec() })
      expect(() => w.send({ type: 'attach', id: 'nobody' })).not.toThrow()
      expect(() => w.send({ type: 'attach', id: 'run-1' })).not.toThrow()
      h.spawned[0]!.emit('x')
      await new Promise((r) => setTimeout(r, 20))
    })

    test('a closed port gets nothing more and its acks no longer matter', async () => {
      const h = host()
      const w = h.connect()
      h.service.handle({ type: 'start', spec: spec() })
      w.send({ type: 'attach', id: 'run-1' })
      await until(() => w.got.length === 1)
      w.close()
      h.spawned[0]!.emit('after\r\n')
      await new Promise((r) => setTimeout(r, 20))
      expect(w.got.map((m) => m.type)).toEqual(['replay'])
    })

    test('after shutdown a port gets no answer', async () => {
      const h = host()
      const w = h.connect()
      h.service.handle({ type: 'shutdown' })
      w.send({ type: 'attach', id: 'nobody' })
      expect(w.got).toEqual([])
    })
  })
})
