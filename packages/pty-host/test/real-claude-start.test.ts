import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Terminal } from '@xterm/headless'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { resolveBin } from '../../server/src/bin-path.ts'
import { readHookState } from '../../server/src/hook-state.ts'
import { sessionCommand, type SessionCommand } from '../../server/src/session-command.ts'

// The start command with the user's real `claude` (contract §7): only with OPENAFLOW_REAL_CLAUDE=1, never in
// `pnpm verify` or CI. One launch, one Haiku turn, in a new temp folder, so the folder-trust prompt shows first.
// The plugin is a temp copy of the hooks plugin, renamed `proof` and given the `pong` skill, so the builder's
// exact args run a cheap slash command instead of a real pod skill.
//
// Windows: OPENAFLOW_REAL_CLAUDE=1 pnpm vitest run packages/pty-host/test/real-claude-start.test.ts

const REAL = process.env.OPENAFLOW_REAL_CLAUDE === '1'
const here = dirname(fileURLToPath(import.meta.url))
const HOOKS_PLUGIN = join(here, '..', '..', 'hooks-plugin', 'plugin')
const PROOF_OVERLAY = join(here, 'fixtures', 'proof-skill')
const PONG = 'PROOF-PONG-4417'
const SPECIAL = `% ^ " ' & | < > ! é 日本`
const require = createRequire(import.meta.url)

type Hook = { at: number; payload: Record<string, unknown> | null }

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

describe.runIf(REAL)('real claude start', () => {
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
      env: process.env,
      platform: process.platform,
    })
    if (typeof cmd === 'string') throw new Error(`sessionCommand refused: ${cmd}`)
    seen.cmd = cmd
    seen.sessionId = sessionId
    const hookFile = join(configDir, 'hooks', `${runMarker}.jsonl`)
    const hooks = (): Hook[] => (existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Hook)
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
    const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
    for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
      const file = join(projects, dir, `${sessionId}.jsonl`)
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        const rec = JSON.parse(line) as { type?: string; message?: { model?: string; content?: unknown } }
        if (rec.type !== 'assistant') continue
        if (rec.message?.model) seen.models.push(rec.message.model)
        const content = Array.isArray(rec.message?.content) ? (rec.message.content as { type: string; text?: string }[]) : []
        for (const c of content) if (c.type === 'text' && c.text) seen.replies.push(c.text)
      }
    }
  }, 300_000)

  afterAll(async () => {
    // One summary line, so a run on another machine shows what it saw.
    const names = seen.hookText.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Hook).payload?.hook_event_name)
    console.log(`real-claude-start: trust prompt ${seen.trustScreen ? 'shown' : 'not shown'}; models ${seen.models.join(', ')}; hooks ${names.join(', ')}`)
    await stop()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  const events = (name: string) =>
    seen.hookText
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Hook)
      .filter((h) => h.payload?.hook_event_name === name)

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
