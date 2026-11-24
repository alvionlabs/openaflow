import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Board, HostedSession } from '@openaflow/model'
import { describe, expect, test } from 'vitest'
import { projectDirName } from '../../server/src/transcript-files.ts'
import { DESKTOP, harnessDir, launchHarness, packagedApp, removeWithRetry, type Harness } from '../test/electron-harness.ts'
import { hooksPluginDir, workflowsRoot } from './pty-host-launch.ts'
import type { TestQuit, TestTerminals } from './test-hooks-main.ts'

// Hosted sessions through the product path, in the real Electron app: the New session and Dismiss routes, the
// server's session store, main's terminal link, and the pty host, with test/fixtures/fake-session-claude.mjs as
// `claude` (OPENAFLOW_CLAUDE_BIN). The fake writes one line per start beside its own copy, and its `SessionStart`
// hook line only once the test makes a gate file there. Temp folders only; never the real `claude`.
// With OPENAFLOW_PACKAGED_APP, only the new session and the Windows shims run, on that build.
// `pnpm test:electron real-session` runs this after `pnpm build`. The rules are in pod-docs/sprints/terminal-tab.md.

const WIN = process.platform === 'win32'
const PACKAGED = packagedApp() !== undefined
const RUN_MS = 240_000
const FIXTURE = join(DESKTOP, 'test', 'fixtures', 'fake-session-claude.mjs')
const META = /<meta name="openaflow-token" content="([^"]+)"/
/** Wide, so a printed arg never wraps. */
const SIZE = { cols: 400, rows: 30 }
/** A space and an `&`: whole in argv only if no cmd.exe read it. */
const TEXT = 'hello & world'
const PROMPT = `/pod:task ${TEXT}`

type Hooked = typeof globalThis & { __openaflowTest?: { terminals?: TestTerminals; quit?: TestQuit } }
type Start = { pid: number; execPath: string; args: string[] }
type Answer = { status: number; body: Record<string, unknown> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const planDoc = ['# Plan: alpha', '', '_Generated: 2026-11-01 · Status: active_', '', '## Sprint sequence', '', '| Sprint | Goal | Status | Depends on |', '|---|---|---|---|', '| one | goal | done | — |', '| two | goal | planned | — |', ''].join('\n')
const sprintDoc = ['# Sprint: one', '', '_From plan: pod-docs/plans/alpha.md · Slug: one · Status: active · Generated: 2026-11-01_', '', '## Status board', '', '| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |', '|---|---|---|---|---|---|---|---|', '| 1 | A1 | a | one-A1 | merged | done | high | — |', ''].join('\n')

/** One test's folders: the harness's, a registered repo with a stopped plan `alpha`, and the fake `claude`. */
type World = { dir: string; cfg: string; repo: string; bin: string; claude: string }

function makeWorld(): World {
  const dir = harnessDir()
  const cfg = join(dir, 'cfg')
  const repo = join(dir, 'repos', 'alpha-repo')
  const bin = join(dir, 'bin')
  for (const d of [cfg, bin, join(repo, 'pod-docs', 'plans'), join(repo, 'pod-docs', 'sprints')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(repo, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
  writeFileSync(join(repo, 'pod-docs', 'handoff-queue.md'), '# Handoff Queue\n')
  writeFileSync(join(repo, 'pod-docs', 'plans', 'alpha.md'), planDoc)
  writeFileSync(join(repo, 'pod-docs', 'sprints', 'one.md'), sprintDoc)
  writeFileSync(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
  let claude: string
  if (WIN) {
    // The npm shim form `shimTarget` reads, with its own node.exe: `sessionCommand` runs node plus the script.
    copyFileSync(FIXTURE, join(bin, 'fake-session-claude.mjs'))
    copyFileSync(process.execPath, join(bin, 'node.exe'))
    claude = join(bin, 'claude.cmd')
    writeNpmShim(claude)
  } else {
    claude = join(bin, 'claude')
    copyFileSync(FIXTURE, claude)
    chmodSync(claude, 0o755)
    // An extensionless copy: this tells node it is a module.
    writeFileSync(join(bin, 'package.json'), '{"type":"module"}\n')
  }
  return { dir, cfg, repo, bin, claude }
}

const writeNpmShim = (file: string) => writeFileSync(file, ['@ECHO off', 'SET dp0=%~dp0', '"%dp0%\\fake-session-claude.mjs" %*', ''].join('\r\n'))
/** No `"%dp0%\…" %*` line, so the server can't read it and runs it through cmd.exe. */
const writeOpaqueShim = (w: World) => writeFileSync(w.claude, ['@ECHO off', `"${join(w.bin, 'node.exe')}" "${join(w.bin, 'fake-session-claude.mjs')}" %*`, ''].join('\r\n'))

/** Each start of the fake, in order. */
const starts = (w: World): Start[] => {
  const file = join(w.bin, 'starts.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Start) : []
}
/** The fake writes its `SessionStart` line once this file is there. */
const openGate = (w: World) => writeFileSync(join(w.bin, 'hook-gate'), '')
const endFakes = (w: World) => {
  for (const { pid } of starts(w)) {
    try {
      process.kill(pid)
    } catch {
      // Already gone.
    }
  }
}

const launch = (w: World) => launchHarness({ dir: w.dir, env: { OPENAFLOW_CLAUDE_BIN: w.claude } })

// --- The server, as the page talks to it ---

const base = (h: Harness) => `http://127.0.0.1:${h.port}`
const board = async (h: Harness) => (await (await fetch(`${base(h)}/api/board`, { signal: AbortSignal.timeout(5_000) })).json()) as Board
const token = async (h: Harness) => META.exec(await (await fetch(`${base(h)}/`)).text())![1]!

async function post(h: Harness, route: string, body: unknown): Promise<Answer> {
  const res = await fetch(`${base(h)}/api/actions/${route}`, {
    method: 'POST',
    headers: { Origin: base(h), 'Content-Type': 'application/json', 'X-OpenAFlow-Token': await token(h) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const health = async (h: Harness) => {
  try {
    const res = await fetch(`${base(h)}/api/health`, { signal: AbortSignal.timeout(2_000) })
    return res.status === 200
  } catch {
    return false
  }
}

const repoOf = async (h: Harness, w: World) => (await board(h)).repos.find((r) => r.path === w.repo || r.name === 'alpha-repo')
const hosted = async (h: Harness, w: World, marker: string): Promise<HostedSession | undefined> => (await repoOf(h, w))?.hosted?.find((s) => s.marker === marker)

const hooks = (h: Harness) => ({
  ready: () => h.app.evaluate(() => (globalThis as Hooked).__openaflowTest?.terminals !== undefined),
  list: () => h.app.evaluate(() => (globalThis as Hooked).__openaflowTest!.terminals!.list()),
  kill: (id: string) => h.app.evaluate((_e, id) => (globalThis as Hooked).__openaflowTest!.terminals!.kill(id), id),
  snapshot: (id: string) => h.app.evaluate((_e, id) => (globalThis as Hooked).__openaflowTest!.terminals!.snapshot(id), id),
  hostPid: () => h.app.evaluate(() => (globalThis as Hooked).__openaflowTest!.terminals!.hostPid()),
})

const readText = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '(none)')

/** Every failed wait shows the logs, the store, the fake's starts, and each screen, so one CI run shows it all. */
async function details(h: Harness, w: World): Promise<string> {
  const screens: string[] = []
  try {
    for (const s of await hooks(h).list()) screens.push(`--- ${s.id} (pid ${s.pid}, live ${s.live}):\n${(await hooks(h).snapshot(s.id)) ?? '(none)'}`)
  } catch (err) {
    screens.push(`(no screens: ${String(err)})`)
  }
  return [
    `starts: ${JSON.stringify(starts(w))}`,
    `sessions.json: ${readText(join(w.cfg, 'sessions.json'))}`,
    `actions.jsonl: ${readText(join(w.cfg, 'actions.jsonl')).slice(-2_000)}`,
    `screens:\n${screens.join('\n')}`,
    `desktop.log:\n${readText(join(w.dir, 'shell', 'desktop.log')).slice(-6_000)}`,
  ].join('\n')
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms: number, h: Harness, w: World): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      if (await ok()) return
    } catch {
      // A fetch while the server restarts; try again.
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${await details(h, w)}`)
    await sleep(200)
  }
}

/** The repo on the Board and the test hook in main, then a New session through the route. */
async function newSession(h: Harness, w: World): Promise<{ answer: Answer; repoId: string }> {
  await until('the repo on the Board', async () => (await repoOf(h, w)) !== undefined, 60_000, h, w)
  await until('the test hook (is this a --test-hooks build?)', () => hooks(h).ready(), 60_000, h, w)
  const repoId = (await repoOf(h, w))!.id
  const answer = await post(h, 'new-session', { repoId, skill: 'task', text: TEXT, ...SIZE })
  return { answer, repoId }
}

/** The plugin folder main gives the server, for this build. Unpackaged, the harness names the desktop package as the app's folder. */
async function pluginDir(h: Harness): Promise<string> {
  const place = await h.app.evaluate(({ app }) => ({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }))
  const dir = hooksPluginDir({ ...place, appPath: DESKTOP })
  expect(existsSync(join(dir, '.claude-plugin', 'plugin.json')), dir).toBe(true)
  return dir
}

/** The bundled workflow folder main names in OPENAFLOW_WORKFLOWS_DIR, for this build (`pnpm build` makes it). */
async function workflowDir(h: Harness): Promise<string> {
  const place = await h.app.evaluate(({ app }) => ({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }))
  const dir = join(workflowsRoot({ ...place, appPath: DESKTOP }), 'claude-pod')
  expect(existsSync(join(dir, '.claude-plugin', 'plugin.json')), dir).toBe(true)
  return dir
}

/** Makes the world's repo a set-up repo: `.openaflow/workflows/claude-pod/` with its `workflow.json` and state folder. */
function setUpRepo(w: World): void {
  const folder = join(w.repo, '.openaflow', 'workflows', 'claude-pod')
  mkdirSync(join(folder, 'state'), { recursive: true })
  writeFileSync(join(folder, 'workflow.json'), JSON.stringify({ source: 'claude-pod', version: '0.11.10' }, null, 2) + '\n')
}

/** A started session, live and then hooked on the Board. Answers its marker and its record's pid. */
async function liveSession(h: Harness, w: World): Promise<{ marker: string; repoId: string; sessionId: string }> {
  const { answer, repoId } = await newSession(h, w)
  expect(answer, await details(h, w)).toMatchObject({ status: 200, body: { outcome: 'started', logged: true } })
  const marker = answer.body.marker as string
  await until('the session live', async () => (await hosted(h, w, marker))?.state === 'live', 15_000, h, w)
  openGate(w)
  await until('the session hooked', async () => (await hosted(h, w, marker))?.hooked === true, 15_000, h, w)
  return { marker, repoId, sessionId: (await hosted(h, w, marker))!.sessionId }
}

/** A transcript that joins `session` to plan `alpha`: its sprint stopped, with one engineer, quiet for two hours. */
function joinToRun(w: World, session: string): void {
  const project = join(w.dir, 'claude', 'projects', projectDirName(w.repo))
  const sub = join(project, session, 'subagents')
  mkdirSync(sub, { recursive: true })
  const old = new Date(Date.now() - 7_200_000)
  const at = old.toISOString()
  const mainFile = join(project, `${session}.jsonl`)
  writeFileSync(mainFile, JSON.stringify({ type: 'user', cwd: w.repo, message: { role: 'user', content: 'go' } }) + '\n')
  const meta = join(sub, 'agent-eng1.meta.json')
  writeFileSync(meta, JSON.stringify({ agentType: 'pod:engineer', description: 'Build A1' }))
  const agent = join(sub, 'agent-eng1.jsonl')
  const lines = [
    { type: 'user', cwd: w.repo, timestamp: at, message: { role: 'user', content: '- **sprint slug:** one\n- **slice code:** A1\n- **branch name:** one-A1\n' } },
    { type: 'assistant', cwd: w.repo, timestamp: at, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x.ts' } }] } },
  ]
  writeFileSync(agent, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  for (const p of [mainFile, meta, agent, sub, join(project, session)]) utimesSync(p, old, old)
}

/** Dismiss frees the session: the record, the hook file, and the host's session are gone, and a repeat is `404`. */
async function dismissCheck(h: Harness, w: World, repoId: string, marker: string): Promise<void> {
  expect(await post(h, 'dismiss-session', { repoId, marker }), await details(h, w)).toEqual({ status: 200, body: { outcome: 'dismissed', logged: true } })
  expect(await hosted(h, w, marker)).toBeUndefined()
  expect(existsSync(join(w.cfg, 'hooks', `${marker}.jsonl`))).toBe(false)
  await until('the host to drop the session', async () => (await hooks(h).list()).every((s) => s.id !== marker), 15_000, h, w)
  expect(await post(h, 'dismiss-session', { repoId, marker })).toEqual({ status: 404, body: { error: 'no session' } })
}

// --- The checks ---

async function productPathCheck(h: Harness, w: World): Promise<void> {
  // With OPENAFLOW_PACKAGED_APP, the packaged build answers, not Electron's own binary on the bundles.
  expect(await h.app.evaluate(({ app }) => app.isPackaged)).toBe(PACKAGED)
  const { answer, repoId } = await newSession(h, w)
  expect(answer, await details(h, w)).toMatchObject({ status: 200, body: { outcome: 'started', logged: true } })
  expect(answer.body.typeYourself).toBeUndefined()
  const marker = answer.body.marker as string

  // The Board was rebuilt before the answer: live, and no hook line yet (the gate is shut).
  const first = await hosted(h, w, marker)
  expect(first, await details(h, w)).toMatchObject({ marker, skill: 'task', state: 'live', hooked: false })
  const sessionId = first!.sessionId

  // The spec's args: the session id, the plugin folder, and the prompt last, whole. The pid comes at the spawn,
  // so the fake may not have written its line yet.
  await until('the fake to start', () => starts(w).length > 0, 15_000, h, w)
  expect(starts(w)).toHaveLength(1)
  expect(starts(w)[0]!.args).toEqual(['--session-id', sessionId, '--plugin-dir', await pluginDir(h), PROMPT])
  await until('the args on the screen', async () => ((await hooks(h).snapshot(marker)) ?? '').includes(`arg 4: ${PROMPT}`), 15_000, h, w)

  openGate(w)
  await until('the session hooked', async () => (await hosted(h, w, marker))?.hooked === true, 15_000, h, w)
  expect(await hosted(h, w, marker)).toMatchObject({ state: 'live', liveSession: sessionId, sessions: [sessionId] })

  // A live session can't be dismissed.
  expect(await post(h, 'dismiss-session', { repoId, marker })).toEqual({ status: 409, body: { error: 'session is live' } })

  // No `-p` send to a hosted session: a run joins it, and neither the reply route nor the automatic check sends.
  joinToRun(w, sessionId)
  await until('plan alpha on the Board', async () => ((await repoOf(h, w))?.agents ?? []).some((a) => a.session === sessionId), 30_000, h, w)
  expect(await post(h, 'resume', { repoId, run: 'alpha', reply: 'continue' })).toEqual({ status: 409, body: { error: 'hosted session' } })
  expect(await post(h, 'auto-continue', { repoId, run: 'alpha', on: true })).toEqual({ status: 200, body: { on: true } })
  // The toggle wakes the check at once; give it time to act.
  await sleep(5_000)
  expect(starts(w)).toHaveLength(1)
  expect(readText(join(w.cfg, 'actions.jsonl'))).not.toContain('"action":"resume"')
  for (const name of readdirSync(w.cfg)) if (name.endsWith('.json')) expect(readText(join(w.cfg, name)), name).not.toContain('lastFailed')

  // The program ends: the Board reads ended, and Dismiss frees it.
  await hooks(h).kill(marker)
  await until('the session ended', async () => (await hosted(h, w, marker))?.state === 'ended', 15_000, h, w)
  await dismissCheck(h, w, repoId, marker)

  // The control: dismissed, the session is no longer hosted, and the toggle, still on, sends `continue` with `-p`.
  await until('the automatic check to send', () => starts(w).some((s) => s.args.includes('-p')), 40_000, h, w)
  expect(starts(w).at(-1)!.args).toEqual(['-p', '--resume', sessionId, 'continue'])
}

/** A set-up repo's new session loads the hooks plugin, then the bundled workflow, then the prompt. */
async function twoPluginDirsCheck(h: Harness, w: World): Promise<void> {
  const { answer } = await newSession(h, w)
  expect(answer, await details(h, w)).toMatchObject({ status: 200, body: { outcome: 'started', logged: true } })
  const marker = answer.body.marker as string
  const sessionId = (await hosted(h, w, marker))!.sessionId
  await until('the fake to start', () => starts(w).length > 0, 15_000, h, w)
  expect(starts(w)[0]!.args).toEqual(['--session-id', sessionId, '--plugin-dir', await pluginDir(h), '--plugin-dir', await workflowDir(h), PROMPT])
  // The Board names the bundle's version, read from its plugin.json.
  const version = (JSON.parse(readFileSync(join(await workflowDir(h), '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }).version
  expect((await board(h)).workflow).toEqual({ source: 'claude-pod', version })
  await hooks(h).kill(marker)
  await until('the session ended', async () => (await hosted(h, w, marker))?.state === 'ended', 15_000, h, w)
}

async function windowsShimsCheck(h: Harness, w: World): Promise<void> {
  // A readable npm shim: node plus the script, with the prompt whole.
  const npm = await newSession(h, w)
  expect(npm.answer, await details(h, w)).toMatchObject({ status: 200, body: { outcome: 'started' } })
  expect(npm.answer.body.typeYourself).toBeUndefined()
  const npmMarker = npm.answer.body.marker as string
  await until('the npm shim session live', async () => (await hosted(h, w, npmMarker))?.state === 'live', 15_000, h, w)
  await until('the npm shim to start the fake', () => starts(w).length > 0, 15_000, h, w)
  const viaNode = starts(w)[0]!
  expect(viaNode.execPath.toLowerCase()).toBe(join(w.bin, 'node.exe').toLowerCase())
  expect(viaNode.args).toEqual(['--session-id', (await hosted(h, w, npmMarker))!.sessionId, '--plugin-dir', await pluginDir(h), PROMPT])
  openGate(w)
  await until('the npm shim session hooked', async () => (await hosted(h, w, npmMarker))?.hooked === true, 15_000, h, w)

  // A shim only cmd.exe can read: no prompt in the args, and the answer hands it back to type.
  writeOpaqueShim(w)
  const cmd = await post(h, 'new-session', { repoId: npm.repoId, skill: 'task', text: TEXT, ...SIZE })
  expect(cmd, await details(h, w)).toMatchObject({ status: 200, body: { outcome: 'started', typeYourself: PROMPT } })
  const cmdMarker = cmd.body.marker as string
  await until('the cmd.exe session live', async () => (await hosted(h, w, cmdMarker))?.state === 'live', 15_000, h, w)
  await until('the cmd.exe route to start the fake', () => starts(w).length === 2, 15_000, h, w)
  const viaCmd = starts(w)[1]!
  const session = (await hosted(h, w, cmdMarker))!
  expect(viaCmd.args).toEqual(['--session-id', session.sessionId, '--plugin-dir', await pluginDir(h)])
  expect(session.typeYourself).toBe(true)
  await until('the cmd.exe session hooked', async () => (await hosted(h, w, cmdMarker))?.hooked === true, 15_000, h, w)

  for (const marker of [npmMarker, cmdMarker]) await hooks(h).kill(marker)
  for (const marker of [npmMarker, cmdMarker]) await until(`${marker} ended`, async () => (await hosted(h, w, marker))?.state === 'ended', 15_000, h, w)
}

/** Runs `check` on a new world (changed by `prepare` before the launch) and app, and always ends the app, the fakes, and the folders. */
async function inWorld(check: (h: Harness, w: World) => Promise<void>, prepare: (w: World) => void = () => {}): Promise<void> {
  const w = makeWorld()
  prepare(w)
  try {
    const h = await launch(w)
    try {
      await check(h, w)
    } finally {
      await h.close()
    }
  } finally {
    endFakes(w)
    await removeWithRetry(w.dir)
  }
}

describe.runIf(process.env.OPENAFLOW_REAL_ELECTRON === '1' && (process.platform === 'linux' || WIN))(`real session (${PACKAGED ? 'packaged' : 'unpackaged'})`, () => {
  test('a new session through the product path', async () => {
    await inWorld(productPathCheck)
  }, RUN_MS)

  // The test above runs in a repo with pod-docs/ and no .openaflow/: it starts with the hooks plugin only (§6).
  test('two plugin dirs', async () => {
    await inWorld(twoPluginDirsCheck, setUpRepo)
  }, RUN_MS)

  test.runIf(!PACKAGED)('server crash', async () => {
    await inWorld(async (h, w) => {
      const { marker } = await liveSession(h, w)
      const listed = (await hooks(h).list()).find((s) => s.id === marker)!
      const hostPid = await hooks(h).hostPid()

      const owner = join(w.cfg, 'auto-continue-owner.json')
      await until('the owner file', () => existsSync(owner), 15_000, h, w)
      const server = (JSON.parse(readFileSync(owner, 'utf8')) as { pid: number }).pid
      expect(server).not.toBe(h.app.process().pid)
      process.kill(server, 'SIGKILL')
      await until('/api/health to go', async () => !(await health(h)), 15_000, h, w)
      await until('/api/health to come back', () => health(h), 60_000, h, w)

      // The new server's reconcile finds the session in the host: still live, with the same program.
      await until('the Board back with the session', async () => (await hosted(h, w, marker)) !== undefined, 30_000, h, w)
      expect(await hosted(h, w, marker)).toMatchObject({ state: 'live', hooked: true })
      expect(await hooks(h).hostPid()).toBe(hostPid)
      expect((await hooks(h).list()).find((s) => s.id === marker)).toMatchObject({ pid: listed.pid, live: true })
      // A moment later too, after the reconcile's answer.
      await sleep(3_000)
      expect(await hosted(h, w, marker)).toMatchObject({ state: 'live' })
      expect(starts(w)).toHaveLength(1)
    })
  }, RUN_MS)

  test.runIf(!PACKAGED)('host crash', async () => {
    await inWorld(async (h, w) => {
      const { marker, repoId } = await liveSession(h, w)
      const old = await hooks(h).hostPid()
      expect(old).toBeGreaterThan(0)
      process.kill(old!, 'SIGKILL')

      await until('stopped · terminals restarted', async () => (await hosted(h, w, marker))?.state === 'stopped', 30_000, h, w)
      expect(await hosted(h, w, marker)).toMatchObject({ state: 'stopped', stopReason: 'terminals restarted' })
      await until('a new host process', async () => ((await hooks(h).hostPid()) ?? old) !== old, 30_000, h, w)
      expect(starts(w)).toHaveLength(1)
      await dismissCheck(h, w, repoId, marker)
    })
  }, RUN_MS)

  test.runIf(!PACKAGED)('app restart', async () => {
    const w = makeWorld()
    try {
      const first = await launch(w)
      let marker: string
      try {
        ;({ marker } = await liveSession(first, w))
      } finally {
        await first.close()
      }
      // The quit asked about the live session; the test-hooks build answers end with no native box, so the close
      // quits. The session's program is gone before the next start.
      const log = readText(join(w.dir, 'shell', 'desktop.log'))
      expect(log).toContain('openaflow desktop: quit asked about 1 sessions: end')
      expect(starts(w).every((s) => !alive(s.pid)), log.slice(-4_000)).toBe(true)
      const second = await launch(w)
      try {
        await until('the repo on the Board', async () => (await repoOf(second, w)) !== undefined, 60_000, second, w)
        await until('stopped · app closed', async () => (await hosted(second, w, marker))?.state === 'stopped', 60_000, second, w)
        expect(await hosted(second, w, marker)).toMatchObject({ state: 'stopped', stopReason: 'app closed' })
        // Nothing started again: one start of the fake, and the new host holds no session.
        expect(starts(w)).toHaveLength(1)
        await until('the test hook', () => hooks(second).ready(), 60_000, second, w)
        expect(await hooks(second).list()).toEqual([])
        await dismissCheck(second, w, (await repoOf(second, w))!.id, marker)
      } finally {
        await second.close()
      }
      expect(starts(w).every((s) => !alive(s.pid))).toBe(true)
    } finally {
      endFakes(w)
      await removeWithRetry(w.dir)
    }
  }, RUN_MS)

  test.runIf(!PACKAGED)('cancel at quit leaves the app as it was', async () => {
    const w = makeWorld()
    const log = join(w.dir, 'shell', 'desktop.log')
    try {
      const h = await launch(w)
      try {
        const { marker } = await liveSession(h, w)
        const visible = () => h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((x) => x.isVisible()))
        await until('the window visible', async () => (await visible()).includes(true), 30_000, h, w)

        await h.app.evaluate(() => (globalThis as Hooked).__openaflowTest!.quit!.answer('cancel'))
        await h.app.evaluate(({ app }) => app.quit())
        await until('the quit answered cancel', () => readText(log).includes('quit asked about 1 sessions: cancel'), 15_000, h, w)

        // The tray's Open (and a second launch) still shows a hidden window.
        await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide())
        await until('the window hidden', async () => !(await visible()).includes(true), 15_000, h, w)
        await h.app.evaluate(({ app }) => void app.emit('second-instance'))
        await until('the window shown after the cancel', async () => (await visible()).includes(true), 15_000, h, w)
        expect(await health(h)).toBe(true)
        expect(await hosted(h, w, marker)).toMatchObject({ state: 'live' })
      } finally {
        await h.close()
      }
      // The harness's close() answers end: that quit ends the session.
      expect(readText(log)).toContain('quit asked about 1 sessions: end')
      expect(starts(w).every((s) => !alive(s.pid))).toBe(true)
    } finally {
      endFakes(w)
      await removeWithRetry(w.dir)
    }
  }, RUN_MS)

  test.runIf(WIN)('windows shims', async () => {
    await inWorld(windowsShimsCheck)
  }, RUN_MS)
})
