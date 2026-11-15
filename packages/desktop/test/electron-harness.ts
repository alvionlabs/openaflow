// Starts the real app for a `real-*.test.ts` with Playwright's `_electron`: unpackaged from test-hooks bundles in a
// temp folder, or, with OPENAFLOW_PACKAGED_APP=<absolute path>, that `pnpm package --test-hooks` executable. Temp
// folders only, never the user's config. The rules are in pod-docs/sprints/host-core.md (§6, §7).

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Board, HostedSession } from '@openaflow/model'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { projectDirName } from '../../server/src/transcript-files.ts'
import { bundleDesktop } from '../src/bundle-desktop.ts'

/** The desktop package folder. */
export const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCH_MS = 60_000
const CLOSE_MS = 15_000

export type Harness = {
  app: ElectronApplication
  page: Page
  port: number
  dir: string
  /** Main's own process ID. On Windows, Playwright starts main through `cmd.exe`: `app.process()` is that wrapper. */
  pid: number
  /** Main has ended. Use it, not `app.process()`, which throws once Playwright has closed its connection. */
  exited(): boolean
  close(): Promise<void>
}

/** `OPENAFLOW_PACKAGED_APP`, when set. A relative path is refused: the test runs from the repo root, a script from its package. */
export function packagedApp(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.OPENAFLOW_PACKAGED_APP
  if (value === undefined || value === '') return undefined
  if (!isAbsolute(value)) throw new Error(`OPENAFLOW_PACKAGED_APP must be an absolute path, not ${value}`)
  return value
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Chromium's helpers let go of the data folder a moment after the main process ends. */
export async function removeWithRetry(path: string): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (tries >= 200 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw err
      await sleep(50)
    }
  }
}

/** The parent's env with nothing of the app's, the test runner's, Claude's, or Electron's own, plus the temp folders. */
function appEnv(dir: string, port: number, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase()
    if (value === undefined) continue
    if (['OPENAFLOW_', 'CLAUDE', 'ELECTRON_', 'VITEST'].some((p) => upper.startsWith(p))) continue
    if (['NODE_OPTIONS', 'NODE_PATH'].includes(upper)) continue
    env[key] = value
  }
  const folder = (name: string) => {
    const path = join(dir, name)
    mkdirSync(path, { recursive: true })
    return path
  }
  return {
    ...env,
    OPENAFLOW_CONFIG_DIR: folder('cfg'),
    OPENAFLOW_PORTS_DIR: folder('ports'),
    OPENAFLOW_CLAUDE_DIR: folder('claude'),
    OPENAFLOW_DESKTOP_DATA_DIR: folder('shell'),
    OPENAFLOW_API_PORT: String(port),
    ...extra,
  }
}

/** A new temp folder for `launchHarness({ dir })`. The caller removes it with `removeWithRetry`. */
export const harnessDir = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), 'openaflow-harness-')))

/**
 * Starts the app. With `dir`, it runs on that folder's `cfg`, `ports`, `claude`, and `shell`, which outlive `close()`:
 * a second launch on the same `dir` is an app restart. Without it, a new temp folder that `close()` removes.
 */
export async function launchHarness(o: { env?: Record<string, string>; dir?: string } = {}): Promise<Harness> {
  const owned = o.dir === undefined
  const dir = o.dir ?? harnessDir()
  const port = await freePort()
  const packaged = packagedApp()
  let executablePath: string
  let args: string[]
  let extra: Record<string, string> = {}
  if (packaged !== undefined) {
    executablePath = packaged
    args = []
  } else {
    // The preload sits beside main.cjs, where window-main.ts looks for it.
    const main = join(dir, 'app', 'main.cjs')
    await bundleDesktop({ entry: join(DESKTOP, 'test', 'harness-main.ts'), outfile: main, testHooks: true })
    await bundleDesktop({ entry: join(DESKTOP, 'src', 'preload-main.ts'), outfile: join(dir, 'app', 'preload.cjs'), testHooks: true })
    // Resolved here and only here: under Node, the package downloads its binary when it's loaded.
    executablePath = createRequire(join(DESKTOP, 'package.json'))('electron') as string
    args = [main]
    extra = { OPENAFLOW_HARNESS_APP_PATH: DESKTOP }
  }
  const app = await _electron.launch({ executablePath, args, env: appEnv(dir, port, { ...extra, ...o.env }), timeout: LAUNCH_MS })
  // Read once, now: once Playwright has closed its connection, `app.process()` throws (`reading '_object'`). On
  // Windows it is the `cmd.exe` that runs main's electron.exe, so main's own pid comes from main itself.
  const proc = app.process()
  let main: number | undefined
  const wrapperExited = () => proc.exitCode !== null || proc.signalCode !== null
  const exited = () => (main === undefined ? wrapperExited() : !alive(main))
  const close = async () => {
    await Promise.race([app.close().catch(() => {}), sleep(CLOSE_MS)])
    // A main process that is still there after the quit: end that one process by its ID, then the wrapper.
    if (main !== undefined && alive(main)) {
      try {
        process.kill(main, 'SIGKILL')
      } catch {
        // Gone meanwhile.
      }
    }
    if (!wrapperExited()) proc.kill()
    if (owned) await removeWithRetry(dir)
  }
  try {
    main = await app.evaluate(() => process.pid)
    const page = await app.firstWindow({ timeout: LAUNCH_MS })
    await page.waitForURL(`http://127.0.0.1:${port}/**`, { timeout: LAUNCH_MS })
    return { app, page, port, dir, pid: main, exited, close }
  } catch (err) {
    // The launch's own error is the one to show, never a later one from the clean-up.
    await close().catch((cleanup: unknown) => console.error(`electron-harness: clean-up after a failed launch failed: ${String(cleanup)}`))
    throw err
  }
}

// --- Hosted sessions with test/fixtures/life-claude.mjs (session-life §10): real-quit and real-resume ---

/** One test's folders: the harness's (`dir`, kept across launches), a registered repo, and the fake `claude` in `bin`. */
export type LifeWorld = { dir: string; cfg: string; repo: string; bin: string; claude: string }
/** One start of the fake: its pid, its args, and (Linux) its `/proc/self/cgroup`. */
export type LifeStart = { pid: number; execPath: string; args: string[]; cgroup?: string }
/** A child the fake started on request: `detached` keeps the session's env; `setsid` (Linux) has none and its own session. */
export type LifeChild = { kind: 'detached' | 'setsid'; pid: number; port: number; spawnedAt?: number }
export type Answer = { status: number; body: Record<string, unknown> }
type TestHooks = typeof globalThis & {
  __openaflowTest?: {
    terminals?: { list(): Promise<{ id: string; pid: number; live: boolean }[]>; kill(id: string): Promise<void>; snapshot(id: string): Promise<string | null>; hostPid(): number | undefined }
    quit?: { answer(a: 'end' | 'cancel'): void }
  }
}

const LIFE_FIXTURE = join(DESKTOP, 'test', 'fixtures', 'life-claude.mjs')
const TOKEN_META = /<meta name="openaflow-token" content="([^"]+)"/
export const LIFE_SIZE = { cols: 200, rows: 30 }

/** A repo with pod docs and no plan, so its row offers New session, and life-claude as `claude`. */
export function makeLifeWorld(): LifeWorld {
  const dir = harnessDir()
  const cfg = join(dir, 'cfg')
  const repo = join(dir, 'repos', 'life-repo')
  const bin = join(dir, 'bin')
  for (const d of [cfg, bin, join(repo, 'pod-docs')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(repo, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
  writeFileSync(join(repo, 'pod-docs', 'handoff-queue.md'), '# Handoff Queue\n')
  writeFileSync(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
  let claude: string
  if (process.platform === 'win32') {
    // The npm shim form `shimTarget` reads, with its own node.exe: `sessionCommand` runs node plus the script.
    copyFileSync(LIFE_FIXTURE, join(bin, 'life-claude.mjs'))
    copyFileSync(process.execPath, join(bin, 'node.exe'))
    claude = join(bin, 'claude.cmd')
    writeFileSync(claude, ['@ECHO off', 'SET dp0=%~dp0', '"%dp0%\\life-claude.mjs" %*', ''].join('\r\n'))
  } else {
    claude = join(bin, 'claude')
    copyFileSync(LIFE_FIXTURE, claude)
    chmodSync(claude, 0o755)
    // An extensionless copy: this tells node it is a module.
    writeFileSync(join(bin, 'package.json'), '{"type":"module"}\n')
  }
  return { dir, cfg, repo, bin, claude }
}

export const launchLife = (w: LifeWorld) => launchHarness({ dir: w.dir, env: { OPENAFLOW_CLAUDE_BIN: w.claude } })

const jsonLines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as T]
          } catch {
            return []
          }
        })
    : []
export const lifeStarts = (w: LifeWorld) => jsonLines<LifeStart>(join(w.bin, 'starts.jsonl'))
export const lifeChildren = (w: LifeWorld) => jsonLines<LifeChild>(join(w.bin, 'children.jsonl'))
/** The next start of the fake that finds this file takes it and starts these children. */
export const askChildren = (w: LifeWorld, kinds: LifeChild['kind'][]) => writeFileSync(join(w.bin, 'child-gate'), JSON.stringify(kinds))

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Something accepts a connection on 127.0.0.1:`port`. */
export const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(1_000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })

/** Ends every process the fake recorded, by its own pid only. */
export function endLifeProcesses(w: LifeWorld): void {
  for (const { pid } of [...lifeStarts(w), ...lifeChildren(w)]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

export const readText = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '(none)')
export const desktopLog = (w: LifeWorld) => readText(join(w.dir, 'shell', 'desktop.log'))

// The server, as the page talks to it.
export const baseUrl = (h: Harness) => `http://127.0.0.1:${h.port}`
export const getBoard = async (h: Harness) => (await (await fetch(`${baseUrl(h)}/api/board`, { signal: AbortSignal.timeout(5_000) })).json()) as Board
const pageToken = async (h: Harness) => TOKEN_META.exec(await (await fetch(`${baseUrl(h)}/`)).text())![1]!

export async function postAction(h: Harness, route: string, body: unknown): Promise<Answer> {
  const res = await fetch(`${baseUrl(h)}/api/actions/${route}`, {
    method: 'POST',
    headers: { Origin: baseUrl(h), 'Content-Type': 'application/json', 'X-OpenAFlow-Token': await pageToken(h) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

export const healthy = async (h: Harness) => {
  try {
    return (await fetch(`${baseUrl(h)}/api/health`, { signal: AbortSignal.timeout(2_000) })).status === 200
  } catch {
    return false
  }
}

export const lifeRepo = async (h: Harness, w: LifeWorld) => (await getBoard(h)).repos.find((r) => r.path === w.repo || r.name === 'life-repo')
export const hostedOf = async (h: Harness, w: LifeWorld, marker: string): Promise<HostedSession | undefined> => (await lifeRepo(h, w))?.hosted?.find((s) => s.marker === marker)

/** Main's test hooks (a `--test-hooks` build). */
export const testHooks = (h: Harness) => ({
  ready: () => h.app.evaluate(() => (globalThis as TestHooks).__openaflowTest?.terminals !== undefined),
  list: () => h.app.evaluate(() => (globalThis as TestHooks).__openaflowTest!.terminals!.list()),
  kill: (id: string) => h.app.evaluate((_e, id) => (globalThis as TestHooks).__openaflowTest!.terminals!.kill(id), id),
  snapshot: (id: string) => h.app.evaluate((_e, id) => (globalThis as TestHooks).__openaflowTest!.terminals!.snapshot(id), id),
  hostPid: () => h.app.evaluate(() => (globalThis as TestHooks).__openaflowTest!.terminals!.hostPid()),
  /** The next quit question's answer; later ones answer `end` again. */
  quitAnswer: (a: 'end' | 'cancel') => h.app.evaluate((_e, a) => (globalThis as TestHooks).__openaflowTest!.quit!.answer(a), a),
  /** A quit as the tray's Quit asks for it. */
  quit: () => h.app.evaluate(({ app }) => app.quit()).catch(() => {}),
})

/** Every failed wait shows the logs, the store, and the fake's starts and children, so one CI run shows it all. */
export const lifeDetails = (w: LifeWorld): string =>
  [
    `starts: ${JSON.stringify(lifeStarts(w))}`,
    `children: ${JSON.stringify(lifeChildren(w))}`,
    `sessions.json: ${readText(join(w.cfg, 'sessions.json'))}`,
    `actions.jsonl: ${readText(join(w.cfg, 'actions.jsonl')).slice(-2_000)}`,
    `desktop.log:\n${desktopLog(w).slice(-6_000)}`,
  ].join('\n')

export async function lifeUntil(what: string, ok: () => boolean | Promise<boolean>, ms: number, w: LifeWorld): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      if (await ok()) return
    } catch {
      // A fetch while the server restarts, or main going away; try again.
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${lifeDetails(w)}`)
    await sleep(200)
  }
}

/** The repo on the Board and the test hook in main, then a New session through the route, live on the Board. */
export async function lifeSession(h: Harness, w: LifeWorld): Promise<{ marker: string; repoId: string; sessionId: string }> {
  await lifeUntil('the repo on the Board', async () => (await lifeRepo(h, w)) !== undefined, 60_000, w)
  await lifeUntil('the test hook (is this a --test-hooks build?)', () => testHooks(h).ready(), 60_000, w)
  const repoId = (await lifeRepo(h, w))!.id
  const answer = await postAction(h, 'new-session', { repoId, skill: 'plain', text: '', ...LIFE_SIZE })
  if (answer.status !== 200) throw new Error(`new-session answered ${JSON.stringify(answer)}\n${lifeDetails(w)}`)
  const marker = answer.body.marker as string
  await lifeUntil('the session live', async () => (await hostedOf(h, w, marker))?.state === 'live', 15_000, w)
  await lifeUntil('the fake to start', () => lifeStarts(w).length > 0, 15_000, w)
  return { marker, repoId, sessionId: (await hostedOf(h, w, marker))!.sessionId }
}

/** Asks the running fake for `kinds` and waits until each child listens. */
export async function lifeChildrenUp(w: LifeWorld, kinds: LifeChild['kind'][]): Promise<LifeChild[]> {
  askChildren(w, kinds)
  await lifeUntil(`the children ${kinds.join(', ')} listening`, async () => {
    const up = lifeChildren(w)
    return kinds.every((k) => up.some((c) => c.kind === k)) && (await Promise.all(up.map((c) => portOpen(c.port)))).every(Boolean)
  }, 15_000, w)
  return lifeChildren(w)
}

/** Claude's transcript of `session`, as `claude` writes it, so the server's resume check (§4) finds it. */
export function writeLifeTranscript(w: LifeWorld, repoPath: string, session: string): void {
  const project = join(w.dir, 'claude', 'projects', projectDirName(repoPath))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${session}.jsonl`), `${JSON.stringify({ type: 'user', cwd: repoPath, message: { role: 'user', content: 'hello' } })}\n`)
}
