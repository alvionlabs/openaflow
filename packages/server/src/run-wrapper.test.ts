import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SCOPE_PROBE_MS, scopeProbe, wrapStart, type ScopeProbe } from './run-wrapper.ts'

const WIN = process.platform === 'win32'
const MARKER = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d'
const ON: ScopeProbe = { on: true, systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl' }
const CMD = { program: '/home/me/.local/bin/claude', args: ['--resume', 'x y', '--plugin-dir', '/opt/hooks plugin'] }

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A folder of fake tools: `systemd-run` writes its args, env, and pid beside it, then does what `body` says. */
function fakeTools(root: string, name: string, o: { systemdRun?: string; systemctl?: boolean; true?: boolean }): string {
  const dir = join(root, name)
  mkdirSync(dir)
  const tool = (file: string, body: string) => {
    writeFileSync(join(dir, file), `#!/bin/sh\n${body}\n`)
    chmodSync(join(dir, file), 0o755)
  }
  if (o.systemdRun !== undefined) {
    tool('systemd-run', `echo $$ >> '${dir}/runs'\nprintf '%s\\n' "$@" > '${dir}/args'\n${sys('env')} > '${dir}/env'\n${o.systemdRun}`)
  }
  if (o.systemctl !== false) tool('systemctl', 'exit 0')
  if (o.true !== false) tool('true', 'exit 0')
  return dir
}

/** A system tool's absolute path: the fakes run with a PATH that holds only their own folder. */
const sys = (name: string): string => (WIN ? name : spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8', windowsHide: true }).stdout.trim())

const runs = (dir: string): number[] => (existsSync(join(dir, 'runs')) ? readFileSync(join(dir, 'runs'), 'utf8').trim().split('\n').map(Number) : [])

describe('wrapper and probe', () => {
  test('on: the program runs under systemd-run in the marker unit, and stop names the same unit', () => {
    const w = wrapStart(CMD, MARKER, ON)
    expect(w.program).toBe('/usr/bin/systemd-run')
    expect(w.args).toEqual(['--user', '--scope', '--quiet', `--unit=openaflow-run-${MARKER}.scope`, ...[CMD.program, ...CMD.args]])
    expect(w.stop).toEqual(['/usr/bin/systemctl', '--user', 'stop', `openaflow-run-${MARKER}.scope`])
    // the stop rules of the server-main contract: 1 to 32 strings, each 1,024 characters at most, the first absolute
    expect(w.stop!.length).toBeGreaterThanOrEqual(1)
    expect(w.stop!.length).toBeLessThanOrEqual(32)
    for (const s of w.stop!) expect(s.length).toBeLessThanOrEqual(1024)
    expect(w.stop![0]!.startsWith('/')).toBe(true)
    expect(CMD.args).toHaveLength(4) // the input is left alone
  })

  test('off: the command as it is, with no stop', () => {
    const w = wrapStart(CMD, MARKER, { on: false, reason: 'exit 1' })
    expect(w).toEqual({ program: CMD.program, args: CMD.args })
    expect('stop' in w).toBe(false)
  })

  test('a marker that is not a run id gets no wrapper', () => {
    expect(wrapStart(CMD, MARKER, ON).stop).toBeDefined()
    for (const bad of ['', 'abc', MARKER.toUpperCase(), `${MARKER}.scope`, '../x', `${MARKER} --x`]) {
      const w = wrapStart(CMD, bad, ON)
      expect(w, bad).toEqual({ program: CMD.program, args: CMD.args })
    }
  })

  test('the probe limit is 5 s', () => {
    expect(SCOPE_PROBE_MS).toBe(5000)
  })

  test('Windows and macOS are off and log nothing', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const lines: string[] = []
      const p = await scopeProbe({ env: { PATH: '/usr/bin' }, platform, log: (l) => lines.push(l) })()
      expect(p, platform).toEqual({ on: false, reason: `not on Linux (${platform})` })
      expect(lines, platform).toEqual([])
    }
  })

  describe.skipIf(WIN)('with fake tools', () => {
    let root: string
    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'oaf-run-wrapper-')))
    })
    afterAll(() => rmSync(root, { recursive: true, force: true }))

    const probe = (dir: string, extra: NodeJS.ProcessEnv = {}, timeoutMs?: number) => {
      const lines: string[] = []
      const env = { PATH: `${dir}:relative/bin`, HOME: '/home/me', ...extra }
      return scopeProbe({ env, platform: 'linux', log: (l) => lines.push(l), ...(timeoutMs ? { timeoutMs } : {}) })().then((p) => ({ p, lines }))
    }

    test('exit 0: on, with the tools found on PATH, run as systemd-run --user --scope --quiet <true> in a session env', async () => {
      const dir = fakeTools(root, 'ok', { systemdRun: 'exit 0' })
      const { p, lines } = await probe(dir, {
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        ANTHROPIC_API_KEY: 'fake',
        CLAUDECODE: '1',
        OPENAFLOW_CONFIG_DIR: '/tmp/cfg',
      })
      expect(p).toEqual({ on: true, systemdRun: join(dir, 'systemd-run'), systemctl: join(dir, 'systemctl') })
      expect(lines).toEqual([])
      expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual(['--user', '--scope', '--quiet', join(dir, 'true')])
      const env = readFileSync(join(dir, 'env'), 'utf8').split('\n')
      expect(env).toContain('XDG_RUNTIME_DIR=/run/user/1000')
      expect(env).toContain('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus')
      expect(env).toContain(`PATH=${dir}`) // relative entries dropped, as a session's
      expect(env.filter((l) => /^(ANTHROPIC_|CLAUDE|OPENAFLOW_)/.test(l))).toEqual([])
    })

    test('exit 1: off, with one line that holds the reason', async () => {
      const dir = fakeTools(root, 'fail', { systemdRun: 'echo "Failed to connect to bus: No medium found" >&2\nexit 1' })
      const { p, lines } = await probe(dir)
      expect(p).toEqual({ on: false, reason: 'exit 1: Failed to connect to bus: No medium found' })
      expect(lines).toEqual(['openaflow: sessions run with no systemd scope: exit 1: Failed to connect to bus: No medium found'])
    })

    test('a hang past the limit: off, and the probe process is killed', async () => {
      const dir = fakeTools(root, 'hang', { systemdRun: `exec ${sys('sleep')} 30` })
      const started = Date.now()
      const { p, lines } = await probe(dir, {}, 300)
      expect(Date.now() - started).toBeLessThan(3000)
      expect(p).toEqual({ on: false, reason: 'no answer in 0.3 s' })
      expect(lines).toEqual(['openaflow: sessions run with no systemd scope: no answer in 0.3 s'])
      const [pid] = runs(dir)
      expect(pid).toBeGreaterThan(1)
      expect(alive(pid!)).toBe(false)
    })

    test('a hang whose child holds stderr open still answers at the limit', async () => {
      const dir = fakeTools(root, 'hold', { systemdRun: `${sys('sleep')} 30 &\necho $! > '${root}/held'\nwait` })
      try {
        const late = new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), 3000))
        const answer = await Promise.race([probe(dir, {}, 300).then((a) => a.p), late])
        expect(answer).toEqual({ on: false, reason: 'no answer in 0.3 s' })
        expect(alive(runs(dir)[0]!)).toBe(false)
      } finally {
        const held = Number(readFileSync(join(root, 'held'), 'utf8'))
        if (held > 1 && alive(held)) process.kill(held, 'SIGKILL')
      }
    }, 10_000)

    test('the default limit is 5 s', async () => {
      const dir = fakeTools(root, 'hang-default', { systemdRun: `exec ${sys('sleep')} 30` })
      const started = Date.now()
      const { p } = await probe(dir)
      const took = Date.now() - started
      expect(took).toBeGreaterThanOrEqual(4900)
      expect(took).toBeLessThan(8000)
      expect(p).toEqual({ on: false, reason: 'no answer in 5 s' })
    }, 15_000)

    test('a missing tool: off, naming it, and nothing runs', async () => {
      const cases = [
        { name: 'no-run', o: { systemdRun: undefined }, word: 'systemd-run not found' },
        { name: 'no-ctl', o: { systemdRun: 'exit 0', systemctl: false }, word: 'systemctl not found' },
        { name: 'no-true', o: { systemdRun: 'exit 0', true: false }, word: 'true not found' },
      ]
      for (const c of cases) {
        const dir = fakeTools(root, c.name, c.o)
        const { p, lines } = await probe(dir)
        expect(p, c.name).toEqual({ on: false, reason: c.word })
        expect(lines, c.name).toEqual([`openaflow: sessions run with no systemd scope: ${c.word}`])
        expect(runs(dir), c.name).toEqual([])
      }
    })

    test('the same working tools on Windows and macOS: off, and nothing runs', async () => {
      const dir = fakeTools(root, 'other-os', { systemdRun: 'exit 0' })
      expect((await probe(dir)).p.on).toBe(true)
      for (const platform of ['win32', 'darwin'] as const) {
        const lines: string[] = []
        const p = await scopeProbe({ env: { PATH: dir }, platform, log: (l) => lines.push(l) })()
        expect(p.on, platform).toBe(false)
        expect(lines, platform).toEqual([])
      }
      expect(runs(dir)).toHaveLength(1)
    })

    test('tools on a relative PATH entry are not found', async () => {
      const dir = fakeTools(root, 'rel', { systemdRun: 'exit 0' })
      const lines: string[] = []
      const p = await scopeProbe({ env: { PATH: 'rel' }, platform: 'linux', log: (l) => lines.push(l) })()
      expect(p).toEqual({ on: false, reason: 'systemd-run not found' })
      expect(runs(dir)).toEqual([])
    })
  })
})

describe.skipIf(WIN)('probe once', () => {
  let root: string
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oaf-run-wrapper-once-')))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('on: one run for every ask, at once or later', async () => {
    const dir = fakeTools(root, 'on', { systemdRun: 'exit 0' })
    const get = scopeProbe({ env: { PATH: dir }, platform: 'linux', log: () => {} })
    const all = await Promise.all([get(), get(), get()])
    const later = await get()
    expect(runs(dir)).toHaveLength(1)
    for (const p of [...all, later]) expect(p).toBe(all[0])
    expect(later.on).toBe(true)
  })

  test('off: one run and one line, never tried again', async () => {
    const dir = fakeTools(root, 'off', { systemdRun: 'exit 1' })
    const lines: string[] = []
    const get = scopeProbe({ env: { PATH: dir }, platform: 'linux', log: (l) => lines.push(l) })
    await Promise.all([get(), get()])
    await get()
    expect(runs(dir)).toHaveLength(1)
    expect(lines).toEqual(['openaflow: sessions run with no systemd scope: exit 1'])
  })

  test('a new server start probes again', async () => {
    const dir = fakeTools(root, 'again', { systemdRun: 'exit 0' })
    await scopeProbe({ env: { PATH: dir }, platform: 'linux', log: () => {} })()
    await scopeProbe({ env: { PATH: dir }, platform: 'linux', log: () => {} })()
    expect(runs(dir)).toHaveLength(2)
  })
})

describe.runIf(process.platform === 'linux')('real scope', () => {
  test('a wrapped program runs in its unit, and the stop ends it', async (ctx) => {
    const lines: string[] = []
    const probe = await scopeProbe({ env: process.env, platform: 'linux', log: (l) => lines.push(l) })()
    if (!probe.on) {
      console.log(`real scope skipped: ${probe.reason}`)
      ctx.skip(`no systemd user scope: ${probe.reason}`)
      return
    }
    const marker = randomUUID()
    const unit = `openaflow-run-${marker}.scope`
    const sleep = sys('sleep')
    const w = wrapStart({ program: sleep, args: ['60'] }, marker, probe)
    const child = spawn(w.program, w.args, { stdio: 'ignore', windowsHide: true })
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => child.on('exit', (code, signal) => resolve(signal ?? code)))
    try {
      const pid = child.pid!
      let cgroup = ''
      for (let i = 0; i < 50 && !cgroup.includes(unit); i++) {
        await new Promise((r) => setTimeout(r, 100))
        cgroup = existsSync(`/proc/${pid}/cgroup`) ? readFileSync(`/proc/${pid}/cgroup`, 'utf8') : ''
      }
      expect(cgroup).toContain(`/${unit}`)
      expect(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]).toBe(sleep)
      const active = spawnSync(probe.systemctl, ['--user', 'is-active', unit], { encoding: 'utf8', windowsHide: true }).stdout.trim()
      expect(active).toBe('active')

      const stop = spawnSync(w.stop![0]!, w.stop!.slice(1), { encoding: 'utf8', timeout: 6000, windowsHide: true })
      expect(stop.status).toBe(0)
      expect(await exited).toBe('SIGTERM')
      const after = spawnSync(probe.systemctl, ['--user', 'is-active', unit], { encoding: 'utf8', windowsHide: true }).stdout.trim()
      expect(after).not.toBe('active')
    } finally {
      spawnSync(probe.systemctl, ['--user', 'stop', unit], { timeout: 6000, windowsHide: true })
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
})
