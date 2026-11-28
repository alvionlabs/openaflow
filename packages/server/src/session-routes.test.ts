import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectDirName } from './transcript-files.ts'
import type { Board, NewActionEntry } from '@openaflow/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { createBoardService } from './board-service.ts'
import type { GhReader } from './gh.ts'
import type { ParentChannel } from './parent-link.ts'
import type { ScopeProbe } from './run-wrapper.ts'
import { resumeCommand, sessionCommand } from './session-command.ts'
import { editDenyRule } from './workflow-flags.ts'
import { createSessionRoutes } from './session-routes.ts'
import { createHookReader, createSessionStore, type StoredSession } from './session-store.ts'
import { createSessionToken } from './session-token.ts'
import { createSettingsStore } from './settings-store.ts'
import { createTerminalChannel, TERMINAL_MESSAGE } from './terminal-channel.ts'
import { createWorkflowResolver } from './workflow-resolver.ts'

const API = 3070
const WEB = 3071
const TOKEN = createSessionToken()
const HEADERS = { host: `127.0.0.1:${API}`, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json', 'x-openaflow-token': TOKEN }
const platform = process.platform
const NOW = 1_800_000_000_000
const SECRET = 'zq-never-logged-words'

const gh: GhReader = { status: () => 'unknown', checkedAt: () => undefined, get: () => undefined, getBranch: () => undefined, refresh: async () => false }

let root: string
let cfg: string
let repoA: string
let repoB: string

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'openaflow-session-routes-')))
  cfg = join(root, 'cfg')
  repoA = join(root, 'repos', 'a')
  repoB = join(root, 'repos', 'b')
  await mkdir(cfg, { recursive: true })
  await mkdir(repoA, { recursive: true })
  await mkdir(repoB, { recursive: true })
  await writeFile(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repoA }, { path: repoB }] }))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** UUID v4 ids in order: marker, session, marker, session, … */
function ids() {
  let n = 0
  return () => {
    n++
    return `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
  }
}

type Main = 'started' | 'start-failed' | 'silent'

/**
 * The routes behind the real app and guard, over a real store, board service, and terminal channel. `main` plays the
 * desktop's main process on the channel's other end.
 */
async function setup(
  o: { terminals?: boolean; claude?: string | undefined; main?: Main; seed?: StoredSession[]; answerMs?: number; probe?: ScopeProbe; settings?: Record<string, unknown>; bundle?: boolean } = {},
) {
  if (o.settings) await writeFile(join(cfg, 'settings.json'), JSON.stringify({ v: 1, ...o.settings }))
  else await rm(join(cfg, 'settings.json'), { force: true })
  const lines: string[] = []
  // Each setup starts from its own seed, or from no file.
  if (o.seed) await writeFile(join(cfg, 'sessions.json'), JSON.stringify({ v: 1, sessions: o.seed }))
  else await rm(join(cfg, 'sessions.json'), { force: true })
  const events: string[] = []
  const logged: NewActionEntry[] = []
  const sent: Record<string, unknown>[] = []
  let deliver: (m: unknown) => void = () => {}
  let main: Main = o.main ?? 'started'
  const link: ParentChannel = {
    onMessage: (fn) => void (deliver = fn),
    send: (m) => {
      const msg = m as Record<string, unknown>
      sent.push(msg)
      events.push(`send ${String(msg.op)}`)
      if (msg.op !== 'start') return
      const id = (msg.spec as { id: string }).id
      if (main === 'started') queueMicrotask(() => deliver({ type: TERMINAL_MESSAGE, op: 'started', req: msg.req, id, pid: 4321 }))
      if (main === 'start-failed') queueMicrotask(() => deliver({ type: TERMINAL_MESSAGE, op: 'start-failed', req: msg.req, id, error: 'no folder' }))
    },
  }
  const withTerminals = o.terminals !== false
  const store = createSessionStore({ file: join(cfg, 'sessions.json'), writable: withTerminals, now: () => NOW, log: () => {} })
  const channel = withTerminals ? createTerminalChannel({ link, log: () => {}, answerMs: o.answerMs ?? 30_000 }) : undefined
  const hooks = join(cfg, 'hooks')
  const hookReader = createHookReader(hooks)
  const service = createBoardService({
    configFile: join(cfg, 'config.json'),
    portsDir: join(root, 'ports'),
    claudeDir: join(root, 'claude'),
    transcriptDays: 30,
    platform,
    gh,
    now: () => NOW,
    hosted: { list: store.list, hooks: hookReader },
  })
  let board: Board = await service.build()
  const source = {
    board: () => board,
    subscribe: () => () => {},
    rebuild: async () => {
      events.push('rebuild')
      board = await service.build()
    },
  }
  const claude = 'claude' in o ? o.claude : join(root, 'bin', 'claude')
  const pluginDir = join(root, 'plugin')
  const env = { PATH: '/usr/bin:/bin', HOME: root }
  const newId = ids()
  // A real resolver over a temp bundle at <root>/workflows/claude-pod; `bundle: false` gives none.
  const workflowsRoot = join(root, 'workflows')
  if (o.bundle !== false) {
    await mkdir(join(workflowsRoot, 'claude-pod', '.claude-plugin'), { recursive: true })
    await writeFile(join(workflowsRoot, 'claude-pod', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pod', version: '0.11.10' }))
  } else await rm(workflowsRoot, { recursive: true, force: true })
  const workflowDir = join(workflowsRoot, 'claude-pod')
  const routes = createSessionRoutes({
    board: source.board,
    rebuild: source.rebuild,
    log: {
      append: async (e) => {
        events.push('log')
        logged.push(e)
        return true
      },
    },
    store,
    terminals: channel,
    claude: () => claude,
    pluginDir,
    workflows: createWorkflowResolver({ root: workflowsRoot }),
    configDir: cfg,
    env: () => env,
    platform,
    now: () => NOW,
    newId,
    hooks: hookReader,
    claudeDir: join(root, 'claude'),
    ...(o.probe ? { probe: async () => o.probe! } : {}),
    settings: createSettingsStore({ file: join(cfg, 'settings.json'), log: (l) => lines.push(l) }),
    logLine: (l) => lines.push(l),
  })
  const app = createApp({
    ports: [API, WEB],
    token: TOKEN,
    source,
    addRepo: async () => ({ error: 'not a directory' }),
    timeline: async () => undefined,
    actions: new Hono().route('/', routes),
  })
  const idOf = (path: string) => board.repos.find((r) => r.path === path)!.id
  const post = async (route: string, body: unknown, headers: Record<string, string> = HEADERS) => {
    const res = await app.request(`/api/actions/${route}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return {
    post,
    idOf,
    store,
    sent,
    events,
    logged,
    board: () => board,
    setMain: (m: Main) => void (main = m),
    claude,
    pluginDir,
    workflowDir,
    env,
    lines,
    async settle() {
      await store.saved()
    },
  }
}

const rec = (marker: string, repoPath: string, state: StoredSession['state'], over: Partial<StoredSession> = {}): StoredSession => ({
  marker,
  repoPath,
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  skill: 'plan',
  startedAt: 1,
  state,
  ...over,
})
const marker = (n: number) => `${String(n).padStart(8, '9')}-1111-4111-8111-111111111111`
const PROBE_ON: ScopeProbe = { on: true, systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl' }
/** What a start with `PROBE_ON` sends: the default wrapper and stop; Windows has neither. */
const scoped = (cmd: { program: string; args: string[] }, unit: string) =>
  platform === 'win32'
    ? { run: { program: cmd.program, args: cmd.args }, stop: {} }
    : {
        run: { program: '/usr/bin/systemd-run', args: ['--user', '--scope', '--quiet', `--unit=${unit}`, cmd.program, ...cmd.args] },
        stop: { stop: ['/usr/bin/systemctl', '--user', 'stop', unit] },
      }
const screenOf = (m: string) => join(cfg, 'screens', `${m}.txt`)
const hookOf = (m: string) => join(cfg, 'hooks', `${m}.jsonl`)
/** The conversation file Resume looks for. */
async function conversation(repo: string, session: string) {
  const dir = join(root, 'claude', 'projects', projectDirName(repo))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${session}.jsonl`), '{}\n')
}
async function hookStart(m: string, session: string) {
  await mkdir(join(cfg, 'hooks'), { recursive: true })
  await writeFile(hookOf(m), JSON.stringify({ v: 1, at: 1, payload: { hook_event_name: 'SessionStart', session_id: session, source: 'clear' } }) + '\n')
}

describe('new-session', () => {
  test('new-session errors', async () => {
    // 400 for the shape, before anything else, even with no terminal host.
    const off = await setup({ terminals: false })
    const A = off.idOf(repoA)
    const good = { repoId: A, skill: 'plan', text: 'x' }
    for (const body of [
      'not json',
      {},
      { ...good, repoId: 1 },
      { ...good, skill: 2 },
      { ...good, text: undefined },
      { ...good, cols: 1 },
      { ...good, cols: 501 },
      { ...good, cols: 80.5 },
      { ...good, rows: 0 },
      { ...good, rows: 201 },
      { ...good, rows: '30' },
      [good],
    ]) {
      expect(await off.post('new-session', body)).toEqual({ status: 400, body: { error: 'bad request' } })
    }
    // 409 no terminal host: a server with no channel, whatever the repo.
    expect(await off.post('new-session', { ...good, repoId: 'nope' })).toEqual({ status: 409, body: { error: 'no terminal host' } })
    await off.settle()
    expect(existsSync(join(cfg, 'sessions.json'))).toBe(false)

    // 404 not a repo, even with no claude.
    const noClaude = await setup({ claude: undefined, seed: [rec(marker(1), repoA, 'starting')] })
    expect(await noClaude.post('new-session', { ...good, repoId: 'nope' })).toEqual({ status: 404, body: { error: 'not a repo' } })
    // 409 claude not found, even with a session starting in the repo.
    expect(await noClaude.post('new-session', good)).toEqual({ status: 409, body: { error: 'claude not found' } })

    // 409 session starting, even at the cap.
    const ten = Array.from({ length: 10 }, (_, i) => rec(marker(i + 1), i === 0 ? repoA : repoB, i === 0 ? 'starting' : 'live'))
    const full = await setup({ seed: ten })
    expect(await full.post('new-session', { ...good, skill: 'bad' })).toEqual({ status: 409, body: { error: 'session starting' } })
    // 409 too many sessions, even with a bad skill.
    expect(await full.post('new-session', { ...good, repoId: full.idOf(repoB), skill: 'bad' })).toEqual({ status: 409, body: { error: 'too many sessions' } })

    // 400 with sessionCommand's word.
    await noClaude.settle()
    await full.settle()
    const s = await setup()
    expect(await s.post('new-session', { ...good, skill: 'bad' })).toEqual({ status: 400, body: { error: 'bad skill' } })
    expect(await s.post('new-session', { ...good, text: 'a\u0007b' })).toEqual({ status: 400, body: { error: 'bad text' } })
    expect(await s.post('new-session', { ...good, skill: 'plain', text: '--dangerously' })).toEqual({ status: 400, body: { error: 'bad text' } })
    // A refusal changes nothing: no start sent, no record, no log entry.
    expect(s.sent).toEqual([])
    expect(s.store.list()).toEqual([])
    expect(s.logged).toEqual([])

    // 502 with the host's word: the record goes, and one failed entry is logged.
    s.setMain('start-failed')
    expect(await s.post('new-session', good)).toEqual({ status: 502, body: { error: 'start failed: no folder' } })
    expect(s.store.list()).toEqual([])
    expect(s.logged).toEqual([{ action: 'new-session', repoId: A, repo: 'a', target: '/pod:plan · 00000007', result: 'failed', message: 'no folder' }])
    await s.settle()

    // 504 when main never answers: the record stays starting.
    const silent = await setup({ main: 'silent', answerMs: 20 })
    expect(await silent.post('new-session', good)).toEqual({ status: 504, body: { error: 'terminals unavailable' } })
    expect(silent.store.list().map((r) => r.state)).toEqual(['starting'])
    expect(silent.logged).toEqual([{ action: 'new-session', repoId: A, repo: 'a', target: '/pod:plan · 00000001', result: 'failed', message: 'no answer' }])
    await silent.settle()
  })

  test('new-session starts', async () => {
    const s = await setup()
    const A = s.idOf(repoA)
    const res = await s.post('new-session', { repoId: A, skill: 'plan', text: `  ${SECRET}  `, cols: 100, rows: 40 })
    const M = '00000001-0000-4000-8000-000000000001'
    const S = '00000002-0000-4000-8000-000000000002'
    expect(res).toEqual({ status: 200, body: { outcome: 'started', marker: M, logged: true } })
    // The exact spec sessionCommand gives, with the found claude, the plugin folder, and both new ids.
    const cmd = sessionCommand({ claude: s.claude!, repo: repoA, skill: 'plan', text: `  ${SECRET}  `, sessionId: S, runMarker: M, pluginDir: s.pluginDir, configDir: cfg, env: s.env, platform })
    if (typeof cmd === 'string') throw new Error(cmd)
    // With the probe off (none given): no wrapper and no stop; the screen file is the config folder's.
    expect(s.sent).toEqual([
      { type: TERMINAL_MESSAGE, op: 'start', req: 1, spec: { id: M, program: cmd.program, args: cmd.args, cwd: cmd.cwd, env: cmd.env, cols: 100, rows: 40, screenFile: screenOf(M), scrollback: 5000 } },
    ])
    // Saved before the start went out; logged, then the Board rebuilt, before the answer.
    expect(s.events).toEqual(['send start', 'log', 'rebuild'])
    expect(s.board().repos.find((r) => r.id === A)!.hosted).toEqual([
      { marker: M, sessionId: S, liveSession: S, sessions: [S], skill: 'plan', startedAt: NOW, state: 'live', hooked: false, prompted: false, scrollback: 5000 },
    ])
    expect(s.logged).toEqual([{ action: 'new-session', repoId: A, repo: 'a', target: '/pod:plan · 00000001', result: 'started' }])
    await s.settle()
    const file = await readFile(join(cfg, 'sessions.json'), 'utf8')
    expect(JSON.parse(file)).toEqual({ v: 1, sessions: [{ marker: M, repoPath: repoA, sessionId: S, skill: 'plan', startedAt: NOW, state: 'live', pid: 4321, scrollback: 5000 }] })
    // No text anywhere but the start itself.
    expect(file).not.toContain(SECRET)
    expect(JSON.stringify(s.logged)).not.toContain(SECRET)
    expect(JSON.stringify(s.board())).not.toContain(SECRET)
    // The default size, and a plain session's target.
    const plain = await s.post('new-session', { repoId: s.idOf(repoB), skill: 'plain', text: '' })
    expect(plain.status).toBe(200)
    expect((s.sent[1]!.spec as { cols: number; rows: number; args: string[] })).toMatchObject({ cols: 120, rows: 30 })
    expect(s.logged[1]!.target).toBe('plain · 00000003')
    await s.settle()
  })

  test('new-session runs in the scope when the probe is on', async () => {
    const s = await setup({ probe: PROBE_ON })
    const res = await s.post('new-session', { repoId: s.idOf(repoA), skill: 'plain', text: '' })
    const M = '00000001-0000-4000-8000-000000000001'
    const S = '00000002-0000-4000-8000-000000000002'
    expect(res).toEqual({ status: 200, body: { outcome: 'started', marker: M, logged: true } })
    const cmd = sessionCommand({ claude: s.claude!, repo: repoA, skill: 'plain', text: '', sessionId: S, runMarker: M, pluginDir: s.pluginDir, configDir: cfg, env: s.env, platform })
    if (typeof cmd === 'string') throw new Error(cmd)
    const unit = `openaflow-run-${M}.scope`
    expect(s.sent).toEqual([
      {
        type: TERMINAL_MESSAGE,
        op: 'start',
        req: 1,
        spec: { id: M, ...scoped(cmd, unit).run, cwd: cmd.cwd, env: cmd.env, cols: 120, rows: 30, screenFile: screenOf(M), scrollback: 5000 },
        ...scoped(cmd, unit).stop,
      },
    ])
    await s.settle()
  })

  test('the record is saved before the start goes out', async () => {
    const s = await setup()
    let savedAtSend: string | undefined
    const origin = s.sent.push.bind(s.sent)
    s.sent.push = (...items) => {
      savedAtSend = existsSync(join(cfg, 'sessions.json')) ? JSON.parse(readFileSync(join(cfg, 'sessions.json'), 'utf8')).sessions[0]?.state : 'none'
      return origin(...items)
    }
    await s.post('new-session', { repoId: s.idOf(repoA), skill: 'plan', text: '' })
    expect(savedAtSend).toBe('starting')
    await s.settle()
  })

  test('repeats and the cap', async () => {
    // Two posts at once in one repo: the second sees the first's starting record.
    const s = await setup({ main: 'silent', answerMs: 200 })
    const A = s.idOf(repoA)
    const [one, two] = await Promise.all([s.post('new-session', { repoId: A, skill: 'plan', text: '' }), s.post('new-session', { repoId: A, skill: 'plan', text: '' })])
    expect([one.status, two.status].sort()).toEqual([409, 504])
    expect([one.body, two.body]).toContainEqual({ error: 'session starting' })
    expect(s.sent.filter((m) => m.op === 'start')).toHaveLength(1)
    await s.settle()

    // Nine live and one ended: the 10th starts; then the 11th gives too many sessions. Ended and stopped don't count.
    const nine = Array.from({ length: 9 }, (_, i) => rec(marker(i + 1), repoB, 'live'))
    const cap = await setup({ seed: [...nine, rec(marker(20), repoA, 'ended'), rec(marker(21), repoA, 'stopped', { stopReason: 'app closed' })] })
    expect((await cap.post('new-session', { repoId: cap.idOf(repoA), skill: 'task', text: 'x' })).status).toBe(200)
    expect(await cap.post('new-session', { repoId: cap.idOf(repoA), skill: 'task', text: 'x' })).toEqual({ status: 409, body: { error: 'too many sessions' } })
    await cap.settle()
  })
})

describe('dismiss-session', () => {
  test('dismiss', async () => {
    const M1 = marker(1)
    const M2 = marker(2)
    const s = await setup({ seed: [rec(M1, repoA, 'ended', { exitCode: 0 }), rec(M2, repoA, 'live', { pid: 9 }), rec(marker(3), repoB, 'stopped', { stopReason: 'app closed' })] })
    const A = s.idOf(repoA)
    await mkdir(join(cfg, 'hooks'))
    await writeFile(join(cfg, 'hooks', `${M1}.jsonl`), '{}\n')
    await writeFile(join(cfg, 'hooks', `${M2}.jsonl`), '{}\n')
    await mkdir(join(cfg, 'screens'))
    await writeFile(screenOf(M1), 'old screen')
    await writeFile(screenOf(M2), 'live screen')
    // Shape first.
    for (const body of ['x', {}, { repoId: A }, { repoId: A, marker: 3 }]) expect(await s.post('dismiss-session', body)).toEqual({ status: 400, body: { error: 'bad request' } })
    // Another repo's session, or one the store never had, is no session here.
    expect(await s.post('dismiss-session', { repoId: s.idOf(repoB), marker: M1 })).toEqual({ status: 404, body: { error: 'no session' } })
    expect(await s.post('dismiss-session', { repoId: 'nope', marker: M1 })).toEqual({ status: 404, body: { error: 'no session' } })
    expect(await s.post('dismiss-session', { repoId: A, marker: '../config' })).toEqual({ status: 404, body: { error: 'no session' } })
    // A live one is refused, and keeps its hook file.
    expect(await s.post('dismiss-session', { repoId: A, marker: M2 })).toEqual({ status: 409, body: { error: 'session is live' } })
    expect(existsSync(join(cfg, 'hooks', `${M2}.jsonl`))).toBe(true)
    expect(existsSync(screenOf(M2))).toBe(true)
    expect(s.sent).toEqual([])

    expect(await s.post('dismiss-session', { repoId: A, marker: M1 })).toEqual({ status: 200, body: { outcome: 'dismissed', logged: true } })
    expect(s.store.list().map((r) => r.marker)).toEqual([M2, marker(3)])
    expect(existsSync(join(cfg, 'hooks', `${M1}.jsonl`))).toBe(false)
    expect(existsSync(screenOf(M1))).toBe(false)
    expect(s.sent).toEqual([{ type: TERMINAL_MESSAGE, op: 'dispose', id: M1 }])
    expect(s.logged).toEqual([{ action: 'dismiss-session', repoId: A, repo: 'a', target: '/pod:plan · 99999991', result: 'dismissed' }])
    expect(s.events.slice(-2)).toEqual(['log', 'rebuild'])
    expect(s.board().repos.find((r) => r.id === A)!.hosted!.map((h) => h.marker)).toEqual([M2])
    // A repeat: no session.
    expect(await s.post('dismiss-session', { repoId: A, marker: M1 })).toEqual({ status: 404, body: { error: 'no session' } })
    // A missing hook file and a missing screen file are fine: no message.
    expect(await s.post('dismiss-session', { repoId: s.idOf(repoB), marker: marker(3) })).toMatchObject({ status: 200 })
    expect(s.logged.at(-1)).not.toHaveProperty('message')
    await s.settle()
    expect(JSON.parse(await readFile(join(cfg, 'sessions.json'), 'utf8')).sessions.map((r: StoredSession) => r.marker)).toEqual([M2])

    // No terminal host: 409, and nothing changes.
    const off = await setup({ terminals: false })
    expect(await off.post('dismiss-session', { repoId: off.idOf(repoA), marker: M2 })).toEqual({ status: 409, body: { error: 'no terminal host' } })
  })
})

test('guarded', async () => {
  const s = await setup()
  const noToken: Record<string, string> = { ...HEADERS }
  delete noToken['x-openaflow-token']
  for (const route of ['new-session', 'dismiss-session', 'resume-session']) {
    expect(await s.post(route, { repoId: s.idOf(repoA), skill: 'plan', text: '', marker: marker(1) }, noToken)).toEqual({ status: 403, body: { error: 'bad token' } })
    expect(await s.post(route, { repoId: s.idOf(repoA), skill: 'plan', text: '', marker: marker(1) }, { ...HEADERS, 'x-openaflow-token': 'wrong' })).toEqual({ status: 403, body: { error: 'bad token' } })
  }
  expect(s.sent).toEqual([])
  expect(existsSync(join(cfg, 'sessions.json'))).toBe(false)
  // The same requests with the token reach the routes.
  expect((await s.post('dismiss-session', { repoId: s.idOf(repoA), marker: marker(1) })).body).toEqual({ error: 'no session' })
  expect((await s.post('new-session', { repoId: s.idOf(repoA), skill: 'plan', text: '' })).status).toBe(200)
  await s.settle()
})

describe('resume-session', () => {
  const OLD = marker(1)
  const LIVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  test('resume starts', async () => {
    const s = await setup({ probe: PROBE_ON, seed: [rec(OLD, repoA, 'ended', { skill: 'task', exitCode: 0, endedAt: 5 })] })
    const A = s.idOf(repoA)
    // Its live session is the hook file's newest SessionStart, and that conversation is there.
    await hookStart(OLD, LIVE)
    await conversation(repoA, LIVE)
    await mkdir(join(cfg, 'screens'))
    await writeFile(screenOf(OLD), 'old screen')
    const res = await s.post('resume-session', { repoId: A, marker: OLD, cols: 100, rows: 40 })
    const M = '00000001-0000-4000-8000-000000000001'
    expect(res).toEqual({ status: 200, body: { outcome: 'started', marker: M, logged: true } })
    const cmd = resumeCommand({ claude: s.claude!, repo: repoA, sessionId: LIVE, runMarker: M, pluginDir: s.pluginDir, configDir: cfg, env: s.env, platform })
    if (typeof cmd === 'string') throw new Error(cmd)
    const unit = `openaflow-run-${M}.scope`
    expect(s.sent).toEqual([
      {
        type: TERMINAL_MESSAGE,
        op: 'start',
        req: 1,
        spec: { id: M, ...scoped(cmd, unit).run, cwd: cmd.cwd, env: cmd.env, cols: 100, rows: 40, screenFile: screenOf(M), scrollback: 5000 },
        ...scoped(cmd, unit).stop,
      },
      { type: TERMINAL_MESSAGE, op: 'dispose', id: OLD },
    ])
    expect(cmd.args).toEqual(['--resume', LIVE, '--plugin-dir', s.pluginDir])
    // The old record, its hook file, and its screen file are gone; the new one is live, with the old skill.
    await s.settle()
    expect(s.store.list()).toEqual([{ marker: M, repoPath: repoA, sessionId: LIVE, skill: 'task', startedAt: NOW, state: 'live', pid: 4321, scrollback: 5000, ...scoped(cmd, unit).stop }])
    expect(existsSync(hookOf(OLD))).toBe(false)
    expect(existsSync(screenOf(OLD))).toBe(false)
    expect(s.logged).toEqual([{ action: 'resume-session', repoId: A, repo: 'a', target: '/pod:task · 00000001', result: 'started' }])
    expect(s.events).toEqual(['send start', 'send dispose', 'log', 'rebuild'])
    expect(s.board().repos.find((r) => r.id === A)!.hosted!.map((h) => [h.marker, h.state])).toEqual([[M, 'live']])
    // The default size, a missing hook and screen file, and the probe off: no wrapper, no stop.
    const off = await setup({ seed: [rec(OLD, repoB, 'stopped', { stopReason: 'app closed' })] })
    await conversation(repoB, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect((await off.post('resume-session', { repoId: off.idOf(repoB), marker: OLD })).status).toBe(200)
    expect(off.sent[0]).not.toHaveProperty('stop')
    expect(off.sent[0]!.spec).toMatchObject({ program: off.claude, cols: 120, rows: 30, screenFile: screenOf(M) })
    expect(off.logged.at(-1)).toMatchObject({ target: '/pod:plan · 00000001', result: 'started' })
    await off.settle()
  })

  test('resume errors', async () => {
    const S = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    // Ten open sessions in B, so each case below also breaks "too many sessions".
    const tenB = Array.from({ length: 10 }, (_, i) => rec(marker(i + 10), repoB, 'live', { sessionId: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`, pid: 3 }))
    const good = (repoId: string, m = OLD) => ({ repoId, marker: m })

    // 400 for the shape, even with no terminal host.
    const off = await setup({ terminals: false, seed: [rec(OLD, repoA, 'ended')] })
    const A0 = off.idOf(repoA)
    for (const body of ['x', {}, { repoId: A0 }, { marker: OLD }, { repoId: A0, marker: 1 }, { ...good(A0), cols: 1 }, { ...good(A0), rows: 201 }, [good(A0)]])
      expect(await off.post('resume-session', body)).toEqual({ status: 400, body: { error: 'bad request' } })
    // 409 no terminal host, even for no session.
    expect(await off.post('resume-session', good('nope', marker(99)))).toEqual({ status: 409, body: { error: 'no terminal host' } })

    // 404 no session: not this repo's, not a repo, not stored, or a path. Even with no claude and a starting record here.
    const none = await setup({ claude: undefined, seed: [rec(OLD, repoA, 'ended'), rec(marker(2), repoB, 'starting'), ...tenB] })
    expect(await none.post('resume-session', good(none.idOf(repoB)))).toEqual({ status: 404, body: { error: 'no session' } })
    expect(await none.post('resume-session', good('nope'))).toEqual({ status: 404, body: { error: 'no session' } })
    expect(await none.post('resume-session', good(none.idOf(repoA), marker(98)))).toEqual({ status: 404, body: { error: 'no session' } })
    expect(await none.post('resume-session', good(none.idOf(repoA), '../config'))).toEqual({ status: 404, body: { error: 'no session' } })
    // 409 session is live: the record itself is starting or live.
    expect(await none.post('resume-session', good(none.idOf(repoB), marker(2)))).toEqual({ status: 409, body: { error: 'session is live' } })
    expect(await none.post('resume-session', good(none.idOf(repoB), marker(10)))).toEqual({ status: 409, body: { error: 'session is live' } })
    await none.settle()

    // 409 session starting: another record in this repo is starting; even with no claude and no folder.
    const starting = await setup({ claude: undefined, seed: [rec(OLD, repoA, 'ended'), rec(marker(2), repoA, 'starting'), ...tenB.slice(1)] })
    expect(await starting.post('resume-session', good(starting.idOf(repoA)))).toEqual({ status: 409, body: { error: 'session starting' } })
    await starting.settle()

    // 409 claude not found, even with no folder.
    const noClaude = await setup({ claude: undefined, seed: [rec(OLD, repoA, 'ended'), ...tenB] })
    const A = noClaude.idOf(repoA)
    await rm(repoA, { recursive: true })
    expect(await noClaude.post('resume-session', good(A))).toEqual({ status: 409, body: { error: 'claude not found' } })
    await noClaude.settle()

    // 409 can't resume, each reason in order, with ten open sessions and a relative claude (a bad command).
    const reasons = async (seed: StoredSession[]) => setup({ claude: 'relative/claude', seed })
    let r = await reasons([rec(OLD, repoA, 'ended'), ...tenB])
    await conversation(repoA, S)
    expect(await r.post('resume-session', good(r.idOf(repoA)))).toEqual({ status: 409, body: { error: "can't resume: no folder" } })
    await r.settle()
    await mkdir(repoA, { recursive: true })
    r = await reasons([rec(OLD, repoA, 'ended', { sessionId: LIVE }), rec(marker(30), repoB, 'live', { sessionId: LIVE, pid: 3 }), ...tenB])
    expect(await r.post('resume-session', good(r.idOf(repoA)))).toEqual({ status: 409, body: { error: "can't resume: no conversation" } })
    await r.settle()
    // In use: an open record in another repo holds the session through its hook file.
    await conversation(repoA, LIVE)
    await hookStart(marker(10), LIVE)
    r = await reasons([rec(OLD, repoA, 'ended', { sessionId: LIVE }), ...tenB])
    expect(await r.post('resume-session', good(r.idOf(repoA)))).toEqual({ status: 409, body: { error: "can't resume: in use" } })
    await r.settle()
    await rm(hookOf(marker(10)))

    // 409 too many sessions, with a bad command too.
    r = await reasons([rec(OLD, repoA, 'ended', { sessionId: LIVE }), ...tenB])
    expect(await r.post('resume-session', good(r.idOf(repoA)))).toEqual({ status: 409, body: { error: 'too many sessions' } })
    await r.settle()
    // 400 with resumeCommand's word.
    r = await reasons([rec(OLD, repoA, 'ended', { sessionId: LIVE })])
    expect(await r.post('resume-session', good(r.idOf(repoA)))).toEqual({ status: 400, body: { error: 'bad path' } })
    // A refusal changes nothing: no start, no record, no log.
    expect(r.sent).toEqual([])
    expect(r.store.list().map((x) => x.marker)).toEqual([OLD])
    expect(r.logged).toEqual([])
    await r.settle()

    // 502 with the host's word; 504 with no answer.
    const failed = await setup({ main: 'start-failed', seed: [rec(OLD, repoA, 'ended', { sessionId: LIVE })] })
    expect(await failed.post('resume-session', good(failed.idOf(repoA)))).toEqual({ status: 502, body: { error: 'start failed: no folder' } })
    expect(failed.logged).toEqual([{ action: 'resume-session', repoId: failed.idOf(repoA), repo: 'a', target: '/pod:plan · 00000001', result: 'failed', message: 'no folder' }])
    await failed.settle()
    const silent = await setup({ main: 'silent', answerMs: 20, seed: [rec(OLD, repoA, 'ended', { sessionId: LIVE })] })
    expect(await silent.post('resume-session', good(silent.idOf(repoA)))).toEqual({ status: 504, body: { error: 'terminals unavailable' } })
    expect(silent.logged.at(-1)).toMatchObject({ action: 'resume-session', result: 'failed', message: 'no answer' })
    await silent.settle()
  })

  test('resume edges', async () => {
    const old = rec(OLD, repoA, 'ended', { sessionId: LIVE, exitCode: 0, endedAt: 5 })
    await conversation(repoA, LIVE)
    await hookStart(OLD, LIVE)
    await mkdir(join(cfg, 'screens'))
    await writeFile(screenOf(OLD), 'old screen')

    // A refused start: the new record goes, the old one stays as it was with its files, and nothing is disposed.
    const refused = await setup({ main: 'start-failed', seed: [old] })
    expect((await refused.post('resume-session', { repoId: refused.idOf(repoA), marker: OLD })).status).toBe(502)
    expect(refused.store.list()).toEqual([old])
    expect(refused.sent.map((m) => m.op)).toEqual(['start'])
    expect(existsSync(hookOf(OLD))).toBe(true)
    expect(existsSync(screenOf(OLD))).toBe(true)
    await refused.settle()

    // Two presses at once: the second sees the first's starting record. No answer: 504 keeps the new record
    // starting, with what it resumes, and the old record as it was.
    const s = await setup({ main: 'silent', answerMs: 200, seed: [old] })
    const A = s.idOf(repoA)
    const [one, two] = await Promise.all([s.post('resume-session', { repoId: A, marker: OLD }), s.post('resume-session', { repoId: A, marker: OLD })])
    expect([one.status, two.status].sort()).toEqual([409, 504])
    expect([one.body, two.body]).toContainEqual({ error: 'session starting' })
    expect([one.body, two.body]).toContainEqual({ error: 'terminals unavailable' })
    expect(s.sent.filter((m) => m.op === 'start')).toHaveLength(1)
    const M = '00000001-0000-4000-8000-000000000001'
    expect(s.store.list()).toEqual([old, { marker: M, repoPath: repoA, sessionId: LIVE, skill: 'plan', startedAt: NOW, state: 'starting', resumedFrom: OLD, scrollback: 5000 }])
    expect(existsSync(hookOf(OLD))).toBe(true)
    expect(existsSync(screenOf(OLD))).toBe(true)
    // While the new one is starting, the old one reads in use on the Board.
    expect(s.board().repos.find((r) => r.id === A)!.hosted!.find((h) => h.marker === OLD)!.resume).toBe('in use')
    await s.settle()

    // A repeat after success: no session.
    const ok = await setup({ seed: [old] })
    expect((await ok.post('resume-session', { repoId: ok.idOf(repoA), marker: OLD })).status).toBe(200)
    expect(await ok.post('resume-session', { repoId: ok.idOf(repoA), marker: OLD })).toEqual({ status: 404, body: { error: 'no session' } })
    await ok.settle()
  })
})

describe('settings at a start', () => {
  const WIN = process.platform === 'win32'
  const M = '00000001-0000-4000-8000-000000000001'
  const OLD = marker(1)

  /** `<root>/tools/<name>`: a script that notes its args, then does what `body` says. */
  const tool = (name: string, body: string) => {
    const dir = join(root, 'tools')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), `#!/bin/sh\necho "$*" >> '${dir}/${name}.runs'\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
    return join(dir, name)
  }
  const runs = (name: string) => (existsSync(join(root, 'tools', `${name}.runs`)) ? readFileSync(join(root, 'tools', `${name}.runs`), 'utf8').trim().split('\n') : [])

  test.skipIf(WIN)('refuses a broken wrapper or stop', async () => {
    const wrap = tool('wrap', 'echo "bad option" >&2\nexit 3')
    const cases: [Record<string, unknown>, string][] = [
      [{ runWrapper: join(root, 'gone') }, `run wrapper: ${join(root, 'gone')} not found`],
      [{ runWrapper: 'no-such-wrapper --x' }, 'run wrapper: no-such-wrapper not found'],
      [{ runWrapper: `${wrap} --unit={unit}` }, 'run wrapper: exit 3: bad option'],
      [{ stopCommand: 'no-such-stop {unit}' }, 'stop command: no-such-stop not found'],
      [{ runWrapper: '', stopCommand: 'a/b' }, 'stop command: a/b not found'],
      // The wrapper is refused before the stop.
      [{ runWrapper: 'no-such-wrapper', stopCommand: 'no-such-stop' }, 'run wrapper: no-such-wrapper not found'],
    ]
    for (const [settings, error] of cases) {
      // New session: no record, no start, no entry; one console line.
      const s = await setup({ settings })
      const res = await s.post('new-session', { repoId: s.idOf(repoA), skill: 'plan', text: SECRET })
      expect(res, error).toEqual({ status: 409, body: { error } })
      expect(s.store.list(), error).toEqual([])
      expect(s.sent, error).toEqual([])
      expect(s.logged, error).toEqual([])
      expect(s.lines, error).toEqual([`openaflow: session start refused: ${error}`])
      expect(existsSync(join(cfg, 'sessions.json')), error).toBe(false)

      // Resume: the old record stays as it was, with no new one, no start, and no entry.
      const old = rec(OLD, repoA, 'ended', { exitCode: 0, endedAt: 5 })
      const r = await setup({ settings, seed: [old] })
      await conversation(repoA, old.sessionId)
      const back = await r.post('resume-session', { repoId: r.idOf(repoA), marker: OLD })
      expect(back, error).toEqual({ status: 409, body: { error } })
      expect(r.store.list(), error).toEqual([old])
      expect(r.sent, error).toEqual([])
      expect(r.logged, error).toEqual([])
      expect(r.lines, error).toEqual([`openaflow: session start refused: ${error}`])
    }

    const broken = { runWrapper: 'no-such-wrapper' }
    // New session: after claude not found, before session starting.
    const noClaude = await setup({ settings: broken, claude: undefined })
    expect((await noClaude.post('new-session', { repoId: noClaude.idOf(repoA), skill: 'plan', text: '' })).body).toEqual({ error: 'claude not found' })
    const starting = await setup({ settings: broken, seed: [rec(marker(2), repoA, 'starting')] })
    expect((await starting.post('new-session', { repoId: starting.idOf(repoA), skill: 'plan', text: '' })).body).toEqual({ error: 'run wrapper: no-such-wrapper not found' })

    // Resume: after the first no session, before the checks that follow it (session is live, session starting).
    const none = await setup({ settings: broken, seed: [rec(OLD, repoA, 'ended')] })
    expect((await none.post('resume-session', { repoId: none.idOf(repoA), marker: marker(9) })).body).toEqual({ error: 'no session' })
    const live = await setup({ settings: broken, seed: [rec(OLD, repoA, 'live', { pid: 3 })] })
    expect((await live.post('resume-session', { repoId: live.idOf(repoA), marker: OLD })).body).toEqual({ error: 'run wrapper: no-such-wrapper not found' })
    expect(live.lines).toEqual(['openaflow: session start refused: run wrapper: no-such-wrapper not found'])

    // A good start after the wrapper is fixed: the failure was not cached.
    expect(runs('wrap')).toHaveLength(2)
    writeFileSync(wrap, `#!/bin/sh\necho "$*" >> '${join(root, 'tools')}/wrap.runs'\nexit 0\n`)
    const fixed = await setup({ settings: { runWrapper: `${wrap} --unit={unit}` } })
    expect((await fixed.post('new-session', { repoId: fixed.idOf(repoA), skill: 'plan', text: '' })).status).toBe(200)
    expect(runs('wrap')).toHaveLength(3)
    await fixed.settle()
  })

  test('a start uses the settings in force', async () => {
    const wrap = WIN ? '' : tool('wrap', 'shift\nexec "$@"')
    const stopper = WIN ? '' : tool('stopper', 'exit 0')
    const unit = `openaflow-run-${M}.scope`
    const s = await setup({ settings: WIN ? { scrollback: 300 } : { scrollback: 300, runWrapper: `${wrap} --unit={unit}`, stopCommand: `${stopper} {unit} {runId}` } })
    expect((await s.post('new-session', { repoId: s.idOf(repoA), skill: 'plan', text: '' })).status).toBe(200)
    const spec = s.sent[0]!.spec as { program: string; args: string[]; scrollback: number }
    expect(spec.scrollback).toBe(300)
    await s.settle()
    const first = s.store.list()[0]!
    expect(first.scrollback).toBe(300)
    if (!WIN) {
      expect(spec.program).toBe(wrap)
      expect(spec.args.slice(0, 2)).toEqual([`--unit=${unit}`, s.claude])
      expect(s.sent[0]!.stop).toEqual([stopper, unit, M])
      expect(first.stop).toEqual([stopper, unit, M])
    }
    // The Board's session carries the scrollback; never the stop.
    expect(s.board().repos.find((r) => r.path === repoA)!.hosted![0]!.scrollback).toBe(300)
    expect(JSON.stringify(s.board())).not.toContain(stopper || 'no-stopper')

    // A change between two starts applies to the second only.
    await writeFile(join(cfg, 'settings.json'), JSON.stringify({ v: 1, scrollback: 400, runWrapper: '' }))
    expect((await s.post('new-session', { repoId: s.idOf(repoB), skill: 'plan', text: '' })).status).toBe(200)
    const second = s.sent[1]!
    expect(second.spec).toMatchObject({ program: s.claude, scrollback: 400 })
    expect(second).not.toHaveProperty('stop')
    await s.settle()
    const [a, b] = s.store.list()
    expect(a).toEqual(first)
    expect(b!.scrollback).toBe(400)
    expect(b).not.toHaveProperty('stop')

    // Resume reads them too; no file is the defaults.
    const old = rec(OLD, repoA, 'ended', { exitCode: 0, endedAt: 5, scrollback: 300 })
    const r = await setup({ seed: [old] })
    await conversation(repoA, old.sessionId)
    expect((await r.post('resume-session', { repoId: r.idOf(repoA), marker: OLD })).status).toBe(200)
    expect(r.sent[0]!.spec).toMatchObject({ scrollback: 5000 })
    await r.settle()
    expect(r.store.list()[0]!.scrollback).toBe(5000)
    expect(r.lines).toEqual([])
  })
})

/** Makes `repo` a set-up repo: `.openaflow/`, and one workflow folder per entry, with its `workflow.json` when given. */
async function setUp(repo: string, workflows: { name: string; json?: unknown }[]) {
  await mkdir(join(repo, '.openaflow', 'workflows'), { recursive: true })
  for (const w of workflows) {
    await mkdir(join(repo, '.openaflow', 'workflows', w.name, 'state'), { recursive: true })
    if (w.json !== undefined) await writeFile(join(repo, '.openaflow', 'workflows', w.name, 'workflow.json'), JSON.stringify(w.json))
  }
}

describe('the workflow plugin', () => {
  const M = '00000001-0000-4000-8000-000000000001'
  const S = '00000002-0000-4000-8000-000000000002'
  const OLD = marker(1)
  const LIVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const argsOf = (sent: Record<string, unknown>[], i = 0) => (sent.filter((m) => m.op === 'start')[i]!.spec as { args: string[] }).args
  /** An ended session in `repo` that Resume can start: its live session's hook line and conversation are there. */
  const resumable = async (repo: string) => {
    await hookStart(OLD, LIVE)
    await conversation(repo, LIVE)
  }

  test('starts with the workflow', async () => {
    await setUp(repoA, [{ name: 'claude-pod', json: { source: 'claude-pod', version: '0.11.10' } }])
    const s = await setup()
    expect(s.board().repos.find((r) => r.path === repoA)!.model.openaflow).toBe(true)
    const res = await s.post('new-session', { repoId: s.idOf(repoA), skill: 'plan', text: 'x' })
    expect(res).toEqual({ status: 200, body: { outcome: 'started', marker: M, logged: true } })
    const cmd = sessionCommand({ claude: s.claude!, repo: repoA, skill: 'plan', text: 'x', sessionId: S, runMarker: M, pluginDir: s.pluginDir, workflowDir: s.workflowDir, configDir: cfg, env: s.env, platform })
    if (typeof cmd === 'string') throw new Error(cmd)
    expect(cmd.args).toEqual(['--session-id', S, '--plugin-dir', s.pluginDir, '--add-dir', s.workflowDir, '--disallowedTools', editDenyRule(s.workflowDir, platform), '--plugin-dir', s.workflowDir, '/pod:plan x'])
    expect(argsOf(s.sent)).toEqual(cmd.args)
    await s.settle()

    // `.openaflow/` with no workflow folder, a workflow with no `workflow.json`, an unknown source before a known one,
    // and a workflow with no source: each uses the bundle.
    const cases: [string, { name: string; json?: unknown }[]][] = [
      ['no workflow folders', []],
      ['no workflow.json', [{ name: 'claude-pod' }]],
      ['unknown then known', [{ name: 'a-other', json: { source: 'other-flow' } }, { name: 'b-pod', json: { source: 'claude-pod' } }]],
      ['no source', [{ name: 'mine', json: { version: '0.1.0' } }]],
      // A source outside the name rule is no source (contract §4), so it uses the default too.
      ['a source outside the name rule', [{ name: 'mine', json: { source: 'Claude-Pod' } }]],
    ]
    for (const [what, workflows] of cases) {
      await rm(join(repoB, '.openaflow'), { recursive: true, force: true })
      await setUp(repoB, workflows)
      const t = await setup()
      expect((await t.post('new-session', { repoId: t.idOf(repoB), skill: 'plain', text: '' })).status, what).toBe(200)
      expect(argsOf(t.sent), what).toEqual(['--session-id', S, '--plugin-dir', t.pluginDir, '--add-dir', t.workflowDir, '--disallowedTools', editDenyRule(t.workflowDir, platform), '--plugin-dir', t.workflowDir])
      await t.settle()
    }
  })

  test('resume with the workflow', async () => {
    await setUp(repoA, [{ name: 'claude-pod', json: { source: 'claude-pod', version: '0.11.10' } }])
    const s = await setup({ seed: [rec(OLD, repoA, 'ended', { exitCode: 0, endedAt: 5 })] })
    await resumable(repoA)
    expect((await s.post('resume-session', { repoId: s.idOf(repoA), marker: OLD })).body).toEqual({ outcome: 'started', marker: M, logged: true })
    const cmd = resumeCommand({ claude: s.claude!, repo: repoA, sessionId: LIVE, runMarker: M, pluginDir: s.pluginDir, workflowDir: s.workflowDir, configDir: cfg, env: s.env, platform })
    if (typeof cmd === 'string') throw new Error(cmd)
    expect(argsOf(s.sent)).toEqual(['--resume', LIVE, '--plugin-dir', s.pluginDir, '--add-dir', s.workflowDir, '--disallowedTools', editDenyRule(s.workflowDir, platform), '--plugin-dir', s.workflowDir])
    expect(argsOf(s.sent)).toEqual(cmd.args)
    await s.settle()
  })

  test('not set up starts as today', async () => {
    // A repo with pod-docs/ and one with no docs, with a bundle and with none: the hooks plugin only.
    await mkdir(join(repoB, 'pod-docs'), { recursive: true })
    await writeFile(join(repoB, 'pod-docs', 'handoff-queue.md'), '# Handoff Queue\n')
    for (const bundle of [true, false]) {
      for (const repo of [repoA, repoB]) {
        const what = `${repo === repoA ? 'no docs' : 'pod-docs'}, bundle ${bundle}`
        const s = await setup({ bundle })
        expect(s.board().repos.find((r) => r.path === repo)!.model.openaflow, what).toBeUndefined()
        expect((await s.post('new-session', { repoId: s.idOf(repo), skill: 'plan', text: '' })).status, what).toBe(200)
        expect(argsOf(s.sent), what).toEqual(['--session-id', S, '--plugin-dir', s.pluginDir, '/pod:plan'])
        await s.settle()

        await rm(join(cfg, 'hooks'), { recursive: true, force: true })
        const r = await setup({ bundle, seed: [rec(OLD, repo, 'ended', { exitCode: 0, endedAt: 5 })] })
        await resumable(repo)
        expect((await r.post('resume-session', { repoId: r.idOf(repo), marker: OLD })).status, what).toBe(200)
        expect(argsOf(r.sent), what).toEqual(['--resume', LIVE, '--plugin-dir', r.pluginDir])
        await r.settle()
      }
    }
  })

  test('workflow missing', async () => {
    const cases: [string, { name: string; json?: unknown }[], boolean][] = [
      ['no bundle', [{ name: 'claude-pod', json: { source: 'claude-pod' } }], false],
      ['no bundle, no workflow folders', [], false],
      ['only unknown sources', [{ name: 'a', json: { source: 'other-flow' } }, { name: 'b', json: { source: 'pod' } }], true],
    ]
    for (const [what, workflows, bundle] of cases) {
      await rm(join(repoA, '.openaflow'), { recursive: true, force: true })
      await setUp(repoA, workflows)
      // New session: no record, no start, no log entry.
      const s = await setup({ bundle })
      expect(await s.post('new-session', { repoId: s.idOf(repoA), skill: 'plan', text: SECRET }), what).toEqual({ status: 409, body: { error: 'workflow missing' } })
      expect(s.sent, what).toEqual([])
      expect(s.store.list(), what).toEqual([])
      expect(s.logged, what).toEqual([])
      await s.settle()
      expect(existsSync(join(cfg, 'sessions.json')), what).toBe(false)

      // Resume: the old record stays as it was, with no new one, no start, and no log entry.
      const old = rec(OLD, repoA, 'ended', { exitCode: 0, endedAt: 5 })
      const r = await setup({ bundle, seed: [old] })
      await resumable(repoA)
      expect(await r.post('resume-session', { repoId: r.idOf(repoA), marker: OLD }), what).toEqual({ status: 409, body: { error: 'workflow missing' } })
      expect(r.sent, what).toEqual([])
      expect(r.store.list(), what).toEqual([old])
      expect(r.logged, what).toEqual([])
      expect(existsSync(hookOf(OLD)), what).toBe(true)
      await r.settle()
    }

    // Where it sits: after not a repo and claude not found; a set-up repo with a bundle still meets the later checks.
    await rm(join(repoA, '.openaflow'), { recursive: true, force: true })
    await setUp(repoA, [])
    const noClaude = await setup({ bundle: false, claude: undefined })
    expect((await noClaude.post('new-session', { repoId: noClaude.idOf(repoA), skill: 'plan', text: '' })).body).toEqual({ error: 'claude not found' })
    const noSession = await setup({ bundle: false, seed: [rec(OLD, repoA, 'ended')] })
    expect((await noSession.post('resume-session', { repoId: noSession.idOf(repoA), marker: marker(9) })).body).toEqual({ error: 'no session' })
  })
})
