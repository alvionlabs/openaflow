import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsoluteFor, resolveBin } from './bin-path.ts'
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

/** Command text limits (sprint settings §3): characters in the text and in each filled word, and words. */
export const COMMAND_TEXT = { maxChars: 1024, maxWords: 32 } as const
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const PLACEHOLDER = /\{([A-Za-z]+)\}/g
const KNOWN = new Set(['runId', 'unit'])
/** A run id that fills placeholders when a text is checked at save. */
const SAMPLE_RUN_ID = '00000000-0000-4000-8000-000000000000'

/** A command text's words, placeholders still in them (none for empty or all-space text); or why it breaks §3. */
export type SplitCommand = { words: string[] } | { error: string }

/**
 * Splits a run wrapper or stop command text. Only a space separates words. `"…"` and `'…'` group, the quotes go,
 * and nothing escapes inside them; quoted and plain parts that touch make one word.
 */
export function splitCommand(text: string): SplitCommand {
  if (CONTROL.test(text)) return { error: 'bad text' }
  if (text.length > COMMAND_TEXT.maxChars) return { error: 'too long' }
  const words: string[] = []
  let word: string | undefined
  let quote: string | undefined
  for (const ch of text) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else word += ch
    } else if (ch === ' ') {
      if (word !== undefined) words.push(word)
      word = undefined
    } else if (ch === '"' || ch === "'") {
      quote = ch
      word ??= ''
    } else {
      word = (word ?? '') + ch
    }
  }
  if (quote !== undefined) return { error: 'unclosed quote' }
  if (word !== undefined) words.push(word)
  if (words.length > COMMAND_TEXT.maxWords) return { error: 'too many words' }
  for (const w of words) for (const m of w.matchAll(PLACEHOLDER)) if (!KNOWN.has(m[1]!)) return { error: `unknown placeholder {${m[1]}}` }
  if (words.length > 0 && words[0] === '') return { error: 'no program' }
  return { words }
}

/** Each word with `{runId}` as the run id and `{unit}` as its scope unit. A filled value never makes a new word. */
export function fillWords(words: readonly string[], runId: string): string[] {
  return words.map((w) => w.replace(PLACEHOLDER, (all, name: string) => (name === 'runId' ? runId : name === 'unit' ? unitOf(runId) : all)))
}

/** The scope unit a run id names. */
export const unitOf = (runId: string) => `openaflow-run-${runId}.scope`

/** Why a text breaks §3, also a filled word over the limit (with a sample run id); `undefined` for a good one. */
export function commandTextError(text: string): string | undefined {
  const split = splitCommand(text)
  if ('error' in split) return split.error
  return fillWords(split.words, SAMPLE_RUN_ID).some((w) => w.length > COMMAND_TEXT.maxChars) ? 'too long' : undefined
}

/**
 * A command's first word as an absolute program: an absolute path to a program file, or a bare name found on the
 * env's PATH. A relative path with a folder (`a/b`) is never looked up: it would resolve against the server's folder.
 */
export function resolveProgram(word: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { program: string } | { error: string } {
  const win = platform === 'win32'
  const bare = !word.includes('/') && !(win && word.includes('\\'))
  const found = bare || isAbsoluteFor(word, win) ? resolveBin(word, env, platform) : undefined
  return found === undefined ? { error: `${word} not found` } : { program: found }
}

/** The default texts per platform (sprint settings §2). Windows has none, and ignores stored texts. */
export const DEFAULT_TEXTS: Record<'linux' | 'other', { runWrapper: string; stopCommand: string }> = {
  linux: { runWrapper: 'systemd-run --user --scope --quiet --unit=openaflow-run-{runId}.scope', stopCommand: 'systemctl --user stop openaflow-run-{runId}.scope' },
  other: { runWrapper: '', stopCommand: '' },
}
export const defaultTexts = (platform: NodeJS.Platform) => (platform === 'linux' ? DEFAULT_TEXTS.linux : DEFAULT_TEXTS.other)

/**
 * What a start wraps its program in, with placeholders still in the words: the wrapper's absolute program and its
 * args, and the stop command's. Neither: the program as it is, with no stop.
 */
export type WrapperPlan = { wrapper?: string[]; stop?: string[] }

/** The settings a plan reads: an absent key is the platform default, `''` none. */
export type WrapperSettings = { runWrapper?: string; stopCommand?: string }

/** The default words with their first word swapped for a tool's absolute path. */
const withProgram = (text: string, program: string): string[] => {
  const { words } = splitCommand(text) as { words: string[] }
  return [program, ...words.slice(1)]
}

/**
 * The run wrapper and stop command at each start (sprint settings §4). Create one per server start: a changed
 * wrapper text that passed its check passes with no check for the rest of this server's life.
 */
export function createRunWrapper(o: { platform: NodeJS.Platform; log: (line: string) => void; timeoutMs?: number; newId?: () => string }) {
  const passed = new Set<string>()
  const newId = o.newId ?? randomUUID

  /** A stored text's words with an absolute program; `[]` for none; or the refusal's word. */
  const resolve = (text: string, env: Record<string, string>): string[] | { error: string } => {
    const split = splitCommand(text)
    // The store reads only good texts; a bad one here is none.
    if ('error' in split || split.words.length === 0) return []
    const found = resolveProgram(split.words[0]!, env, o.platform)
    return 'error' in found ? found : [found.program, ...split.words.slice(1)]
  }

  /** Runs `<program> <filled args…> <true>` with a fresh run id; `undefined` when it passes, else its word. */
  const check = async (text: string, words: string[], env: Record<string, string>): Promise<string | undefined> => {
    if (passed.has(text)) return undefined
    const yes = resolveBin('true', env, o.platform)
    if (yes === undefined) {
      o.log('openaflow: true not found; the run wrapper starts with no check')
      return undefined
    }
    const [program, ...args] = fillWords(words, newId())
    const word = await run(program!, [...args, yes], env, o.timeoutMs ?? SCOPE_PROBE_MS)
    if (word !== 'exit 0') return word
    passed.add(text)
    return undefined
  }

  return {
    /**
     * The plan for a start with `settings`, this server's `probe`, and the server's `env` (a session's is made from
     * it), or the refusal: `run wrapper: <word>` first, then `stop command: <word>`.
     */
    async plan(settings: WrapperSettings, probe: ScopeProbe, serverEnv: NodeJS.ProcessEnv): Promise<WrapperPlan | { error: string }> {
      if (o.platform === 'win32') return {}
      const env = sessionBaseEnv(serverEnv, o.platform)
      const defaults = defaultTexts(o.platform)
      const plan: WrapperPlan = {}
      let defaultOn = false
      if (settings.runWrapper === undefined) {
        if (defaults.runWrapper !== '' && probe.on) {
          plan.wrapper = withProgram(defaults.runWrapper, probe.systemdRun)
          defaultOn = true
        }
      } else {
        const words = resolve(settings.runWrapper, env)
        if ('error' in words) return { error: `run wrapper: ${words.error}` }
        if (words.length > 0) {
          const failed = await check(settings.runWrapper, words, env)
          if (failed !== undefined) return { error: `run wrapper: ${failed}` }
          plan.wrapper = words
        }
      }
      if (settings.stopCommand === undefined) {
        if (defaultOn && probe.on && defaults.stopCommand !== '') plan.stop = withProgram(defaults.stopCommand, probe.systemctl)
      } else {
        const words = resolve(settings.stopCommand, env)
        if ('error' in words) return { error: `stop command: ${words.error}` }
        if (words.length > 0) plan.stop = words
      }
      return plan
    },
  }
}

export type RunWrapper = ReturnType<typeof createRunWrapper>

/** The start for `cmd` as session `marker`: inside the plan's wrapper, with its stop, placeholders filled. */
export function applyPlan(plan: WrapperPlan, cmd: { program: string; args: string[] }, marker: string): WrappedStart {
  const out: WrappedStart = { program: cmd.program, args: cmd.args }
  if (plan.wrapper) {
    const [program, ...args] = fillWords(plan.wrapper, marker)
    out.program = program!
    out.args = [...args, cmd.program, ...cmd.args]
  }
  if (plan.stop) out.stop = fillWords(plan.stop, marker)
  return out
}
