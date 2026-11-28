import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isSkillId, skillCommand, type SkillId } from '@openaflow/model'
import { isAbsoluteFor, isFile } from './bin-path.ts'
import { childEnv, cmdPath, shimTarget } from './claude-runner.ts'
import { editDenyRule, workflowFlags } from './workflow-flags.ts'

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
  /**
   * The bundled workflow plugin folder, loaded with a second `--plugin-dir` after the hooks plugin, and also passed as
   * `--add-dir` with an Edit deny rule over it (workflow-flags.ts), so claude reads the workflow's own files with no
   * prompt and edits none of them. Only a repo with `.openaflow/` gets one; left
   * out, the session starts with the hooks plugin only (sprint default-workflow §6).
   */
  workflowDir?: string | undefined
  /** The server's live config folder; hook state goes to its `hooks` folder. */
  configDir: string
  /** The server's own env; it is left alone. */
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** Windows file reads, replaceable in tests. Left out: the real ones. */
  windows?:
    | {
        readShim(file: string, env: NodeJS.ProcessEnv): ShimRead
        cmdPath(env: NodeJS.ProcessEnv): string | undefined
        /** Writes the cmd.exe path's settings file (its folder too); false when it couldn't. */
        writeFile(file: string, text: string): boolean
      }
    | undefined
}

/** What every command needs: all of the input but the skill and its text. */
type CommandBase = Omit<SessionCommandInput, 'skill' | 'text'>

/** A pty host `StartSpec` minus its id and size. `typeYourself` is set when the prompt could not go on the command line. */
export type SessionCommand = { program: string; args: string[]; cwd: string; env: Record<string, string>; typeYourself?: string }

export type SessionCommandError = 'bad skill' | 'bad id' | 'bad path' | 'bad text' | 'node not found' | 'cmd.exe not found' | 'unsafe claude path' | 'settings not written'

/**
 * The cmd.exe path's settings file for `workflowDir`: `<configDir>\workflow-deny\<16 hex>.json`, one a workflow
 * folder (Windows paths ignore case, so the name does too).
 */
export function denySettingsFile(configDir: string, workflowDir: string): string {
  const name = createHash('sha256').update(workflowDir.toLowerCase()).digest('hex').slice(0, 16)
  return path.win32.join(configDir, 'workflow-deny', `${name}.json`)
}

/** The settings file's text: the workflow folder's Edit deny rule (workflow-flags.ts), and nothing else. */
const denySettingsText = (workflowDir: string) => JSON.stringify({ permissions: { deny: [editDenyRule(workflowDir, 'win32')] } })

/** Writes `text` to `file`, private to the user (0700 folder, 0600 file where the system has modes); false on a failure. */
function writeSettingsFile(file: string, text: string): boolean {
  try {
    mkdirSync(path.win32.dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, text, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** A run marker or session id: a lowercase UUID v4 (contract §3), which `record.sh` also requires. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const MAX_TEXT = 2000
/**
 * Characters cmd.exe acts on even inside quotes, or that end the quoting (`call` expands `%` a second time), plus
 * `,;=`, where cmd.exe splits a path that node-pty left unquoted (it quotes only an arg with a space or a tab).
 */
const CMD_UNSAFE = /["%!^&|<>\r\n,;=]/

/**
 * The program, args, folder, and env that start a hosted `claude` session, or the word for why not.
 * Args: `--session-id <id> --plugin-dir <hooks>`, then `--add-dir <workflow> --disallowedTools <rule> --plugin-dir <workflow>` when given, then at most one prompt, last. Never `-p`, `--bare`,
 * a permission flag, or a model flag: the session is the user's own interactive `claude`.
 */
export function sessionCommand(o: SessionCommandInput): SessionCommand | SessionCommandError {
  if (!isSkillId(o.skill)) return 'bad skill'
  const bad = badInput(o)
  if (bad !== undefined) return bad
  const prompt = startPrompt(o.skill, o.text)
  if (prompt === 'bad text') return prompt

  return build(o, ['--session-id', o.sessionId], prompt)
}

/** What `resumeCommand` takes: `sessionId` is the session to resume, `runMarker` the new record's marker. */
export type ResumeCommandInput = CommandBase

export type ResumeCommandError = Exclude<SessionCommandError, 'bad skill' | 'bad text'>

/**
 * The command that resumes `sessionId` in a hosted `claude`: as `sessionCommand`, with the args
 * `--resume <id> --plugin-dir <hooks>` (and the workflow's flags when given) and no prompt, so a Windows shim never needs `typeYourself`.
 */
export function resumeCommand(o: ResumeCommandInput): SessionCommand | ResumeCommandError {
  const bad = badInput(o)
  if (bad !== undefined) return bad
  return build(o, ['--resume', o.sessionId], undefined)
}

/**
 * `--plugin-dir <hooks>`, then the workflow's `--add-dir`, Edit deny rule, and `--plugin-dir` when there is one
 * (workflow-flags.ts: each variadic flag is followed by a flag, so a prompt is never read as a folder or a rule).
 * `deny: false` on the cmd.exe path, which carries the rule in a settings file instead (see `build`).
 */
const pluginFlags = (o: CommandBase, deny: boolean) => ['--plugin-dir', o.pluginDir, ...(o.workflowDir === undefined ? [] : workflowFlags(o.workflowDir, { platform: o.platform, deny }))]

/**
 * The command for `flags` and an optional prompt, last. A Windows shim only cmd.exe can read gets no prompt:
 * `typeYourself` holds it instead.
 */
function build(o: CommandBase, flags: string[], prompt: string | undefined): SessionCommand | ResumeCommandError {
  const win = o.platform === 'win32'
  const env = sessionEnv(o)
  const all = [...flags, ...pluginFlags(o, true)]
  const withPrompt = prompt === undefined ? all : [...all, prompt]
  const base = { cwd: o.repo, env }
  if (!win || !/\.(cmd|bat)$/i.test(o.claude)) return { ...base, program: o.claude, args: withPrompt }

  const windows = o.windows ?? { readShim: readShimFile, cmdPath, writeFile: writeSettingsFile }
  const run = windows.readShim(o.claude, o.env)
  if (run === 'no node') return 'node not found'
  if (run !== 'unreadable') return { ...base, program: run.file, args: [...run.pre, ...withPrompt] }

  // A shim only cmd.exe can read. node-pty quotes an arg with a space and escapes any quote in it, so no free
  // text can pass through cmd.exe intact: the session starts with no prompt, and the user types it.
  // The workflow's Edit deny rule can't go on this line: node-pty quotes only an arg with a space, and a shim that runs
  // `%*` inside a ( ) block (pnpm's does) would end the block at the rule's `)`. So it goes in a settings file, a plain
  // path, passed with `--settings`. From https://code.claude.com/docs/en/cli-reference: `--settings` takes a "Path to a
  // settings JSON file or an inline JSON string. Values you set here override the same keys in your `settings.json`
  // files for this session, but most lists merge with theirs." From https://code.claude.com/docs/en/settings, on lists:
  // "Claude Code combines the lists instead of picking one, so each file can add entries without removing another
  // file's." So the user's own deny rules stay.
  const settings = o.workflowDir === undefined ? undefined : denySettingsFile(o.configDir, o.workflowDir)
  if ([o.claude, o.pluginDir, o.workflowDir ?? '', settings ?? ''].some((p) => CMD_UNSAFE.test(p))) return 'unsafe claude path'
  const cmd = windows.cmdPath(o.env)
  if (cmd === undefined) return 'cmd.exe not found'
  // No file, no start: the session would run with no deny rule.
  if (settings !== undefined && !windows.writeFile(settings, denySettingsText(o.workflowDir!))) return 'settings not written'
  // `call` first: cmd.exe strips the quotes of the line after /c only when it starts with a quote.
  const args = ['/d', '/c', 'call', o.claude, ...flags, ...pluginFlags(o, false), ...(settings === undefined ? [] : ['--settings', settings])]
  return prompt === undefined ? { ...base, program: cmd, args } : { ...base, program: cmd, args, typeYourself: prompt }
}

/** The ids are two different lowercase UUID v4s; every path is absolute. */
function badInput(o: CommandBase): 'bad id' | 'bad path' | undefined {
  if (!UUID_V4.test(o.sessionId) || !UUID_V4.test(o.runMarker) || o.sessionId === o.runMarker) return 'bad id'
  const win = o.platform === 'win32'
  const paths = [o.claude, o.repo, o.pluginDir, o.configDir, ...(o.workflowDir === undefined ? [] : [o.workflowDir])]
  if (!paths.every((p) => isAbsoluteFor(p, win))) return 'bad path'
  return undefined
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
 * inherited `OPENAFLOW_*` and `TERM` in any case. The env every session starts from, before its own names.
 */
export function sessionBaseEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(childEnv(env, platform))) {
    const u = k.toUpperCase()
    if (v === undefined || u.startsWith('OPENAFLOW_') || u === 'TERM') continue
    out[k] = v
  }
  return out
}

/** `sessionBaseEnv`, plus contract §3's two names and `TERM`. */
function sessionEnv(o: CommandBase): Record<string, string> {
  const out = sessionBaseEnv(o.env, o.platform)
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
