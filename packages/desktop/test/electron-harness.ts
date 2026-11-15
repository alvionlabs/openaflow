// Starts the real app for a `real-*.test.ts` with Playwright's `_electron`: unpackaged from test-hooks bundles in a
// temp folder, or, with OPENAFLOW_PACKAGED_APP=<absolute path>, that `pnpm package --test-hooks` executable. Temp
// folders only, never the user's config. The rules are in pod-docs/sprints/host-core.md (§6, §7).

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
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
  /** Main's process ID. */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  // Read once, now: once Playwright has closed its connection, `app.process()` throws (`reading '_object'`).
  const proc = app.process()
  const exited = () => proc.exitCode !== null || proc.signalCode !== null
  const close = async () => {
    await Promise.race([app.close().catch(() => {}), sleep(CLOSE_MS)])
    // A main process that is still there after the quit: end that one process by its ID.
    if (!exited()) proc.kill()
    if (owned) await removeWithRetry(dir)
  }
  try {
    const page = await app.firstWindow({ timeout: LAUNCH_MS })
    await page.waitForURL(`http://127.0.0.1:${port}/**`, { timeout: LAUNCH_MS })
    return { app, page, port, dir, pid: proc.pid!, exited, close }
  } catch (err) {
    // The launch's own error is the one to show, never a later one from the clean-up.
    await close().catch((cleanup: unknown) => console.error(`electron-harness: clean-up after a failed launch failed: ${String(cleanup)}`))
    throw err
  }
}
