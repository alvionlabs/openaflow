import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Terminal } from '@xterm/headless'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { envKey, resolveBin } from '../../server/src/bin-path.ts'
import { readHookState } from '../../server/src/hook-state.ts'
import { sessionCommand, type SessionCommand } from '../../server/src/session-command.ts'

// The start command with real `claude` (contract §7): never in `pnpm verify` or CI. It runs only with
// OPENAFLOW_REAL_CLAUDE=1 and OPENAFLOW_REAL_CLAUDE_CONFIG_DIR, a separate Claude Code config folder the human
// signed in to once. The launch gets it as CLAUDE_CONFIG_DIR, so nothing lands in the real ~/.claude or
// ~/.claude.json. The test never reads, copies, or links a login file. The plugin is a temp copy of the hooks
// plugin, renamed `proof` and given the `pong` skill, so the builder's exact args run a cheap slash command
// instead of a real pod skill.
//
// Sign in once:  CLAUDE_CONFIG_DIR=$HOME/.openaflow-test-claude claude   (then /login, then /exit)
// Linux:         OPENAFLOW_REAL_CLAUDE=1 OPENAFLOW_REAL_CLAUDE_CONFIG_DIR=$HOME/.openaflow-test-claude pnpm vitest run packages/pty-host/test/real-claude-start.test.ts
// Windows:       $env:OPENAFLOW_REAL_CLAUDE='1'; $env:OPENAFLOW_REAL_CLAUDE_CONFIG_DIR="$HOME\.openaflow-test-claude"; pnpm vitest run packages/pty-host/test/real-claude-start.test.ts

type Gate = { dir: string } | { skip: string }

const SIGN_IN = 'sign in once with `CLAUDE_CONFIG_DIR=$HOME/.openaflow-test-claude claude`, then /login, then set OPENAFLOW_REAL_CLAUDE_CONFIG_DIR to that folder'

/** The real path of `p`, or `p` resolved when it doesn't exist. */
const realOr = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** `child` is `parent` or a folder in it. */
const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Whether the real run may start, and with which Claude Code config folder. Refused: the real `~/.claude` (in
 * any spelling, or a folder in it), the home folder (claude would write `~/.claude.json` there), and the caller's
 * own CLAUDE_CONFIG_DIR. It only looks at paths: it reads no file.
 */
function realClaudeGate(env: NodeJS.ProcessEnv, home: string): Gate {
  if (envKey(env, 'OPENAFLOW_REAL_CLAUDE') !== '1') return { skip: 'OPENAFLOW_REAL_CLAUDE is not 1' }
  const raw = envKey(env, 'OPENAFLOW_REAL_CLAUDE_CONFIG_DIR') ?? ''
  if (raw === '') return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is not set; ${SIGN_IN}` }
  if (!isAbsolute(raw)) return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is not absolute: ${raw}` }
  const dir = realOr(raw)
  if (within(dir, realOr(join(home, '.claude')))) return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is your real ~/.claude: ${raw}` }
  if (relative(realOr(home), dir) === '') return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is your home folder, where claude would write ~/.claude.json: ${raw}` }
  const own = envKey(env, 'CLAUDE_CONFIG_DIR')
  if (own && within(dir, realOr(own))) return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is your own CLAUDE_CONFIG_DIR: ${raw}` }
  if (!isDir(dir)) return { skip: `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is not a folder: ${raw}; ${SIGN_IN}` }
  return { dir }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const GATE = realClaudeGate(process.env, homedir())
// Said only when someone asked for the real run, so `pnpm test` stays quiet. On stderr: vitest drops a console line
// written while it collects tests.
const ASKED = ['OPENAFLOW_REAL_CLAUDE', 'OPENAFLOW_REAL_CLAUDE_CONFIG_DIR'].some((k) => envKey(process.env, k))
if ('skip' in GATE && ASKED) process.stderr.write(`real-claude-start: skipped, ${GATE.skip}\n`)
const here = dirname(fileURLToPath(import.meta.url))
const HOOKS_PLUGIN = join(here, '..', '..', 'hooks-plugin', 'plugin')
const PROOF_OVERLAY = join(here, 'fixtures', 'proof-skill')
const PONG = 'PROOF-PONG-4417'
const SPECIAL = `% ^ " ' & | < > ! é 日本`
const require = createRequire(import.meta.url)

type Hook = { at: number; payload: Record<string, unknown> | null }

/** The hook file's lines; a line that doesn't parse (one being written) is skipped, as contract §8 says. */
const hookLines = (text: string): Hook[] =>
  text.split('\n').flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as Hook] : []
    } catch {
      return []
    }
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** What the launch saw; the tests only read it. */
const seen = {
  cmd: undefined as SessionCommand | undefined,
  sessionId: '',
  trustScreen: undefined as string | undefined,
  hooksAtTrust: [] as Hook[],
  hookText: '',
  screen: '',
  models: [] as string[],
  replies: [] as string[],
}

let root = ''
/** Ends claude and waits for it: SIGHUP first, then a forced end after 5 s. */
let stop = async () => {}

describe('real claude gate', () => {
  test('refuses the real config folder', () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'oaf-real-gate-'))
    try {
      const real = join(home, '.claude')
      const good = join(home, 'test-claude')
      mkdirSync(join(real, 'sub'), { recursive: true })
      mkdirSync(join(home, 'x'))
      mkdirSync(good)
      const link = join(home, 'link')
      symlinkSync(real, link, 'junction')
      const on = (dir: string | undefined, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
        OPENAFLOW_REAL_CLAUDE: '1',
        ...(dir === undefined ? {} : { OPENAFLOW_REAL_CLAUDE_CONFIG_DIR: dir }),
        ...extra,
      })
      const skip = (env: NodeJS.ProcessEnv) => {
        const g = realClaudeGate(env, home)
        return 'skip' in g ? g.skip : `ran with ${g.dir}`
      }

      // Off unless asked for, even with a good folder.
      expect(skip({ OPENAFLOW_REAL_CLAUDE_CONFIG_DIR: good })).toMatch(/OPENAFLOW_REAL_CLAUDE is not 1/)
      // No folder: the reason says how to make one.
      expect(skip(on(undefined))).toMatch(/OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is not set.*\/login/)
      expect(skip(on(''))).toMatch(/OPENAFLOW_REAL_CLAUDE_CONFIG_DIR is not set/)
      expect(skip(on('test-claude'))).toMatch(/not absolute/)
      expect(skip(on(join(home, 'missing')))).toMatch(/not a folder.*\/login/)
      // The real ~/.claude in any spelling, or a folder in it.
      for (const dir of [real, `${real}/`, join(home, 'x', '..', '.claude'), link, join(real, 'sub')]) {
        expect(skip(on(dir)), dir).toMatch(/your real ~\/\.claude/)
      }
      // A ~/.claude that doesn't exist yet is still refused.
      expect(realClaudeGate(on(join(good, '.claude')), good)).toEqual({ skip: expect.stringMatching(/your real ~\/\.claude/) })
      // The home folder: claude would write ~/.claude.json there.
      expect(skip(on(home))).toMatch(/home folder/)
      // The caller's own CLAUDE_CONFIG_DIR, or a folder in it.
      expect(skip(on(good, { CLAUDE_CONFIG_DIR: good }))).toMatch(/your own CLAUDE_CONFIG_DIR/)
      expect(skip(on(join(home, 'x'), { CLAUDE_CONFIG_DIR: home + '/x/' }))).toMatch(/your own CLAUDE_CONFIG_DIR/)
      // A separate folder runs, by its real path.
      expect(realClaudeGate(on(good, { CLAUDE_CONFIG_DIR: real }), home)).toEqual({ dir: realpathSync(good) })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe.runIf('dir' in GATE)('real claude start', () => {
  /** The separate signed-in Claude Code config folder; the gate refused every other. */
  const claudeDir = 'dir' in GATE ? GATE.dir : ''

  beforeAll(async () => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'oaf-real-claude-'))
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku' }))
    const plugin = join(root, 'plugin')
    cpSync(HOOKS_PLUGIN, plugin, { recursive: true })
    cpSync(PROOF_OVERLAY, plugin, { recursive: true, force: true })
    const configDir = join(root, 'cfg')

    const claude = resolveBin('claude', process.env)
    if (claude === undefined) throw new Error('no claude on PATH')
    const sessionId = randomUUID()
    const runMarker = randomUUID()
    const cmd = sessionCommand({
      claude,
      repo,
      skill: 'plain',
      text: `/proof:pong ${SPECIAL}`,
      sessionId,
      runMarker,
      pluginDir: plugin,
      configDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
      platform: process.platform,
    })
    if (typeof cmd === 'string') throw new Error(`sessionCommand refused: ${cmd}`)
    if (cmd.env.CLAUDE_CONFIG_DIR !== claudeDir) throw new Error(`the launch would not use ${claudeDir}`)
    seen.cmd = cmd
    seen.sessionId = sessionId
    const hookFile = join(configDir, 'hooks', `${runMarker}.jsonl`)
    const hooks = (): Hook[] => hookLines(existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : '')
    const has = (event: string) => hooks().some((h) => h.payload?.hook_event_name === event)

    const cols = 120
    const rows = 40
    const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
    const screen = () => {
      const b = term.buffer.active
      const out: string[] = []
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
      return out.join('\n')
    }
    const pty = (require('node-pty') as typeof import('node-pty')).spawn(cmd.program, cmd.args, { name: 'xterm-256color', cwd: cmd.cwd, env: cmd.env, cols, rows })
    let exited = false
    pty.onData((d) => term.write(d))
    pty.onExit(() => {
      exited = true
    })
    stop = async () => {
      if (exited) return
      pty.kill()
      const end = Date.now() + 5000
      while (!exited && Date.now() < end) await sleep(100)
      if (!exited) pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
    }
    const write = (s: string) => pty.write(s)
    /** The highlighted line of a select menu. */
    const selected = () => screen().split('\n').find((l) => /❯/.test(l) && /trust this folder|exit/i.test(l)) ?? ''

    try {
      // Ends at the first Stop, or when claude ends, or after 150 s; the tests then say what is missing.
      const end = Date.now() + 150_000
      while (!has('Stop') && !exited && Date.now() < end) {
        const text = screen()
        if (seen.trustScreen === undefined && /trust/i.test(text) && /folder|files/i.test(text)) {
          seen.trustScreen = text
          seen.hooksAtTrust = hooks()
          // The highlighted default is "No, exit", and Enter there ends claude: move to "Yes" and check first.
          for (const key of ['', '\u001b[B', '\u001b[A', '\u001b[A']) {
            if (key !== '') write(key)
            await sleep(700)
            if (/yes/i.test(selected())) break
          }
          if (!/yes/i.test(selected())) throw new Error(`could not highlight "Yes" on the trust prompt:\n${screen()}`)
          write('\r') // exactly once
        }
        await sleep(250)
      }
      await sleep(1000) // the reply's last frame
    } finally {
      seen.screen = screen()
      seen.hookText = existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : ''
      await stop()
    }

    // The transcript says which model answered.
    const projects = join(claudeDir, 'projects')
    for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
      const file = join(projects, dir, `${sessionId}.jsonl`)
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        let rec: { type?: string; message?: { model?: string; content?: unknown } }
        try {
          rec = JSON.parse(line)
        } catch {
          continue // empty, or still being written
        }
        if (rec.type !== 'assistant') continue
        if (rec.message?.model) seen.models.push(rec.message.model)
        const content = Array.isArray(rec.message?.content) ? (rec.message.content as { type: string; text?: string }[]) : []
        for (const c of content) if (c.type === 'text' && c.text) seen.replies.push(c.text)
      }
    }
  }, 300_000)

  afterAll(async () => {
    // One summary line, so a run on another machine shows what it saw.
    const names = hookLines(seen.hookText).map((h) => h.payload?.hook_event_name)
    console.log(`real-claude-start: trust prompt ${seen.trustScreen ? 'shown' : 'not shown'}; models ${seen.models.join(', ')}; hooks ${names.join(', ')}`)
    await stop()
    if (root) rmSync(root, { recursive: true, force: true })
    // The transcript folders of this run's temp repo, and nothing else in the config folder.
    const projects = join(claudeDir, 'projects')
    for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
      if (seen.sessionId && existsSync(join(projects, dir, `${seen.sessionId}.jsonl`))) rmSync(join(projects, dir), { recursive: true, force: true })
    }
  })

  const events = (name: string) =>
    hookLines(seen.hookText).filter((h) => h.payload?.hook_event_name === name)

  test('a slash command start argument runs as the first turn', () => {
    expect(seen.models.length, `no assistant record in the transcript; screen:\n${seen.screen}`).toBeGreaterThan(0)
    expect(seen.models.every((m) => /haiku/i.test(m)), `models: ${seen.models.join(', ')}`).toBe(true)
    expect(seen.replies.join('\n'), seen.screen).toContain(PONG)
    expect(seen.screen).toContain(PONG)
    expect(events('UserPromptSubmit')).toHaveLength(1)
    expect(events('Stop')).toHaveLength(1)
  })

  test('hooks see the session and the exact prompt', () => {
    const state = readHookState(seen.hookText)
    expect(state.live).toMatchObject({ session: seen.sessionId, cause: 'startup' })
    const [submit] = events('UserPromptSubmit')
    expect(submit?.payload?.session_id).toBe(seen.sessionId)
    expect(submit?.payload?.prompt).toBe(seen.cmd!.args.at(-1))
    expect(submit?.payload?.prompt).toBe(`/proof:pong ${SPECIAL}`)
  })

  test('the start argument survives the folder-trust prompt', () => {
    expect(seen.trustScreen, `no trust prompt; screen:\n${seen.screen}`).toBeDefined()
    expect(seen.hooksAtTrust.filter((h) => h.payload?.hook_event_name === 'UserPromptSubmit')).toEqual([])
    expect(events('UserPromptSubmit')).toHaveLength(1)
    expect(seen.replies.join('\n')).toContain(PONG)
  })
})
