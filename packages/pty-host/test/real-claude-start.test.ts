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
import { resumeCommand, sessionCommand, type SessionCommand } from '../../server/src/session-command.ts'

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
/** The file the `deny` skill's Bash command makes in the repo; the test denies the command, so it never exists. */
const RAN_FILE = 'proof-ran-4417.txt'
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

/** What the two launches saw; the tests only read it. */
const seen = {
  // Launch 1, in a folder claude never trusted: the pong turn.
  cmd: undefined as SessionCommand | undefined,
  sessionId: '',
  trustScreen: undefined as string | undefined,
  hooksAtTrust: [] as Hook[],
  /** The hook lines read again just before the Enter that answers the trust prompt. */
  hooksBeforeAnswer: [] as Hook[],
  hookText: '',
  screen: '',
  // Launch 2, in the same folder, now trusted: the Bash call that the test denies.
  sessionId2: '',
  trustAgain: undefined as string | undefined,
  /** From just before the spawn to the first SessionStart line's `at`. */
  sessionStartMs: undefined as number | undefined,
  permissionScreen: undefined as string | undefined,
  denied: false,
  /** The marker file the denied command would make: it exists if the command ran. */
  ran: false,
  hookText2: '',
  screen2: '',
  // Launch 3: `--resume` of launch 1's session, then one question about its first turn.
  resumeArgs: [] as string[],
  resumeHookText: '',
  resumeScreen: '',
  /** The replies written after launch 3's spawn. */
  resumeReplies: [] as string[],
  // Both launches, from their transcripts.
  models: [] as string[],
  replies: [] as string[],
}

/** The question launch 3 asks: only the first turn's reply holds the answer. */
const RECALL = 'What exact token did you reply with earlier in this conversation? Answer with that token only.'

let root = ''
/** The running launch's end: SIGHUP first, then a forced end after 5 s. */
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
    // In the repo's settings, never a flag: the Bash call must ask, whatever the config folder's settings say.
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku', permissions: { defaultMode: 'default' } }))
    const plugin = join(root, 'plugin')
    cpSync(HOOKS_PLUGIN, plugin, { recursive: true })
    cpSync(PROOF_OVERLAY, plugin, { recursive: true, force: true })
    const configDir = join(root, 'cfg')
    const claude = resolveBin('claude', process.env)
    if (claude === undefined) throw new Error('no claude on PATH')

    /** Starts one `claude` in `repo` with the builder's exact command: a new session with `text`, or a resume of `resume`. */
    const launch = (text: string, resume?: string) => {
      const sessionId = resume ?? randomUUID()
      const runMarker = randomUUID()
      const base = { claude, repo, sessionId, runMarker, pluginDir: plugin, configDir, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir }, platform: process.platform }
      const cmd = resume === undefined ? sessionCommand({ ...base, skill: 'plain', text }) : resumeCommand(base)
      if (typeof cmd === 'string') throw new Error(`the command builder refused: ${cmd}`)
      if (cmd.env.CLAUDE_CONFIG_DIR !== claudeDir) throw new Error(`the launch would not use ${claudeDir}`)
      const hookFile = join(configDir, 'hooks', `${runMarker}.jsonl`)
      const hookText = () => (existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : '')
      const hooks = (): Hook[] => hookLines(hookText())
      const cols = 120
      const rows = 40
      const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
      const screen = () => {
        const b = term.buffer.active
        const out: string[] = []
        for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
        return out.join('\n')
      }
      const spawnedAt = Date.now()
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
      /** Stops the run when claude shows its login or first-run screen: the test never types into it. */
      const checkSignedIn = () => {
        const text = screen()
        if (/select login method|please run \/login|invalid api key|choose the text style/i.test(text)) {
          throw new Error(`the folder ${claudeDir} is not signed in or not set up; ${SIGN_IN}. Screen:\n${text}`)
        }
      }
      const has = (event: string) => hooks().some((h) => h.payload?.hook_event_name === event)
      return { cmd, sessionId, spawnedAt, screen, hooks, hookText, has, write: (d: string) => pty.write(d), exited: () => exited, checkSignedIn }
    }
    const isTrustPrompt = (text: string) => /trust/i.test(text) && /folder|files/i.test(text)

    // Launch 1: a folder claude never trusted. Ends at the first Stop, or when claude ends, or after 150 s;
    // the tests then say what is missing.
    const one = launch(`/proof:pong ${SPECIAL}`)
    seen.cmd = one.cmd
    seen.sessionId = one.sessionId
    /** The highlighted line of a select menu. */
    const selected = () => one.screen().split('\n').find((l) => /❯/.test(l) && /trust this folder|exit/i.test(l)) ?? ''
    try {
      const end = Date.now() + 150_000
      while (!one.has('Stop') && !one.exited() && Date.now() < end) {
        one.checkSignedIn()
        const text = one.screen()
        if (seen.trustScreen === undefined && isTrustPrompt(text)) {
          seen.trustScreen = text
          seen.hooksAtTrust = one.hooks()
          // The highlighted default is "No, exit", and Enter there ends claude: move to "Yes" and check first.
          for (const key of ['', '\u001b[B', '\u001b[A', '\u001b[A']) {
            if (key !== '') one.write(key)
            await sleep(700)
            if (/yes/i.test(selected())) break
          }
          if (!/yes/i.test(selected())) throw new Error(`could not highlight "Yes" on the trust prompt:\n${one.screen()}`)
          seen.hooksBeforeAnswer = one.hooks()
          one.write('\r') // exactly once
        }
        await sleep(250)
      }
      await sleep(1000) // the reply's last frame
    } finally {
      seen.screen = one.screen()
      seen.hookText = one.hookText()
      await stop()
    }

    // Launch 2: the same folder, trusted now. Times the first SessionStart, then denies the skill's one Bash call
    // with Escape. Ends 5 s after the deny, or at a Stop, or when claude ends, or after 120 s.
    const two = launch('/proof:deny')
    seen.sessionId2 = two.sessionId
    const ranFile = join(repo, RAN_FILE)
    try {
      const end = Date.now() + 120_000
      let askedAt: number | undefined
      while (!two.has('Stop') && !two.exited() && Date.now() < end) {
        two.checkSignedIn()
        const text = two.screen()
        if (seen.trustAgain === undefined && isTrustPrompt(text)) {
          seen.trustAgain = text // the test fails on it; answer nothing
          break
        }
        const start = two.hooks().find((h) => h.payload?.hook_event_name === 'SessionStart')
        if (seen.sessionStartMs === undefined && start) {
          seen.sessionStartMs = start.at - two.spawnedAt
          console.log(`real-claude-start: SessionStart ${seen.sessionStartMs} ms after the spawn in a trusted folder`)
        }
        if (!seen.denied && two.has('PermissionRequest')) {
          askedAt ??= Date.now()
          // Escape once the prompt draws, or 3 s after the hook line if it never seems to.
          if (/do you want/i.test(text) || Date.now() - askedAt > 3000) {
            seen.permissionScreen = text
            two.write('\u001b')
            seen.denied = true
            await sleep(5000) // a command run after the deny would land in this time
            break
          }
        }
        await sleep(100)
      }
    } finally {
      seen.screen2 = two.screen()
      seen.hookText2 = two.hookText()
      seen.ran = existsSync(ranFile)
      await stop()
    }

    // Launch 3: Resume's exact command for launch 1's session, in the same folder. One question about the first turn;
    // ends at its Stop, or when claude ends, or after 120 s.
    const three = launch('', seen.sessionId)
    seen.resumeArgs = three.cmd.args
    try {
      const end = Date.now() + 120_000
      let asked = false
      while (!three.has('Stop') && !three.exited() && Date.now() < end) {
        three.checkSignedIn()
        // Ask once the session is up: its SessionStart line, and a moment for the input box.
        if (!asked && three.has('SessionStart')) {
          await sleep(2000)
          three.write(RECALL)
          await sleep(500)
          three.write('\r')
          asked = true
        }
        await sleep(250)
      }
      await sleep(1000) // the reply's last frame
    } finally {
      seen.resumeScreen = three.screen()
      seen.resumeHookText = three.hookText()
      await stop()
    }

    // The transcripts say which model answered.
    const projects = join(claudeDir, 'projects')
    for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
      for (const id of [seen.sessionId, seen.sessionId2]) {
        const file = join(projects, dir, `${id}.jsonl`)
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
    }
    // Launch 3's replies, from every transcript in the repo's folder: a resume may write to a new session file.
    for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
      if (!existsSync(join(projects, dir, `${seen.sessionId}.jsonl`))) continue
      for (const name of readdirSync(join(projects, dir)).filter((n) => n.endsWith('.jsonl'))) {
        for (const line of readFileSync(join(projects, dir, name), 'utf8').split('\n')) {
          let rec: { type?: string; timestamp?: string; message?: { content?: unknown } }
          try {
            rec = JSON.parse(line)
          } catch {
            continue
          }
          if (rec.type !== 'assistant' || !rec.timestamp || Date.parse(rec.timestamp) < three.spawnedAt) continue
          const content = Array.isArray(rec.message?.content) ? (rec.message.content as { type: string; text?: string }[]) : []
          for (const c of content) if (c.type === 'text' && c.text) seen.resumeReplies.push(c.text)
        }
      }
    }
  }, 540_000)

  afterAll(async () => {
    // One summary line, so a run on another machine shows what it saw.
    const names = (text: string) => hookLines(text).map((h) => h.payload?.hook_event_name).join(', ')
    console.log(
      `real-claude-start: trust prompt ${seen.trustScreen ? 'shown' : 'not shown'}; models ${seen.models.join(', ')}; ` +
        `launch 1 hooks ${names(seen.hookText)}; launch 2 hooks ${names(seen.hookText2)}; SessionStart ${seen.sessionStartMs} ms; denied ${seen.denied}`,
    )
    await stop()
    if (root) rmSync(root, { recursive: true, force: true })
    // The transcript folders of this run's temp repo, and nothing else in the config folder.
    const projects = join(claudeDir, 'projects')
    for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
      const ours = [seen.sessionId, seen.sessionId2].some((id) => id && existsSync(join(projects, dir, `${id}.jsonl`)))
      if (ours) rmSync(join(projects, dir), { recursive: true, force: true })
    }
  })

  const events = (name: string, text = seen.hookText) => hookLines(text).filter((h) => h.payload?.hook_event_name === name)

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

  test('no SessionStart before the trust answer', () => {
    expect(seen.trustScreen, `no trust prompt; screen:\n${seen.screen}`).toBeDefined()
    const starts = (hooks: Hook[]) => hooks.filter((h) => h.payload?.hook_event_name === 'SessionStart')
    expect(starts(seen.hooksAtTrust), 'SessionStart when the trust prompt showed').toEqual([])
    expect(starts(seen.hooksBeforeAnswer), 'SessionStart before the Enter on "Yes"').toEqual([])
    // It does come once the folder is trusted, so the empty reads above mean "not yet", not "never".
    expect(events('SessionStart').length).toBeGreaterThan(0)
  })

  test('SessionStart within the waiting time', () => {
    expect(seen.trustAgain, `the trust prompt showed again in a trusted folder:\n${seen.trustAgain}`).toBeUndefined()
    expect(seen.sessionStartMs, `no SessionStart; screen:\n${seen.screen2}`).toBeDefined()
    expect(seen.sessionStartMs!).toBeLessThan(10_000) // contract §4: unhooked at 10 s reads "Waiting for you"
    expect(readHookState(seen.hookText2).live).toMatchObject({ session: seen.sessionId2, cause: 'startup' })
  })

  test('tool hooks fire', () => {
    const lines = hookLines(seen.hookText2)
    const bash = (event: string) => lines.findIndex((h) => h.payload?.hook_event_name === event && h.payload?.tool_name === 'Bash')
    expect(bash('PreToolUse'), `no Bash PreToolUse; hooks: ${lines.map((h) => h.payload?.hook_event_name).join(', ')}; screen:\n${seen.screen2}`).toBeGreaterThanOrEqual(0)
    const asked = lines.findIndex((h) => h.payload?.hook_event_name === 'PermissionRequest')
    expect(asked, `no PermissionRequest after the Bash PreToolUse; screen:\n${seen.screen2}`).toBeGreaterThan(bash('PreToolUse')) // in line order
    expect(seen.denied, `no Escape sent; screen at the prompt:\n${seen.permissionScreen ?? seen.screen2}`).toBe(true)
    // Nothing ran after the deny: no file, and no second Bash try.
    expect(seen.ran, `${RAN_FILE} exists, so the command ran; screen:\n${seen.screen2}`).toBe(false)
    expect(lines.filter((h) => h.payload?.hook_event_name === 'PreToolUse' && h.payload?.tool_name === 'Bash')).toHaveLength(1)
    expect(seen.models.every((m) => /haiku/i.test(m)), `models: ${seen.models.join(', ')}`).toBe(true)
  })

  test('resume brings back the conversation', () => {
    // Resume's own args: the session, the plugin, and no prompt.
    expect(seen.resumeArgs.slice(-4)).toEqual(['--resume', seen.sessionId, '--plugin-dir', seen.cmd!.args.at(-2)])
    expect(readHookState(seen.resumeHookText).live, `screen:\n${seen.resumeScreen}`).toMatchObject({ session: seen.sessionId, cause: 'resume' })
    const [submit] = events('UserPromptSubmit', seen.resumeHookText)
    expect(submit?.payload?.prompt, `screen:\n${seen.resumeScreen}`).toBe(RECALL)
    // The word from the first turn comes back in a reply written after the resume.
    expect(seen.resumeReplies.join('\n'), `screen:\n${seen.resumeScreen}`).toContain(PONG)
  })
})
