import { spawn } from 'node:child_process'
import { resolveBin } from './bin-path.ts'
import { sessionBaseEnv, UUID_V4 } from './session-command.ts'

/** How long the probe's `systemd-run` may take before the probe reads it as off. */
export const SCOPE_PROBE_MS = 5_000

/** Whether sessions run in a systemd user scope, with the tools' absolute paths; or why not. */
export type ScopeProbe = { on: true; systemdRun: string; systemctl: string } | { on: false; reason: string }

/** A start's program and args, wrapped; `stop` ends everything in the session's scope. */
export type WrappedStart = { program: string; args: string[]; stop?: string[] }

export type ScopeProbeInput = {
  /** The server's own env; the probe runs with the env a session gets from it. */
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  log: (line: string) => void
  /** Tests only. Left out: `SCOPE_PROBE_MS`. */
  timeoutMs?: number
}

/**
 * The server start's scope probe: the first call runs `<systemd-run> --user --scope --quiet <true>` with the env
 * a session gets, and every later call shares its answer, on or off. Exit 0 is on. Anything else, or a tool not
 * found as an absolute path on PATH, is off, with one log line. Windows and macOS are off with no run and no line.
 * Create one per server start.
 */
export function scopeProbe(o: ScopeProbeInput): () => Promise<ScopeProbe> {
  let answer: Promise<ScopeProbe> | undefined
  return () => (answer ??= probeOnce(o))
}

async function probeOnce(o: ScopeProbeInput): Promise<ScopeProbe> {
  if (o.platform !== 'linux') return { on: false, reason: `not on Linux (${o.platform})` }
  const reason = await whyOff(o)
  if (typeof reason !== 'string') return reason
  o.log(`openaflow: sessions run with no systemd scope: ${reason}`)
  return { on: false, reason }
}

async function whyOff(o: ScopeProbeInput): Promise<ScopeProbe | string> {
  const env = sessionBaseEnv(o.env, 'linux')
  const tools = { 'systemd-run': '', systemctl: '', true: '' }
  for (const name of Object.keys(tools) as (keyof typeof tools)[]) {
    const found = resolveBin(name, env, 'linux')
    if (found === undefined) return `${name} not found`
    tools[name] = found
  }
  const word = await run(tools['systemd-run'], ['--user', '--scope', '--quiet', tools.true], env, o.timeoutMs ?? SCOPE_PROBE_MS)
  return word === 'exit 0' ? { on: true, systemdRun: tools['systemd-run'], systemctl: tools.systemctl } : word
}

/** `exit 0`; `exit <code>` or `killed by <signal>`, with stderr's first line; `no answer in 5 s`; or `could not start: <code>`. */
function run(file: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let err = ''
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let killed = false
    const child = spawn(file, args, { env, cwd: '/', stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    // Settles once. A child the probe started may hold stderr open, so the limit never waits for `close`.
    const done = (word: string) => {
      clearTimeout(timer)
      clearTimeout(reaped)
      child.stderr.destroy()
      resolve(word)
    }
    const exitWord = (): string => {
      if (exit?.code === 0) return 'exit 0'
      const line = err.split('\n').map((l) => l.trim()).find((l) => l !== '')?.slice(0, 200)
      const head = exit?.code === null || exit === undefined ? `killed by ${exit?.signal}` : `exit ${exit.code}`
      return line === undefined ? head : `${head}: ${line}`
    }
    const late = `no answer in ${timeoutMs / 1000} s`
    let reaped: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      if (exit !== undefined) return done(exitWord())
      // Answer once the killed child is gone, or a second later at most.
      killed = true
      child.kill('SIGKILL')
      reaped = setTimeout(() => done(late), 1000)
    }, timeoutMs)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      if (err.length < 4096) err += d
    })
    child.on('error', (e: NodeJS.ErrnoException) => done(`could not start: ${e.code ?? e.message}`))
    child.on('exit', (code, signal) => {
      exit = { code, signal }
      if (killed) done(late)
    })
    child.on('close', () => done(killed ? late : exitWord()))
  })
}

/**
 * The start for `cmd`, inside the transient user scope `openaflow-run-<marker>.scope` when the probe is on, with
 * the stop that ends that scope. Off, or a marker that isn't a run id (it names the unit): `cmd` as it is, no stop.
 */
export function wrapStart(cmd: { program: string; args: string[] }, marker: string, probe: ScopeProbe): WrappedStart {
  if (!probe.on || !UUID_V4.test(marker)) return { program: cmd.program, args: cmd.args }
  const unit = `openaflow-run-${marker}.scope`
  return {
    program: probe.systemdRun,
    args: ['--user', '--scope', '--quiet', `--unit=${unit}`, cmd.program, ...cmd.args],
    stop: [probe.systemctl, '--user', 'stop', unit],
  }
}
