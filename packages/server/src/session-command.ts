import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isSkillId, skillCommand, type SkillId } from '@openaflow/model'
import { isAbsoluteFor, isFile } from './bin-path.ts'
import { childEnv, cmdPath, shimTarget } from './claude-runner.ts'

/** What a Windows `.cmd` shim runs: a file plus the args before claude's own; or why it can't be read that way. */
export type ShimRead = { file: string; pre: string[] } | 'no node' | 'unreadable'

export type SessionCommandInput = {
  /** The absolute path of `claude`, from the tool finder. */
  claude: string
  repo: string
  skill: SkillId
  text: string
  sessionId: string
  runMarker: string
  /** The hooks plugin folder, loaded with `--plugin-dir`. */
  pluginDir: string
  /** The server's live config folder; hook state goes to its `hooks` folder. */
  configDir: string
  /** The server's own env; it is left alone. */
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** Windows file reads, replaceable in tests. Left out: the real ones. */
  windows?: { readShim(file: string, env: NodeJS.ProcessEnv): ShimRead; cmdPath(env: NodeJS.ProcessEnv): string | undefined } | undefined
}

/** A pty host `StartSpec` minus its id and size. `typeYourself` is set when the prompt could not go on the command line. */
export type SessionCommand = { program: string; args: string[]; cwd: string; env: Record<string, string>; typeYourself?: string }

export type SessionCommandError = 'bad skill' | 'bad id' | 'bad path' | 'bad text' | 'node not found' | 'cmd.exe not found' | 'unsafe claude path'

/** A run marker or session id: a lowercase UUID v4 (contract §3), which `record.sh` also requires. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const MAX_TEXT = 2000
/** Characters cmd.exe acts on even inside quotes, or that end the quoting; `call` expands `%` a second time. */
const CMD_UNSAFE = /["%!^&|<>\r\n]/

/**
 * The program, args, folder, and env that start a hosted `claude` session, or the word for why not.
 * Args: `--session-id <id> --plugin-dir <dir>`, then at most one prompt, last. Never `-p`, `--bare`,
 * a permission flag, or a model flag: the session is the user's own interactive `claude`.
 */
export function sessionCommand(o: SessionCommandInput): SessionCommand | SessionCommandError {
  const win = o.platform === 'win32'
  if (!isSkillId(o.skill)) return 'bad skill'
  if (!UUID_V4.test(o.sessionId) || !UUID_V4.test(o.runMarker) || o.sessionId === o.runMarker) return 'bad id'
  if (![o.claude, o.repo, o.pluginDir, o.configDir].every((p) => isAbsoluteFor(p, win))) return 'bad path'
  const prompt = startPrompt(o.skill, o.text)
  if (prompt === 'bad text') return prompt

  const env = sessionEnv(o)
  const flags = ['--session-id', o.sessionId, '--plugin-dir', o.pluginDir]
  const withPrompt = prompt === undefined ? flags : [...flags, prompt]
  const base = { cwd: o.repo, env }
  if (!win || !/\.(cmd|bat)$/i.test(o.claude)) return { ...base, program: o.claude, args: withPrompt }

  const windows = o.windows ?? { readShim: readShimFile, cmdPath }
  const run = windows.readShim(o.claude, o.env)
  if (run === 'no node') return 'node not found'
  if (run !== 'unreadable') return { ...base, program: run.file, args: [...run.pre, ...withPrompt] }

  // A shim only cmd.exe can read. node-pty quotes an arg with a space and escapes any quote in it, so no free
  // text can pass through cmd.exe intact: the session starts with no prompt, and the user types it.
  if (CMD_UNSAFE.test(o.claude) || CMD_UNSAFE.test(o.pluginDir)) return 'unsafe claude path'
  const cmd = windows.cmdPath(o.env)
  if (cmd === undefined) return 'cmd.exe not found'
  // `call` first: cmd.exe strips the quotes of the line after /c only when it starts with a quote.
  const args = ['/d', '/c', 'call', o.claude, ...flags]
  return prompt === undefined ? { ...base, program: cmd, args } : { ...base, program: cmd, args, typeYourself: prompt }
}

/** `/pod:<skill> <text>`, the command alone, plain text alone, or nothing. */
function startPrompt(skill: SkillId, raw: string): string | undefined | 'bad text' {
  const text = raw.trim()
  if (CONTROL.test(text) || [...text].length > MAX_TEXT) return 'bad text'
  const command = skillCommand(skill)
  if (command === undefined) {
    if (text.startsWith('-')) return 'bad text' // claude would read it as a flag
    return text === '' ? undefined : text
  }
  return text === '' ? command : `${command} ${text}`
}

/**
 * The runner's `childEnv` (no credentials or Claude session state, absolute PATH entries only), minus every
 * inherited `OPENAFLOW_*` and `TERM` in any case, plus contract §3's two names and `TERM`.
 */
function sessionEnv(o: SessionCommandInput): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(childEnv(o.env, o.platform))) {
    const u = k.toUpperCase()
    if (v === undefined || u.startsWith('OPENAFLOW_') || u === 'TERM') continue
    out[k] = v
  }
  const p = o.platform === 'win32' ? path.win32 : path.posix
  out.OPENAFLOW_RUN = o.runMarker
  out.OPENAFLOW_HOOKS_DIR = p.join(o.configDir, 'hooks')
  out.TERM = 'xterm-256color'
  return out
}

/**
 * `shimTarget`, told apart: it answers `undefined` both for a shim it can't read and for an npm shim with no
 * node to run its script. The second is `no node`. This repeats the runner's shim pattern; see the handoff queue.
 */
function readShimFile(file: string, env: NodeJS.ProcessEnv): ShimRead {
  const run = shimTarget(file, env)
  if (run !== undefined) return run
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 'unreadable'
  }
  const rel = [...text.matchAll(/"%dp0%\\([^"%\r\n]+)"\s+%\*/gi)].at(-1)?.[1]
  if (rel === undefined) return 'unreadable'
  const script = path.win32.resolve(path.win32.dirname(file), rel)
  return /\.[cm]?js$/i.test(script) && isFile(script) ? 'no node' : 'unreadable'
}
