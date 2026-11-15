import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Board, NewActionEntry } from '@openaflow/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { createBoardService } from './board-service.ts'
import type { GhReader } from './gh.ts'
import type { ParentChannel } from './parent-link.ts'
import { sessionCommand } from './session-command.ts'
import { createSessionRoutes } from './session-routes.ts'
import { createHookReader, createSessionStore, type StoredSession } from './session-store.ts'
import { createSessionToken } from './session-token.ts'
import { createTerminalChannel, TERMINAL_MESSAGE } from './terminal-channel.ts'

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
async function setup(o: { terminals?: boolean; claude?: string | undefined; main?: Main; seed?: StoredSession[]; answerMs?: number } = {}) {
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
  const service = createBoardService({
    configFile: join(cfg, 'config.json'),
    portsDir: join(root, 'ports'),
    claudeDir: join(root, 'claude'),
    transcriptDays: 30,
    platform,
    gh,
    now: () => NOW,
    hosted: { list: store.list, hooks: createHookReader(hooks) },
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
    configDir: cfg,
    env: () => env,
    platform,
    now: () => NOW,
    newId,
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
    env,
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
    expect(s.sent).toEqual([{ type: TERMINAL_MESSAGE, op: 'start', req: 1, spec: { id: M, program: cmd.program, args: cmd.args, cwd: cmd.cwd, env: cmd.env, cols: 100, rows: 40 } }])
    // Saved before the start went out; logged, then the Board rebuilt, before the answer.
    expect(s.events).toEqual(['send start', 'log', 'rebuild'])
    expect(s.board().repos.find((r) => r.id === A)!.hosted).toEqual([
      { marker: M, sessionId: S, liveSession: S, sessions: [S], skill: 'plan', startedAt: NOW, state: 'live', hooked: false, prompted: false },
    ])
    expect(s.logged).toEqual([{ action: 'new-session', repoId: A, repo: 'a', target: '/pod:plan · 00000001', result: 'started' }])
    await s.settle()
    const file = await readFile(join(cfg, 'sessions.json'), 'utf8')
    expect(JSON.parse(file)).toEqual({ v: 1, sessions: [{ marker: M, repoPath: repoA, sessionId: S, skill: 'plan', startedAt: NOW, state: 'live', pid: 4321 }] })
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
    // Shape first.
    for (const body of ['x', {}, { repoId: A }, { repoId: A, marker: 3 }]) expect(await s.post('dismiss-session', body)).toEqual({ status: 400, body: { error: 'bad request' } })
    // Another repo's session, or one the store never had, is no session here.
    expect(await s.post('dismiss-session', { repoId: s.idOf(repoB), marker: M1 })).toEqual({ status: 404, body: { error: 'no session' } })
    expect(await s.post('dismiss-session', { repoId: 'nope', marker: M1 })).toEqual({ status: 404, body: { error: 'no session' } })
    expect(await s.post('dismiss-session', { repoId: A, marker: '../config' })).toEqual({ status: 404, body: { error: 'no session' } })
    // A live one is refused, and keeps its hook file.
    expect(await s.post('dismiss-session', { repoId: A, marker: M2 })).toEqual({ status: 409, body: { error: 'session is live' } })
    expect(existsSync(join(cfg, 'hooks', `${M2}.jsonl`))).toBe(true)
    expect(s.sent).toEqual([])

    expect(await s.post('dismiss-session', { repoId: A, marker: M1 })).toEqual({ status: 200, body: { outcome: 'dismissed', logged: true } })
    expect(s.store.list().map((r) => r.marker)).toEqual([M2, marker(3)])
    expect(existsSync(join(cfg, 'hooks', `${M1}.jsonl`))).toBe(false)
    expect(s.sent).toEqual([{ type: TERMINAL_MESSAGE, op: 'dispose', id: M1 }])
    expect(s.logged).toEqual([{ action: 'dismiss-session', repoId: A, repo: 'a', target: '/pod:plan · 99999991', result: 'dismissed' }])
    expect(s.events.slice(-2)).toEqual(['log', 'rebuild'])
    expect(s.board().repos.find((r) => r.id === A)!.hosted!.map((h) => h.marker)).toEqual([M2])
    // A repeat: no session.
    expect(await s.post('dismiss-session', { repoId: A, marker: M1 })).toEqual({ status: 404, body: { error: 'no session' } })
    // A missing hook file is fine.
    expect(await s.post('dismiss-session', { repoId: s.idOf(repoB), marker: marker(3) })).toMatchObject({ status: 200 })
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
  for (const route of ['new-session', 'dismiss-session']) {
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
