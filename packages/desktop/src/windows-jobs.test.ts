import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ANSWER_MS, CLOSE_MS, createJobControl, type HelperChild, type SpawnHelper } from './windows-jobs.ts'

// Node's own spawn is what main passes in.
const realSpawn: SpawnHelper = spawn

class FakeStream extends EventEmitter {
  written: string[] = []
  ended = false
  write(text: string): boolean {
    this.written.push(text)
    return true
  }
  end(): void {
    this.ended = true
  }
}

class FakeHelper extends EventEmitter {
  stdin = new FakeStream()
  stdout = new FakeStream()
  stderr = new FakeStream()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
  /** What the helper prints. */
  say(text: string): void {
    this.stdout.emit('data', Buffer.from(text))
  }
  /** The lines main wrote to the helper. */
  lines(): string[] {
    return this.stdin.written.join('').split('\n').filter(Boolean)
  }
}

function setup(platform: NodeJS.Platform = 'win32') {
  const helpers: FakeHelper[] = []
  const calls: { file: string; args: string[]; options: unknown }[] = []
  const log = vi.fn<(line: string) => void>()
  const fakeSpawn: SpawnHelper = (file, args, options) => {
    calls.push({ file, args, options })
    const h = new FakeHelper()
    helpers.push(h)
    return h as unknown as HelperChild
  }
  const jobs = createJobControl({ spawn: fakeSpawn, log, platform })
  return { jobs, helpers, calls, log }
}

/** Lets pending promise callbacks run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Tracks a promise's result without awaiting it. */
function track<T>(p: Promise<T>) {
  const t: { done: boolean; value?: T } = { done: false }
  void p.then((v) => {
    t.done = true
    t.value = v
  })
  return t
}

describe('helper protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('assign writes one line and answers true at ok, false at fail with one log line', async () => {
    const { jobs, helpers, log } = setup()
    const a = track(jobs.assign('s-1', 4242))
    expect(helpers).toHaveLength(1)
    expect(helpers[0]!.lines()).toEqual(['assign s-1 4242'])
    helpers[0]!.say('ok s-1\r\n')
    await settle()
    expect(a).toEqual({ done: true, value: true })
    expect(log).not.toHaveBeenCalled()

    const b = track(jobs.assign('s-2', 77))
    expect(helpers).toHaveLength(1)
    helpers[0]!.say('fail s-2 5\r\n')
    await settle()
    expect(b).toEqual({ done: true, value: false })
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toMatch(/^openaflow desktop: session s-2 not in a job: error 5$/)
  })

  test('close writes one line and resolves at closed', async () => {
    const { jobs, helpers } = setup()
    const a = track(jobs.assign('s-1', 10))
    helpers[0]!.say('ok s-1\n')
    await settle()
    expect(a.value).toBe(true)
    const c = track(jobs.close('s-1'))
    expect(helpers[0]!.lines()).toEqual(['assign s-1 10', 'close s-1'])
    await settle()
    expect(c.done).toBe(false)
    helpers[0]!.say('closed s-1\r\n')
    await settle()
    expect(c.done).toBe(true)
  })

  test('answers split across chunks, and two at once, reach the right waiters in order', async () => {
    const { jobs, helpers } = setup()
    const a = track(jobs.assign('s-1', 10))
    const b = track(jobs.assign('s-2', 20))
    const c = track(jobs.close('s-1'))
    helpers[0]!.say('ok s')
    await settle()
    expect(a.done).toBe(false)
    helpers[0]!.say('-1\r\nfail s-2 87\r\ncl')
    await settle()
    expect(a.value).toBe(true)
    expect(b.value).toBe(false)
    expect(c.done).toBe(false)
    helpers[0]!.say('osed s-1\r\n')
    await settle()
    expect(c.done).toBe(true)
  })

  test('a 10 s silence makes assign false; the late answer does not answer the next assign', async () => {
    const { jobs, helpers, log } = setup()
    const a = track(jobs.assign('s-1', 10))
    await vi.advanceTimersByTimeAsync(ANSWER_MS - 1)
    expect(a.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(a).toEqual({ done: true, value: false })
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toBe('openaflow desktop: session s-1 not in a job: no answer in 10 s')
    // The helper is slow, not dead: it stays, and no new one starts.
    expect(helpers[0]!.killed).toBe(false)

    const b = track(jobs.assign('s-1', 11))
    expect(helpers).toHaveLength(1)
    helpers[0]!.say('fail s-1 5\n') // the answer to the first line
    await settle()
    expect(b.done).toBe(false)
    helpers[0]!.say('ok s-1\n')
    await settle()
    expect(b.value).toBe(true)
  })

  test('a silent close resolves after its limit and never hangs', async () => {
    const { jobs, helpers } = setup()
    const a = track(jobs.assign('s-1', 10))
    helpers[0]!.say('ok s-1\n')
    await settle()
    expect(a.value).toBe(true)
    const c = track(jobs.close('s-1'))
    await vi.advanceTimersByTimeAsync(CLOSE_MS - 1)
    expect(c.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.done).toBe(true)
  })

  test('a dead helper logs one line, settles its waiters at once, and the next assign starts a new one', async () => {
    const { jobs, helpers, log } = setup()
    const a = track(jobs.assign('s-1', 10))
    const c = track(jobs.close('s-0'))
    helpers[0]!.stderr.emit('data', Buffer.from('Add-Type : Cannot add type.\r\nAt line:1\r\n'))
    helpers[0]!.emit('exit', 1, null)
    helpers[0]!.emit('close', 1, null)
    await settle()
    expect(a).toEqual({ done: true, value: false })
    expect(c.done).toBe(true)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toBe('openaflow desktop: job helper exited (code 1): Add-Type : Cannot add type. At line:1')

    // A close with no live helper starts none.
    const c2 = track(jobs.close('s-1'))
    await settle()
    expect(c2.done).toBe(true)
    expect(helpers).toHaveLength(1)

    const b = track(jobs.assign('s-2', 20))
    expect(helpers).toHaveLength(2)
    expect(helpers[1]!.lines()).toEqual(['assign s-2 20'])
    helpers[1]!.say('ok s-2\n')
    await settle()
    expect(b.value).toBe(true)
  })

  test('a helper that cannot start logs one line and answers false', async () => {
    const { jobs, helpers, log } = setup()
    const a = track(jobs.assign('s-1', 10))
    const err = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })
    helpers[0]!.emit('error', err)
    helpers[0]!.emit('exit', -4058, null)
    await settle()
    expect(a).toEqual({ done: true, value: false })
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toBe('openaflow desktop: job helper exited: spawn powershell.exe ENOENT')

    const throwing = vi.fn<(line: string) => void>()
    const jobs2 = createJobControl({
      spawn: () => {
        throw new Error('EPERM')
      },
      log: throwing,
      platform: 'win32',
    })
    expect(await jobs2.assign('s-1', 10)).toBe(false)
    expect(throwing).toHaveBeenCalledWith('openaflow desktop: job helper exited: EPERM')
  })

  test('a broken pipe to the helper never throws', async () => {
    const { jobs, helpers } = setup()
    const a = track(jobs.assign('s-1', 10))
    expect(() => helpers[0]!.stdin.emit('error', new Error('write EPIPE'))).not.toThrow()
    helpers[0]!.emit('exit', 1, null)
    await settle()
    expect(a.value).toBe(false)
  })

  test('a bad id or pid answers false and writes nothing', async () => {
    const { jobs, helpers } = setup()
    for (const [id, pid] of [
      ['', 10],
      ['a b', 10],
      ['a\nclose b', 10],
      ['x'.repeat(129), 10],
      ['s-1', 0],
      ['s-1', -3],
      ['s-1', 1.5],
      ['s-1', Number.NaN],
      ['s-1', 2 ** 32],
    ] as const) {
      expect(await jobs.assign(id, pid)).toBe(false)
    }
    await jobs.close('a b')
    expect(helpers).toHaveLength(0)
  })

  test('dispose ends the helper input, settles what waits, and later calls start nothing', async () => {
    const { jobs, helpers } = setup()
    const a = track(jobs.assign('s-1', 10))
    const c = track(jobs.close('s-0'))
    jobs.dispose()
    await settle()
    expect(helpers[0]!.stdin.ended).toBe(true)
    expect(a).toEqual({ done: true, value: false })
    expect(c.done).toBe(true)
    expect(await jobs.assign('s-2', 20)).toBe(false)
    await jobs.close('s-2')
    expect(helpers).toHaveLength(1)
    expect(() => jobs.dispose()).not.toThrow()
  })
})

describe('hidden and Windows only', () => {
  test('on Windows the helper starts at the first assign, hidden, as one PowerShell for all sessions', async () => {
    const { jobs, helpers, calls } = setup('win32')
    expect(calls).toHaveLength(0)
    const a = jobs.assign('s-1', 10)
    const b = jobs.assign('s-2', 20)
    expect(calls).toHaveLength(1)
    const { file, args, options } = calls[0]!
    expect(file).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(args).toHaveLength(4)
    expect(options).toEqual({ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le')
    expect(script).toContain('Add-Type')
    expect(script).toContain('CreateJobObject')
    expect(script).toContain('AssignProcessToJobObject')
    expect(script).toMatch(/0x2000/) // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    helpers[0]!.say('ok s-1\nok s-2\n')
    expect(await a).toBe(true)
    expect(await b).toBe(true)
  })

  test.each(['linux', 'darwin'] as const)('on %s nothing starts: assign is false, close and dispose do nothing', async (platform) => {
    const { jobs, calls, log } = setup(platform)
    expect(await jobs.assign('s-1', 10)).toBe(false)
    await jobs.close('s-1')
    jobs.dispose()
    expect(calls).toHaveLength(0)
    expect(log).not.toHaveBeenCalled()
  })
})

// Real processes on Windows: `verify (windows-latest)` runs these. A "session" is a node process with a port; on
// "go" it starts a detached child with its own port. The child starts after the assign, so it is born in the job.
const VICTIM = `
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const [, script, out, role] = process.argv
const server = createServer((s) => s.end()).listen(0, '127.0.0.1', () => {
  const me = JSON.stringify({ pid: process.pid, port: server.address().port })
  if (role === 'child') return writeFileSync(out, me)
  process.stdout.write(me + '\\n')
  process.stdin.once('data', () => {
    spawn(process.execPath, [script, out, 'child'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  })
})
`

type Proc = { pid: number; port: number }

describe.runIf(process.platform === 'win32')('real jobs on Windows', () => {
  let dir = ''
  const pids: number[] = []
  const log: string[] = []
  const helpers: ChildProcess[] = []
  const spawnHelper: SpawnHelper = (file, args, options) => {
    const c = spawn(file, args, { ...options, windowsHide: true })
    helpers.push(c)
    return c
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oaf-jobs-'))
    writeFileSync(join(dir, 'victim.mjs'), VICTIM)
  })
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    }
    for (const h of helpers.splice(0)) h.kill()
    log.length = 0
    rmSync(dir, { recursive: true, force: true })
  })

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const portOpen = (port: number) =>
    new Promise<boolean>((resolve) => {
      const s = connect(port, '127.0.0.1')
      s.once('connect', () => {
        s.destroy()
        resolve(true)
      })
      s.once('error', () => resolve(false))
    })
  async function waitFor(check: () => Promise<boolean> | boolean, what: string, ms = 10_000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await check()) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`timed out: ${what}`)
  }
  async function gone(p: Proc, what: string) {
    await waitFor(async () => !alive(p.pid) && !(await portOpen(p.port)), `${what} (pid ${p.pid}, port ${p.port}) ends`)
  }

  /** Starts a session process; `go()` makes it start its detached child and resolves with the child. */
  async function startSession(name: string) {
    const out = join(dir, `${name}.json`)
    const proc = spawn(process.execPath, [join(dir, 'victim.mjs'), out], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    const self = await new Promise<Proc>((resolve, reject) => {
      let text = ''
      proc.stdout.on('data', (c: Buffer) => {
        text += c.toString()
        if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]!) as Proc)
      })
      proc.once('exit', (code) => reject(new Error(`session ${name} exited early: ${code}`)))
    })
    pids.push(self.pid)
    const go = async () => {
      proc.stdin.write('go\n')
      await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').endsWith('}'), `${name} child starts`)
      const child = JSON.parse(readFileSync(out, 'utf8')) as Proc
      pids.push(child.pid)
      return child
    }
    return { self, go }
  }

  async function assignTimed(jobs: ReturnType<typeof createJobControl>, id: string, pid: number) {
    const t0 = Date.now()
    const ok = await jobs.assign(id, pid)
    console.log(`windows-jobs: assign ${id} took ${Date.now() - t0} ms: ${ok}`)
    expect(ok, `assign ${id} failed. Log:\n${log.join('\n')}`).toBe(true)
  }

  test('close ends the job', async () => {
    const jobs = createJobControl({ spawn: spawnHelper, log: (l) => log.push(l) })
    const a = await startSession('a')
    const other = await startSession('other')
    await assignTimed(jobs, 'a', a.self.pid)
    const aChild = await a.go()
    const otherChild = await other.go()
    expect(alive(aChild.pid) && (await portOpen(aChild.port))).toBe(true)

    await jobs.close('a')
    await gone(a.self, 'the assigned process')
    await gone(aChild, 'its detached child')
    // Only that job: a session that isn't in it still runs.
    expect(alive(other.self.pid) && alive(otherChild.pid)).toBe(true)
    expect(await portOpen(otherChild.port)).toBe(true)
    jobs.dispose()
    expect(log).toEqual([])
  }, 60_000)

  test('helper exit ends the jobs', async () => {
    const jobs = createJobControl({ spawn: spawnHelper, log: (l) => log.push(l) })
    const a = await startSession('a')
    const b = await startSession('b')
    await assignTimed(jobs, 'a', a.self.pid)
    await assignTimed(jobs, 'b', b.self.pid)
    const aChild = await a.go()
    const bChild = await b.go()
    expect(helpers).toHaveLength(1)

    helpers[0]!.kill()
    for (const [p, what] of [
      [a.self, 'session a'],
      [aChild, "a's child"],
      [b.self, 'session b'],
      [bChild, "b's child"],
    ] as const) {
      await gone(p, what)
    }
    await waitFor(() => log.length > 0, 'the helper exit is logged')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatch(/^openaflow desktop: job helper exited/)

    // The next assign starts a new helper.
    const c = await startSession('c')
    await assignTimed(jobs, 'c', c.self.pid)
    expect(helpers).toHaveLength(2)
    jobs.dispose()
    await gone(c.self, 'session c after dispose')
  }, 90_000)
})
