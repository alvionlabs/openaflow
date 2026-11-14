import { isAbsolute } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { HostToMain, StartSpec } from './protocol.ts'
import { startPtyHost, type PtyModule, type PtyProcess, type PtySpawnOptions } from './service.ts'

type FakePty = PtyProcess & {
  file: string
  args: string[]
  options: PtySpawnOptions
  emit(data: string): void
  end(exitCode: number, signal?: number): void
  killed: string[]
}

const DIR = isAbsolute('/work') ? '/work' : 'C:\\work'
const PROGRAM = isAbsolute('/bin/sh') ? '/bin/sh' : 'C:\\Windows\\System32\\cmd.exe'

function fakePtyModule(o: { exitOnKill?: boolean; spawnError?: string } = {}) {
  const spawned: FakePty[] = []
  let nextPid = 100
  const mod: PtyModule = {
    spawn(file, args, options) {
      if (o.spawnError !== undefined) throw new Error(o.spawnError)
      const data: ((d: string) => void)[] = []
      const exits: ((e: { exitCode: number; signal?: number }) => void)[] = []
      const pty: FakePty = {
        pid: nextPid++,
        file,
        args,
        options,
        killed: [],
        onData: (fn) => {
          data.push(fn)
          return { dispose() {} }
        },
        onExit: (fn) => {
          exits.push(fn)
          return { dispose() {} }
        },
        kill(signal) {
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
  return { service, sent, exits, spawned: pty.spawned, of }
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

  test('a message it does not know never throws', () => {
    const h = host()
    for (const m of [null, 1, 'start', {}, { type: 'nope' }, { type: 'start' }, { type: 'snapshot' }, { type: 'snapshot', id: 5 }, { type: 'dispose', id: {} }]) {
      expect(() => h.service.handle(m)).not.toThrow()
    }
    expect(h.spawned).toHaveLength(0)
  })
})
