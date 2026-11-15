import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { procReader, readStat } from './proc-scan.ts'
import {
  createSessionEnder,
  HUP_WAIT_MS,
  LEFT_CHECK_MS,
  realEnderOs,
  STOP_LIMIT_MS,
  TERM_WAIT_MS,
  WINDOWS_WAIT_MS,
  type EnderOs,
  type JobControl,
  type Signal,
} from './session-ender.ts'

const MARKER = '6f1c2a9e-1111-4222-8333-944455556666'
const MAIN = process.pid
const PARENT = process.ppid
const HOST = 900
const SERVER = 901

type Proc = {
  pid: number
  ppid: number
  pgid: number
  start: number
  env?: string[]
  /** The signals it ignores. */
  ignores?: Signal[]
  /** It ends this long after a signal it doesn't ignore. */
  dieAfterMs?: number
}

const marked = [`OPENAFLOW_RUN=${MARKER}`]

/** A fake OS: a process table that `kill` changes, and one ordered list of what was asked. */
function fakeOs(procs: Proc[]) {
  const table = new Map(procs.map((p) => [p.pid, { ...p }]))
  const calls: string[] = []
  let stop: { resolve(): void; reject(err: Error): void; limit: number } | undefined
  const deliver = (p: Proc, sig: Signal) => {
    if (sig !== 'SIGKILL' && p.ignores?.includes(sig)) return
    const end = () => {
      if (table.get(p.pid) === p) table.delete(p.pid)
    }
    if (p.dieAfterMs && sig !== 'SIGKILL') setTimeout(end, p.dieAfterMs)
    else end()
  }
  const os: EnderOs & { calls: string[]; table: typeof table } = {
    calls,
    table,
    proc: {
      pids: () => {
        calls.push('scan')
        return [...table.keys()]
      },
      stat(pid) {
        const p = table.get(pid)
        if (!p) return null
        return `${pid} (node) S ${p.ppid} ${p.pgid} ${p.pgid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${p.start} 1000 10\n`
      },
      environ(pid) {
        const p = table.get(pid)
        return p ? (p.env ?? ['PATH=/usr/bin']).map((e) => `${e}\0`).join('') : null
      },
    },
    kill(pid, sig) {
      calls.push(`${sig} ${pid}`)
      const targets = pid < 0 ? [...table.values()].filter((p) => p.pgid === -pid) : [table.get(pid)].filter((p) => p !== undefined)
      if (targets.length === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      for (const p of targets) deliver(p, sig)
    },
    runStop(argv, limit) {
      calls.push(`stop ${argv.join(' ')}`)
      return new Promise((resolve, reject) => {
        stop = { resolve, reject, limit }
      })
    },
    taskkill: vi.fn(async (pid: number) => {
      calls.push(`taskkill ${pid}`)
      table.delete(pid)
    }),
    alive: (pid) => table.has(pid),
  }
  return { os, stopCall: () => stop }
}

/** The usual session: a group leader with a child, a detached child, and a marked orphan. */
const tree = (o: { ignore?: Signal[] } = {}): Proc[] => [
  { pid: 1, ppid: 0, pgid: 1, start: 1 },
  { pid: HOST, ppid: MAIN, pgid: HOST, start: 50 },
  { pid: 1000, ppid: HOST, pgid: 1000, start: 100, env: marked },
  { pid: 1001, ppid: 1000, pgid: 1000, start: 101, env: marked, ignores: o.ignore?.filter((s) => s === 'SIGHUP') },
  { pid: 1002, ppid: 1000, pgid: 1002, start: 102, env: marked, ignores: o.ignore },
  { pid: 1004, ppid: 1, pgid: 1004, start: 104, env: marked, ignores: o.ignore },
]

function setup(procs: Proc[], o: { platform?: NodeJS.Platform; jobs?: JobControl } = {}) {
  const { os, stopCall } = fakeOs(procs)
  const log = vi.fn()
  const ender = createSessionEnder({
    platform: o.platform ?? 'linux',
    os,
    jobs: o.jobs,
    protectedPids: () => [HOST, SERVER],
    log,
  })
  return { os, stopCall, log, ender }
}

/** Runs `p` under fake timers and answers how long it took. */
async function timed(p: Promise<void>, stepMs = 50, capMs = 20_000) {
  const t0 = Date.now()
  let done = false
  void p.then(() => (done = true))
  while (!done && Date.now() - t0 < capMs) await vi.advanceTimersByTimeAsync(stepMs)
  expect(done).toBe(true)
  return Date.now() - t0
}

const signals = (calls: string[]) => calls.filter((c) => /^SIG/.test(c))

describe('fake OS', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('linux order', async () => {
    const { os, stopCall, log, ender } = setup(tree({ ignore: ['SIGHUP', 'SIGTERM'] }))
    const p = ender.end(MARKER, 1000, ['/usr/bin/systemctl', '--user', 'stop', 'x.scope'])
    stopCall()?.resolve()
    const ms = await timed(p)
    const order = os.calls.filter((c, i, all) => c !== 'scan' || all.indexOf('scan') === i)
    expect(order.slice(0, 3)).toEqual(['stop /usr/bin/systemctl --user stop x.scope', 'scan', 'SIGHUP -1000'])
    const firstTerm = order.findIndex((c) => c.startsWith('SIGTERM'))
    const firstKill = order.findIndex((c) => c.startsWith('SIGKILL'))
    expect(firstTerm).toBeGreaterThan(2)
    expect(firstKill).toBeGreaterThan(firstTerm)
    expect(order).toContain('SIGTERM -1000')
    expect(order).toContain('SIGTERM 1004')
    expect(order).toContain('SIGKILL 1002')
    expect(order).toContain('SIGKILL 1004')
    expect(os.table.has(1002) || os.table.has(1004)).toBe(false)
    expect(ms).toBeGreaterThanOrEqual(HUP_WAIT_MS + TERM_WAIT_MS)
    expect(ms).toBeLessThanOrEqual(HUP_WAIT_MS + TERM_WAIT_MS + LEFT_CHECK_MS + 200)
    expect(log).not.toHaveBeenCalled()
  })

  test('linux order: all gone after SIGHUP ends the waits early and sends nothing more', async () => {
    const { os, ender } = setup([
      { pid: 1000, ppid: HOST, pgid: 1000, start: 100, env: marked },
      { pid: 1001, ppid: 1000, pgid: 1000, start: 101 },
    ])
    const ms = await timed(ender.end(MARKER, 1000))
    expect(signals(os.calls)).toEqual(['SIGHUP -1000'])
    expect(ms).toBeLessThan(500)
  })

  test('linux order: a group that ends at SIGTERM sends no SIGKILL', async () => {
    const { os, ender } = setup(tree({ ignore: ['SIGHUP'] }))
    const ms = await timed(ender.end(MARKER, 1000))
    expect(signals(os.calls).some((c) => c.startsWith('SIGKILL'))).toBe(false)
    expect(ms).toBeGreaterThanOrEqual(HUP_WAIT_MS)
    expect(ms).toBeLessThan(HUP_WAIT_MS + 500)
  })

  test('linux order: survivors after SIGKILL log one line', async () => {
    const procs = tree()
    const { os, log, ender } = setup(procs)
    // A process in uninterruptible sleep: no signal ends it.
    os.kill = vi.fn((pid: number, sig: Signal) => void os.calls.push(`${sig} ${pid}`))
    await timed(ender.end(MARKER, 1000))
    expect(log.mock.calls).toEqual([['openaflow desktop: session 6f1c2a9e left 4 processes']])
  })

  test('never signals', async () => {
    const { os, ender } = setup([
      { pid: 1, ppid: 0, pgid: 1, start: 1, env: marked },
      { pid: MAIN, ppid: PARENT, pgid: MAIN, start: 2, env: marked },
      { pid: PARENT, ppid: 1, pgid: PARENT, start: 3, env: marked },
      { pid: HOST, ppid: MAIN, pgid: MAIN, start: 4, env: marked },
      { pid: SERVER, ppid: MAIN, pgid: MAIN, start: 5, env: marked },
      { pid: 1000, ppid: HOST, pgid: 1000, start: 100, env: marked, ignores: ['SIGHUP', 'SIGTERM'] },
      { pid: 1005, ppid: 1, pgid: 1005, start: 105, env: marked },
    ])
    // 1005 ends after the snapshot, and a new process takes its pid.
    const p = ender.end(MARKER, 1000)
    os.table.set(1005, { pid: 1005, ppid: 1, pgid: 1005, start: 999, env: marked })
    await timed(p)
    const hit = signals(os.calls).map((c) => Number(c.split(' ')[1]))
    for (const pid of [1, -1, 0, MAIN, -MAIN, PARENT, -PARENT, HOST, -HOST, SERVER, -SERVER, 1005, -1005]) expect(hit).not.toContain(pid)
    expect(hit).toContain(1000)
  })

  test('never signals: a root in main’s group, or pid 1, gets no group signal', async () => {
    const { os, ender } = setup([
      { pid: MAIN, ppid: PARENT, pgid: MAIN, start: 2 },
      { pid: 1000, ppid: MAIN, pgid: MAIN, start: 100, env: marked },
    ])
    await timed(ender.end(MARKER, 1000))
    expect(signals(os.calls).every((c) => !c.includes(' -'))).toBe(true)
    expect(signals(os.calls)).toContain('SIGHUP 1000')
    const one = setup([{ pid: 1, ppid: 0, pgid: 1, start: 1, env: marked }])
    await timed(one.ender.end(MARKER, 1))
    expect(signals(one.os.calls)).toEqual([])
  })

  test('stop command edges', async () => {
    // Fails: one line, and the signals go on.
    const a = setup(tree())
    const pa = a.ender.end(MARKER, 1000, ['/bin/false'])
    a.stopCall()?.reject(new Error('exit 1'))
    await timed(pa)
    expect(signals(a.os.calls)[0]).toBe('SIGHUP -1000')
    expect(a.log.mock.calls).toEqual([['openaflow desktop: session 6f1c2a9e stop command failed: exit 1']])
    // Hangs: the runner is told to give up at 6 s, and the end is done within 7 s.
    const b = setup(tree({ ignore: ['SIGHUP', 'SIGTERM'] }))
    const pb = b.ender.end(MARKER, 1000, ['/usr/bin/sleep', '60'])
    const call = b.stopCall()
    expect(call?.limit).toBe(STOP_LIMIT_MS)
    setTimeout(() => call?.reject(new Error('no exit in 6 s')), STOP_LIMIT_MS)
    const ms = await timed(pb)
    expect(ms).toBeLessThanOrEqual(7_000)
    expect(signals(b.os.calls)).toContain('SIGKILL 1004')
    expect(b.log.mock.calls).toEqual([['openaflow desktop: session 6f1c2a9e stop command failed: no exit in 6 s']])
    // A runner that throws at once counts as a failure too.
    const c = setup(tree())
    c.os.runStop = () => {
      throw new Error('ENOENT')
    }
    await timed(c.ender.end(MARKER, 1000, ['/missing']))
    expect(c.log.mock.calls).toEqual([['openaflow desktop: session 6f1c2a9e stop command failed: ENOENT']])
    expect(signals(c.os.calls)[0]).toBe('SIGHUP -1000')
  })

  test('no pid', async () => {
    const a = setup(tree())
    await timed(a.ender.end(MARKER, 0))
    expect(signals(a.os.calls).some((c) => c.startsWith('SIGHUP'))).toBe(false)
    expect(signals(a.os.calls).sort()).toEqual(['SIGTERM 1000', 'SIGTERM 1001', 'SIGTERM 1002', 'SIGTERM 1004'])

    const b = setup(tree({ ignore: ['SIGTERM'] }).filter((p) => p.pid !== 1000 && p.pid !== 1001))
    const pb = b.ender.sweep(MARKER, ['/usr/bin/systemctl', '--user', 'stop', 'x.scope'])
    b.stopCall()?.resolve()
    const ms = await timed(pb)
    expect(b.os.calls[0]).toBe('stop /usr/bin/systemctl --user stop x.scope')
    expect(signals(b.os.calls)).toEqual(['SIGTERM 1002', 'SIGTERM 1004', 'SIGKILL 1002', 'SIGKILL 1004'])
    expect(ms).toBeGreaterThanOrEqual(TERM_WAIT_MS)
    expect(ms).toBeLessThanOrEqual(TERM_WAIT_MS + LEFT_CHECK_MS + 200)

    // Nothing holds the marker: no signal, no line, no wait.
    const c = setup([{ pid: 2000, ppid: 1, pgid: 2000, start: 200 }])
    expect(await timed(c.ender.sweep(MARKER))).toBeLessThan(100)
    expect(signals(c.os.calls)).toEqual([])
    expect(c.log).not.toHaveBeenCalled()
  })

  test('windows', async () => {
    const order: string[] = []
    const jobs: JobControl = {
      assign: vi.fn(async () => true),
      close: vi.fn(async (id: string) => void order.push(`close ${id}`)),
      dispose: vi.fn(),
    }
    const a = setup([{ pid: 4000, ppid: 1, pgid: 4000, start: 1 }], { platform: 'win32', jobs })
    a.os.taskkill = vi.fn(async (pid: number) => {
      order.push(`taskkill ${pid}`)
      a.os.table.delete(pid)
    })
    await timed(a.ender.end(MARKER, 4000, ['/usr/bin/systemctl']))
    expect(order).toEqual([`close ${MARKER}`, 'taskkill 4000'])
    expect(a.os.calls.some((c) => c.startsWith('stop') || c === 'scan' || c.startsWith('SIG'))).toBe(false)
    expect(a.log).not.toHaveBeenCalled()

    // A survivor: taskkill ends nothing; one line after 3 s.
    const b = setup([{ pid: 4001, ppid: 1, pgid: 4001, start: 1 }], { platform: 'win32', jobs })
    b.os.taskkill = vi.fn(async () => {})
    const ms = await timed(b.ender.end(MARKER, 4001))
    expect(ms).toBeGreaterThanOrEqual(WINDOWS_WAIT_MS)
    expect(ms).toBeLessThan(WINDOWS_WAIT_MS + 300)
    expect(b.log.mock.calls).toEqual([['openaflow desktop: session 6f1c2a9e left 1 processes']])

    // Pid 0 and a sweep only close the job; a hung taskkill still ends the wait at 3 s.
    order.length = 0
    const c = setup([], { platform: 'win32', jobs })
    await timed(c.ender.end(MARKER, 0))
    await timed(c.ender.sweep(MARKER))
    expect(order).toEqual([`close ${MARKER}`, `close ${MARKER}`])
    expect(c.os.taskkill).not.toHaveBeenCalled()
    const d = setup([{ pid: 4002, ppid: 1, pgid: 4002, start: 1 }], { platform: 'win32', jobs })
    d.os.taskkill = () => new Promise(() => {})
    expect(await timed(d.ender.end(MARKER, 4002))).toBeLessThan(WINDOWS_WAIT_MS + 300)

    // A job close that fails logs one line and the taskkill goes on; a protected pid is never taken.
    const e = setup([{ pid: SERVER, ppid: 1, pgid: SERVER, start: 1 }], {
      platform: 'win32',
      jobs: { ...jobs, close: async () => Promise.reject(new Error('helper gone')) },
    })
    await timed(e.ender.end(MARKER, SERVER))
    expect(e.os.taskkill).not.toHaveBeenCalled()
    expect(e.log.mock.calls).toEqual([['openaflow desktop: session 6f1c2a9e job close failed: helper gone']])
  })
})

// ---- Real processes (Linux). Every process here is one this test started, in its own group and marked. ----

const SCRIPT = `
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
const me = fileURLToPath(import.meta.url)
const [role, out, clear] = process.argv.slice(2)
const report = (o) => appendFileSync(out, JSON.stringify({ role, pid: process.pid, ...o }) + '\\n')
const listen = () => new Promise((r) => { const s = createServer((c) => c.end()); s.listen(0, '127.0.0.1', () => r(s.address().port)) })
const keep = () => setInterval(() => {}, 1000)
const env = clear === 'clear' ? {} : process.env
if (role === 'leader') {
  spawn(process.execPath, [me, 'child', out], { stdio: 'ignore', windowsHide: true })
  // In a scope, a child that ignores SIGTERM would hold \`systemctl stop\` past its limit.
  if (clear !== 'clear') spawn(process.execPath, [me, 'stubborn', out], { stdio: 'ignore', windowsHide: true })
  spawn(process.execPath, [me, 'launcher', out, clear ?? ''], { stdio: 'ignore', detached: true, env, windowsHide: true })
  report({}); keep()
} else if (role === 'stubborn') {
  process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {})
  report({ port: await listen() }); keep()
} else if (role === 'launcher') {
  const c = spawn(process.execPath, [me, 'orphan', out], { stdio: 'ignore', detached: true, env, windowsHide: true })
  c.unref(); report({ orphan: c.pid }); process.exit(0)
} else if (role === 'orphan') {
  report({ port: await listen() }); keep()
} else { report({}); keep() }
`

type Line = { role: string; pid: number; port?: number }

const findOnPath = (name: string) => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return join(dir, name)
    } catch {
      // Not here.
    }
  }
  return undefined
}

/** §6's probe, here only to decide whether the scope case can run. */
function probeScope(): { ok: true; run: string; ctl: string } | { ok: false; reason: string } {
  if (process.platform !== 'linux') return { ok: false, reason: 'not Linux' }
  const run = findOnPath('systemd-run')
  const ctl = findOnPath('systemctl')
  const yes = findOnPath('true')
  if (!run || !ctl || !yes) return { ok: false, reason: 'systemd-run, systemctl, or true is not on PATH' }
  const r = spawnSync(run, ['--user', '--scope', '--quiet', yes], { timeout: 5_000, stdio: 'pipe', windowsHide: true })
  if (r.status !== 0) return { ok: false, reason: `the probe answered ${r.error?.message ?? `exit ${r.status}`}: ${String(r.stderr).trim()}` }
  return { ok: true, run, ctl }
}

const portRefused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect(port, '127.0.0.1')
    s.once('connect', () => {
      s.destroy()
      resolve(false)
    })
    s.once('error', () => resolve(true))
  })

describe.runIf(process.platform === 'linux')('real processes', () => {
  let dir = ''
  let leader: ChildProcess | undefined
  /** pid → start time of every process the tree reported, for the cleanup. */
  const started = new Map<number, string>()
  const proc = procReader()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openaflow-ender-'))
    writeFileSync(join(dir, 'tree.mjs'), SCRIPT)
  })

  afterEach(() => {
    // Ends only what this test started and still runs with the same start time.
    for (const [pid, start] of started) {
      if (readStat(proc, pid)?.startTime === start) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Gone.
        }
      }
    }
    started.clear()
    leader = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  const lines = (): Line[] => {
    try {
      return readFileSync(join(dir, 'out.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line)
    } catch {
      return []
    }
  }

  /** Waits until each role has reported and the orphan's launcher is gone. */
  async function ready(roles: string[]) {
    const until = Date.now() + 15_000
    for (;;) {
      const got = lines()
      const launcher = got.find((l) => l.role === 'launcher')
      if (roles.every((r) => got.some((l) => l.role === r)) && (!launcher || readStat(proc, launcher.pid) === null)) {
        for (const l of got) {
          const s = readStat(proc, l.pid)
          if (s) started.set(l.pid, s.startTime)
        }
        return Object.fromEntries(got.map((l) => [l.role, l])) as Record<string, Line>
      }
      if (Date.now() > until) throw new Error(`the tree didn't start: ${JSON.stringify(got)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  const gone = (pid: number) => readStat(proc, pid)?.startTime !== started.get(pid)

  test('real tree ends', async () => {
    const marker = randomUUID()
    leader = spawn(process.execPath, [join(dir, 'tree.mjs'), 'leader', join(dir, 'out.jsonl')], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
      env: { ...process.env, OPENAFLOW_RUN: marker },
    })
    const t = await ready(['leader', 'child', 'stubborn', 'launcher', 'orphan'])
    expect(readStat(proc, t.orphan!.pid)?.ppid).not.toBe(t.leader!.pid)
    const os = realEnderOs()
    const sent: string[] = []
    const kill = os.kill
    os.kill = (pid, sig) => {
      sent.push(`${sig} ${pid}`)
      kill(pid, sig)
    }
    const log = vi.fn()
    const ender = createSessionEnder({ platform: 'linux', os, protectedPids: () => [], log })
    const t0 = Date.now()
    await ender.end(marker, leader.pid!)
    expect(Date.now() - t0).toBeLessThan(7_500)
    for (const role of ['leader', 'child', 'stubborn', 'orphan']) expect(gone(t[role]!.pid), role).toBe(true)
    expect(sent).toContain(`SIGHUP -${t.leader!.pid}`)
    expect(sent).toContain(`SIGKILL ${t.stubborn!.pid}`)
    expect(await portRefused(t.stubborn!.port!)).toBe(true)
    expect(await portRefused(t.orphan!.port!)).toBe(true)
    expect(log).not.toHaveBeenCalled()
  }, 30_000)

  const scope = probeScope()
  if (!scope.ok) console.log(`session-ender › real scope skipped: ${scope.reason}`)

  test.runIf(scope.ok)('real scope', async () => {
    if (!scope.ok) return
    const marker = randomUUID()
    const unit = `openaflow-run-${marker}.scope`
    try {
      leader = spawn(scope.run, ['--user', '--scope', '--quiet', `--unit=${unit}`, process.execPath, join(dir, 'tree.mjs'), 'leader', join(dir, 'out.jsonl'), 'clear'], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
        env: { ...process.env, OPENAFLOW_RUN: marker },
      })
      const t = await ready(['leader', 'child', 'launcher', 'orphan'])
      // The orphan cleared its env and left the tree: only the scope still holds it.
      expect(readFileSync(`/proc/${t.orphan!.pid}/environ`, 'latin1')).not.toContain(marker)
      expect(readStat(proc, t.orphan!.pid)?.ppid).not.toBe(t.leader!.pid)
      const log = vi.fn()
      const ender = createSessionEnder({ platform: 'linux', os: realEnderOs(), protectedPids: () => [], log })
      await ender.end(marker, leader.pid!, [scope.ctl, '--user', 'stop', unit])
      const until = Date.now() + 2_000
      while (!gone(t.orphan!.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
      for (const role of ['leader', 'child', 'orphan']) expect(gone(t[role]!.pid), role).toBe(true)
      expect(await portRefused(t.orphan!.port!)).toBe(true)
      expect(log).not.toHaveBeenCalled()
    } finally {
      spawnSync(scope.ctl, ['--user', 'stop', unit], { timeout: 5_000, stdio: 'ignore', windowsHide: true })
    }
  }, 30_000)
})
