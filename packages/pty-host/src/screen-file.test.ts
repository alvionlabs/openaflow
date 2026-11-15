import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { HostToMain, StartSpec } from './protocol.ts'
import { nodeScreenFs, writeScreenFile, type ScreenFs } from './screen-file.ts'
import { startPtyHost, type PtyModule, type PtyProcess } from './service.ts'

// Screen files through the host's public messages: a fake pty, a fake clock, the real headless terminal, and a fake
// file system, except for the atomic write, which uses the real one in a temp folder.

const WIN = process.platform === 'win32'
const DIR = isAbsolute('/work') ? '/work' : 'C:\\work'
const PROGRAM = isAbsolute('/bin/sh') ? '/bin/sh' : 'C:\\Windows\\System32\\cmd.exe'
const FILE = join(DIR, 'cfg', 'screens', 'run-1.txt')

type FakePty = PtyProcess & { emit(data: string): void; end(exitCode: number): void; connect(): void }

/** `events` is shared with the file system's, so a test can check the order of saves and kills. */
function fakePtyModule(events: string[], o: { latePid?: boolean } = {}) {
  const spawned: FakePty[] = []
  let nextPid = 100
  const mod: PtyModule = {
    spawn() {
      const data: ((d: string) => void)[] = []
      const exits: ((e: { exitCode: number }) => void)[] = []
      const pid = nextPid++
      let connected = o.latePid !== true
      const pty: FakePty = {
        get pid() {
          return connected ? pid : 0
        },
        connect: () => {
          connected = true
        },
        write: () => {},
        resize: () => {},
        pause: () => {},
        resume: () => {},
        onData: (fn) => void data.push(fn),
        onExit: (fn) => void exits.push(fn),
        kill() {
          events.push(`kill ${pid}`)
          queueMicrotask(() => pty.end(0))
        },
        emit: (d) => data.forEach((fn) => fn(d)),
        end: (exitCode) => exits.forEach((fn) => fn({ exitCode })),
      }
      spawned.push(pty)
      return pty
    },
  }
  return { mod, spawned }
}

/** Files in memory. `fail` makes an operation throw or reject; `hold` keeps each write open until `release`. */
function fakeFs(events: string[], o: { fail?: 'reject' | 'throw'; hold?: boolean } = {}) {
  const files = new Map<string, string>()
  const held: (() => void)[] = []
  let writes = 0
  const fs: ScreenFs = {
    mkdir: async (dir) => void events.push(`mkdir ${dir}`),
    writeFile(path, text) {
      writes++
      if (o.fail === 'throw') throw new Error(`EACCES: permission denied, open '${path}'`)
      if (o.fail === 'reject') return Promise.reject(new Error(`EACCES: permission denied, open '${path}'`))
      const done = () => void files.set(path, text)
      if (!o.hold) return Promise.resolve(done())
      return new Promise<void>((r) => held.push(() => r(done())))
    },
    rename: async (from, to) => {
      const text = files.get(from)
      if (text === undefined) throw new Error(`ENOENT: rename '${from}'`)
      files.delete(from)
      files.set(to, text)
      events.push(`save ${to}: ${text}`)
    },
    unlink: async (path) => void files.delete(path),
  }
  return {
    fs,
    files,
    /** The texts saved to `file`, in order. */
    saved: (file = FILE) => events.filter((e) => e.startsWith(`save ${file}: `)).map((e) => e.slice(`save ${file}: `.length)),
    writes: () => writes,
    release: () => held.splice(0).forEach((fn) => fn()),
  }
}

function host(o: { fs?: 'reject' | 'throw'; hold?: boolean; latePid?: boolean } = {}) {
  const events: string[] = []
  const pty = fakePtyModule(events, o)
  const files = fakeFs(events, { ...(o.fs === undefined ? {} : { fail: o.fs }), ...(o.hold === undefined ? {} : { hold: o.hold }) })
  const sent: HostToMain[] = []
  const logs: string[] = []
  const exits: number[] = []
  const service = startPtyHost({
    loadPty: () => pty.mod,
    send: (m) => sent.push(m),
    exit: (code) => exits.push(code),
    isDir: (p) => p === DIR,
    scrollback: 100,
    screenFs: files.fs,
    log: (line) => logs.push(line),
  })
  return { service, sent, logs, exits, events, spawned: pty.spawned, ...files }
}

const spec = (o: Partial<StartSpec> = {}): StartSpec => ({ id: 'run-1', program: PROGRAM, args: [], cwd: DIR, env: {}, cols: 80, rows: 24, screenFile: FILE, ...o })

afterEach(() => {
  vi.useRealTimers()
})

describe('screen files', () => {
  test('save times', async () => {
    vi.useFakeTimers()
    const h = host()
    h.service.handle({ type: 'start', spec: spec() })
    h.service.handle({ type: 'start', spec: spec({ id: 'no-file', screenFile: undefined }) })
    const pty = h.spawned[0]!
    pty.emit('one\r\n')
    h.spawned[1]!.emit('elsewhere\r\n')

    // Not before 10 s; at 10 s, once.
    await vi.advanceTimersByTimeAsync(9_999)
    expect(h.saved()).toEqual([])
    // The parser takes a moment of the fake clock, so each check after a mark waits 10 ms.
    await vi.advanceTimersByTimeAsync(10)
    expect(h.saved()).toEqual(['one'])
    // Nothing changed: no write.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.saved()).toEqual(['one'])
    // Output that leaves the text as it was: no write.
    pty.emit('\x1b[0m')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.saved()).toEqual(['one'])
    // A change waits for the next 10 s mark.
    pty.emit('two\r\n')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.saved()).toEqual(['one'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.saved()).toEqual(['one', 'one\ntwo'])

    // Once after the exit, without waiting for the 10 s mark, then never again.
    pty.emit('bye\r\n')
    pty.end(3)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.saved()).toEqual(['one', 'one\ntwo', 'one\ntwo\nbye'])
    expect(h.sent).toContainEqual({ type: 'exit', id: 'run-1', exitCode: 3 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.saved()).toHaveLength(3)
    // A session with no screen file never writes.
    expect(h.events.filter((e) => e.includes('no-file'))).toEqual([])
  })

  test('save times: shutdown saves before it kills, and the exits after the kill save nothing more', async () => {
    vi.useFakeTimers()
    const h = host({ latePid: true })
    h.service.handle({ type: 'start', spec: spec({ id: 'a', screenFile: join(DIR, 'a.txt') }) })
    h.service.handle({ type: 'start', spec: spec({ id: 'b', screenFile: undefined }) })
    h.service.handle({ type: 'start', spec: spec({ id: 'waiting', screenFile: join(DIR, 'waiting.txt') }) })
    h.spawned[0]!.connect()
    h.spawned[1]!.connect()
    h.spawned[0]!.emit('a last words\r\n')
    await vi.advanceTimersByTimeAsync(10)
    h.service.handle({ type: 'shutdown' })
    await vi.advanceTimersByTimeAsync(100)
    // The waiting session never started: no file. The others are killed only after the save.
    expect(h.events.filter((e) => !e.startsWith('mkdir'))).toEqual([`kill 102`, `save ${join(DIR, 'a.txt')}: a last words`, 'kill 100', 'kill 101'])
    expect(h.exits).toEqual([0])
  })

  test('save times: shutdown waits for the saves when no pty is live, 2 s at most', async () => {
    vi.useFakeTimers()
    const h = host({ hold: true })
    h.service.handle({ type: 'start', spec: spec() })
    h.spawned[0]!.emit('done\r\n')
    h.spawned[0]!.end(0)
    await vi.advanceTimersByTimeAsync(10)
    h.release()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.saved()).toEqual(['done'])
    h.service.handle({ type: 'shutdown' })
    await vi.advanceTimersByTimeAsync(10)
    expect(h.exits).toEqual([])
    h.release()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.saved()).toEqual(['done', 'done'])
    expect(h.exits).toEqual([0])

    // A save that never ends: the host still exits at 2 s.
    const g = host({ hold: true })
    g.service.handle({ type: 'start', spec: spec() })
    g.spawned[0]!.end(0)
    await vi.advanceTimersByTimeAsync(10)
    g.service.handle({ type: 'shutdown' })
    await vi.advanceTimersByTimeAsync(1_980)
    expect(g.exits).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(g.exits).toEqual([0])
  })

  test('atomic write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openaflow-screen-'))
    try {
      const file = join(dir, 'cfg', 'screens', 'run-1.txt')
      // The folder is made.
      await writeScreenFile(nodeScreenFs, file, 'a long first text\nsecond line')
      expect(await readFile(file, 'utf8').catch(() => 'no file')).toBe('a long first text\nsecond line')
      // Replaced whole: nothing of the longer text is left.
      await writeScreenFile(nodeScreenFs, file, 'short')
      expect(await readFile(file, 'utf8')).toBe('short')
      // A file that was there with wider rights is replaced with 0600.
      await writeFile(file, 'old', { mode: 0o644 })
      await writeScreenFile(nodeScreenFs, file, 'new')
      expect(await readFile(file, 'utf8')).toBe('new')
      if (!WIN) expect((await stat(file)).mode & 0o777).toBe(0o600)
      // No temp file is left beside it.
      expect(await readdir(dirname(file))).toEqual(['run-1.txt'])

      // The text goes to a temp file in the same folder, which is then renamed onto the file.
      const ops: string[] = []
      const spy: ScreenFs = {
        mkdir: async (d) => void ops.push(`mkdir ${d}`),
        writeFile: async (p) => void ops.push(`write ${dirname(p) === dirname(file) && p !== file ? 'temp' : p}`),
        rename: async (from, to) => void ops.push(`rename ${dirname(from) === dirname(to) && from !== to ? 'temp' : from} ${to}`),
        unlink: async (p) => void ops.push(`unlink ${p}`),
      }
      await writeScreenFile(spy, file, 'x')
      expect(ops).toEqual([`mkdir ${dirname(file)}`, 'write temp', `rename temp ${file}`])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('write failures', async () => {
    for (const fail of ['reject', 'throw'] as const) {
      vi.useFakeTimers()
      const h = host({ fs: fail })
      h.service.handle({ type: 'start', spec: spec() })
      h.service.handle({ type: 'start', spec: spec({ id: 'run-2', screenFile: join(DIR, 'run-2.txt') }) })
      h.spawned[0]!.emit('secret words\r\n')
      h.spawned[1]!.emit('other secret\r\n')
      await vi.advanceTimersByTimeAsync(10_010)
      // One line for each session, with no screen text.
      expect(h.logs, fail).toHaveLength(2)
      expect(h.logs.join('\n')).not.toMatch(/secret/)
      expect(h.logs.some((l) => l.includes('run-1'))).toBe(true)
      // The session goes on: more output, more tries, no more lines; its exit still reaches main.
      h.spawned[0]!.emit('more secret\r\n')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.writes()).toBeGreaterThanOrEqual(3)
      expect(h.logs).toHaveLength(2)
      h.spawned[0]!.end(0)
      await vi.advanceTimersByTimeAsync(10)
      expect(h.sent).toContainEqual({ type: 'exit', id: 'run-1', exitCode: 0 })
      expect(h.logs).toHaveLength(2)
      vi.useRealTimers()
    }
  })

  test('write failures: no write after dispose', async () => {
    vi.useFakeTimers()
    // A write in flight when the session is disposed never lands.
    const h = host({ hold: true })
    h.service.handle({ type: 'start', spec: spec() })
    h.spawned[0]!.emit('one\r\n')
    await vi.advanceTimersByTimeAsync(10_010)
    expect(h.writes()).toBe(1)
    h.service.handle({ type: 'dispose', id: 'run-1' })
    h.release()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.saved()).toEqual([])
    // Its temp file is gone, and nothing more is written, not even after the pty's exit.
    expect([...h.files.keys()]).toEqual([])
    h.spawned[0]!.end(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.writes()).toBe(1)

    // A dispose before the first save: no write at all.
    const g = host()
    g.service.handle({ type: 'start', spec: spec() })
    g.spawned[0]!.emit('one\r\n')
    g.service.handle({ type: 'dispose', id: 'run-1' })
    await vi.advanceTimersByTimeAsync(60_000)
    g.service.handle({ type: 'flush' })
    await vi.advanceTimersByTimeAsync(10)
    expect(g.writes()).toBe(0)
  })
})
