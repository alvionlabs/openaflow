import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Terminal } from '@xterm/headless'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { envKey, resolveBin } from '../../server/src/bin-path.ts'
import { sessionCommand, type SessionCommand } from '../../server/src/session-command.ts'

// A set-up repo's session with real `claude` (sprint default-workflow §6): the hooks plugin and the bundled
// claude-pod (`packages/workflow/dist/claude-pod`, made by `pnpm build`), with the server's exact args from `sessionCommand`,
// `--add-dir <workflow>` included, so claude reads the workflow's own files with no read prompt. Never in
// `pnpm verify` or CI. It runs only with OPENAFLOW_REAL_CLAUDE=1 and OPENAFLOW_REAL_CLAUDE_CONFIG_DIR, a separate
// Claude Code config folder the human signed in to once (see real-claude-start.test.ts). The launch gets it as
// CLAUDE_CONFIG_DIR; the test never reads, copies, or links a login file. The model is haiku, set in the temp
// repo's settings, which also accept file edits so `/pod:idea` can write without a prompt.
//
// Linux: pnpm build && OPENAFLOW_REAL_CLAUDE=1 OPENAFLOW_REAL_CLAUDE_CONFIG_DIR=$HOME/.openaflow-test-claude pnpm vitest run packages/pty-host/test/real-workflow-start.test.ts

type Gate = { dir: string } | { skip: string }

const SIGN_IN = 'sign in once with `CLAUDE_CONFIG_DIR=$HOME/.openaflow-test-claude claude`, then /login, then set OPENAFLOW_REAL_CLAUDE_CONFIG_DIR to that folder'

const realOr = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * A copy of real-claude-start.test.ts's gate (importing it would run that file's suites): refuses the real
 * `~/.claude`, the home folder, and the caller's own CLAUDE_CONFIG_DIR. It only looks at paths.
 */
function realClaudeGate(env: NodeJS.ProcessEnv, home: string): Gate {
  if (envKey(env, 'OPENAFLOW_REAL_CLAUDE') !== '1') return { skip: 'OPENAFLOW_REAL_CLAUDE is not 1' }
  const raw = envKey(env, 'OPENAFLOW_REAL_CLAUDE_CONFIG_DIR') ?? ''
  if (raw === '') return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is not set; ${SIGN_IN}` }
  if (!isAbsolute(raw)) return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is not absolute: ${raw}` }
  const dir = realOr(raw)
  if (within(dir, realOr(join(home, '.claude')))) return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is your real ~/.claude: ${raw}` }
  if (relative(realOr(home), dir) === '') return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is your home folder: ${raw}` }
  const own = envKey(env, 'CLAUDE_CONFIG_DIR')
  if (own && within(dir, realOr(own))) return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is your own CLAUDE_CONFIG_DIR: ${raw}` }
  if (!isDir(dir)) return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is not a folder: ${raw}; ${SIGN_IN}` }
  return { dir }
}

const GATE = realClaudeGate(process.env, homedir())
const ASKED = ['OPENAFLOW_REAL_CLAUDE', 'OPENAFLOW_REAL_CLAUDE_CONFIG_DIR'].some((k) => envKey(process.env, k))
if ('skip' in GATE && ASKED) process.stderr.write(`real-workflow-start: skipped, ${GATE.skip}\n`)
const here = dirname(fileURLToPath(import.meta.url))
const HOOKS_PLUGIN = join(here, '..', '..', 'hooks-plugin', 'plugin')
const WORKFLOW = join(here, '..', '..', 'workflow', 'dist', 'claude-pod')
const STATE = join('.openaflow', 'workflows', 'claude-pod', 'state')
const TEMPLATE = join(WORKFLOW, 'skills', 'init', 'scaffold', STATE)
const IDEA = 'a dark mode toggle for the board. Why on hold: no users asked yet. Worth building when: two users ask for it.'
const require = createRequire(import.meta.url)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Hook = { at: number; payload: Record<string, unknown> | null }
const hookLines = (text: string): Hook[] =>
  text.split('\n').flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as Hook] : []
    } catch {
      return []
    }
  })

/** Every file under `dir`, as paths relative to `root`, with its size and change time, so a write shows. */
function files(root: string, dir = root, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) files(root, p, out)
    else out.set(relative(root, p), `${s.size}:${s.mtimeMs}`)
  }
  return out
}

const seen = { cmd: undefined as SessionCommand | undefined, before: new Map<string, string>(), after: new Map<string, string>(), hookText: '', screen: '', trust: false }
let root = ''

describe.runIf('dir' in GATE)('real workflow start', () => {
  const claudeDir = 'dir' in GATE ? GATE.dir : ''
  let repo = ''

  beforeAll(async () => {
    if (!existsSync(join(WORKFLOW, '.claude-plugin', 'plugin.json'))) throw new Error(`no bundled workflow at ${WORKFLOW}; run pnpm build first`)
    root = mkdtempSync(join(realpathSync(tmpdir()), 'oaf-real-workflow-'))
    repo = join(root, 'repo')
    // A set-up repo, as setup makes it: workflow.json and a copy of the template state.
    const version = (JSON.parse(readFileSync(join(WORKFLOW, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }).version
    mkdirSync(join(repo, STATE), { recursive: true })
    cpSync(TEMPLATE, join(repo, STATE), { recursive: true })
    writeFileSync(join(repo, '.openaflow', 'workflows', 'claude-pod', 'workflow.json'), JSON.stringify({ source: 'claude-pod', version }, null, 2) + '\n')
    mkdirSync(join(repo, '.claude'))
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku', permissions: { defaultMode: 'acceptEdits' } }))
    seen.before = files(repo)
    const claude = resolveBin('claude', process.env)
    if (claude === undefined) throw new Error('no claude on PATH')
    const runMarker = randomUUID()
    const cmd = sessionCommand({
      claude,
      repo,
      skill: 'idea',
      text: IDEA,
      sessionId: randomUUID(),
      runMarker,
      pluginDir: HOOKS_PLUGIN,
      workflowDir: WORKFLOW,
      configDir: join(root, 'cfg'),
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
      platform: process.platform,
    })
    if (typeof cmd === 'string') throw new Error(`the command builder refused: ${cmd}`)
    seen.cmd = cmd
    const hookFile = join(root, 'cfg', 'hooks', `${runMarker}.jsonl`)
    const hookText = () => (existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : '')
    const has = (event: string) => hookLines(hookText()).some((h) => h.payload?.hook_event_name === event)
    const term = new Terminal({ cols: 120, rows: 40, scrollback: 2000, allowProposedApi: true })
    const screen = () => {
      const b = term.buffer.active
      const out: string[] = []
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
      return out.join('\n')
    }
    const pty = (require('node-pty') as typeof import('node-pty')).spawn(cmd.program, cmd.args, { name: 'xterm-256color', cwd: cmd.cwd, env: cmd.env, cols: 120, rows: 40 })
    let exited = false
    pty.onData((d) => term.write(d))
    pty.onExit(() => {
      exited = true
    })
    try {
      const end = Date.now() + 240_000
      while (!has('Stop') && !exited && Date.now() < end) {
        const text = screen()
        if (/select login method|please run \/login|invalid api key|choose the text style/i.test(text)) throw new Error(`${claudeDir} is not signed in; ${SIGN_IN}. Screen:\n${text}`)
        // A read prompt for the workflow's own files: the session stalls there, so fail now with the screen.
        if (/do you want to proceed|allow reading from/i.test(text)) throw new Error(`claude asked to read a file. Screen:\n${text}`)
        // A new temp folder: claude asks to trust it once. Move to "Yes", then Enter.
        if (!seen.trust && /trust/i.test(text) && /folder|files/i.test(text)) {
          seen.trust = true
          const selected = () => screen().split('\n').find((l) => /❯/.test(l) && /trust this folder|exit/i.test(l)) ?? ''
          for (const key of ['', '\u001b[B', '\u001b[A', '\u001b[A']) {
            if (key !== '') pty.write(key)
            await sleep(700)
            if (/yes/i.test(selected())) break
          }
          if (!/yes/i.test(selected())) throw new Error(`could not highlight "Yes" on the trust prompt:\n${screen()}`)
          pty.write('\r')
        }
        await sleep(250)
      }
      await sleep(1000)
    } finally {
      seen.screen = screen()
      seen.hookText = hookText()
      if (!exited) {
        pty.kill()
        const end = Date.now() + 5000
        while (!exited && Date.now() < end) await sleep(100)
        if (!exited) pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
      }
      seen.after = files(repo)
    }
  }, 300_000)

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    // This run's transcript folder, and nothing else in the config folder.
    const projects = join(claudeDir, 'projects')
    for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
      if (dir.includes('oaf-real-workflow-')) rmSync(join(projects, dir), { recursive: true, force: true })
    }
  })

  test('bundled workflow writes the state folder', () => {
    // The server's args: the hooks plugin, the workflow as --add-dir and --plugin-dir, then the prompt. The run above
    // got past the workflow's own file reads with no prompt, so --add-dir took only the folder, not the prompt.
    expect(seen.cmd!.args.slice(-7)).toEqual(['--plugin-dir', HOOKS_PLUGIN, '--add-dir', WORKFLOW, '--plugin-dir', WORKFLOW, `/pod:idea ${IDEA}`])
    // The hook file got a SessionStart line, so the hooks plugin loaded beside the workflow.
    expect(hookLines(seen.hookText).some((h) => h.payload?.hook_event_name === 'SessionStart'), `hooks: ${seen.hookText}\nscreen:\n${seen.screen}`).toBe(true)
    // Every new or changed file is under the state folder (claude's own .claude/ aside), and an idea file is one of them.
    const changed = [...seen.after].filter(([p, v]) => seen.before.get(p) !== v).map(([p]) => p)
    const outside = changed.filter((p) => !p.startsWith(STATE + sep) && !p.startsWith('.claude' + sep))
    expect(outside, `screen:\n${seen.screen}`).toEqual([])
    expect(changed.filter((p) => p.startsWith(join(STATE, 'ideas') + sep) && p.endsWith('.md')).length, `changed: ${changed.join(', ')}\nscreen:\n${seen.screen}`).toBeGreaterThan(0)
    expect(existsSync(join(repo, 'pod-docs'))).toBe(false)
  })
})
