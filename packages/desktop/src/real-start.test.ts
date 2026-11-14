import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

// The start proof: the built app (dist/main.cjs, the same file `pnpm desktop` runs) on Electron's own binary,
// with a plain spawn and temp folders. It answers, logs no crash, and its server ends with it. Every kill here is
// by a process ID this test recorded. `pnpm test:electron` runs this after `pnpm build`.

const here = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(here, '..')
const NEEDED = [join(DESKTOP, 'dist', 'main.cjs'), join(DESKTOP, 'dist', 'preload.cjs'), join(DESKTOP, '..', 'server', 'dist', 'app', 'server.mjs')]
const OWNER = 'auto-continue-owner.json'
const START_MS = 60_000
/** How long the server may outlive the main process. Its parent watch polls every 2 s. */
const FOLLOW_MS = 5_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const killPid = (pid: number, signal?: NodeJS.Signals) => {
  try {
    process.kill(pid, signal)
  } catch {
    // already gone
  }
}

const until = async (what: string, ok: () => boolean | Promise<boolean>, ms: number, extra: () => string) => {
  const end = Date.now() + ms
  for (;;) {
    if (await ok()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${extra()}`)
    await sleep(100)
  }
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

/** Chromium's helpers let go of the data folder a moment after the main process ends. */
const removeWithRetry = async (path: string) => {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      if (tries >= 200 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
      await sleep(50)
    }
  }
}

const health = async (port: number) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) })
    return res.status === 200 && JSON.stringify(await res.json()) === '{"ok":true}'
  } catch {
    return false
  }
}

describe.runIf(process.env.OPENAFLOW_REAL_ELECTRON === '1' && (process.platform === 'linux' || process.platform === 'win32'))('the real start', () => {
  let tmp: string
  let shell: ChildProcess | undefined
  let recorded: number[]
  let text: string

  beforeEach(() => {
    const missing = NEEDED.filter((f) => !existsSync(f))
    if (missing.length > 0) throw new Error(`no bundle at ${missing.join(', ')}: run pnpm build first`)
    tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'openaflow-real-start-')))
    recorded = []
    text = ''
  })

  afterEach(async () => {
    for (const pid of recorded) killPid(pid, 'SIGKILL')
    if (tmp) await removeWithRetry(tmp)
  })

  test('the shell starts and its server follows it', async () => {
    const exe = createRequire(join(DESKTOP, 'package.json'))('electron') as string
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      const u = k.toUpperCase()
      if (!u.startsWith('OPENAFLOW_') && !u.startsWith('CLAUDE') && !u.startsWith('ELECTRON_') && !u.startsWith('VITEST') && !['NODE_PATH', 'NODE_OPTIONS'].includes(u)) env[k] = v
    }
    const port = await freePort()
    const cfg = join(tmp, 'cfg')
    const data = join(tmp, 'shell')
    // The package folder: Electron runs its `main`, dist/main.cjs.
    shell = spawn(exe, [DESKTOP], {
      cwd: tmp,
      env: {
        ...env,
        OPENAFLOW_API_PORT: String(port),
        OPENAFLOW_CONFIG_DIR: cfg,
        OPENAFLOW_PORTS_DIR: join(tmp, 'ports'),
        OPENAFLOW_CLAUDE_DIR: join(tmp, 'claude'),
        OPENAFLOW_CLAUDE_BIN: join(tmp, 'missing', 'claude'),
        // Also keeps the single-instance lock apart from an app the user has open.
        OPENAFLOW_DESKTOP_DATA_DIR: data,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const main = shell
    recorded.push(main.pid!)
    main.stdout!.on('data', (d) => (text += String(d)))
    main.stderr!.on('data', (d) => (text += String(d)))
    const log = () => (existsSync(join(data, 'desktop.log')) ? readFileSync(join(data, 'desktop.log'), 'utf8') : '')
    const details = () => `output:\n${text}\ndesktop.log:\n${log()}`

    await until('/api/health', () => health(port), START_MS, details)
    // The owner file names the server's process. It is written after the bind.
    await until('the owner file', () => existsSync(join(cfg, OWNER)), 10_000, details)
    const server = (JSON.parse(readFileSync(join(cfg, OWNER), 'utf8')) as { pid: number }).pid
    recorded.push(server)
    expect(server).not.toBe(main.pid)
    expect(alive(server)).toBe(true)

    // A start error shows after the ready line, in the window's or the notifier's start: give it a moment.
    await sleep(2_000)
    expect(main.exitCode, details()).toBeNull()
    expect(log(), details()).toContain('openaflow API listening')
    expect(log(), details()).not.toMatch(/Uncaught|TypeError/)
    expect(text, details()).not.toMatch(/Uncaught|TypeError/)

    // A hard kill: no quit flow runs. The server must not outlive the main process, whatever ends it.
    killPid(main.pid!, 'SIGKILL')
    await new Promise<void>((resolve) => (main.exitCode !== null || main.signalCode !== null ? resolve() : main.once('exit', () => resolve())))
    const gone = Date.now()
    await until('the server to end', () => !alive(server), FOLLOW_MS + 1_000, details)
    const followed = Date.now() - gone
    console.info(`openaflow proof: the server ended ${followed} ms after the main process`)
    expect(followed).toBeLessThan(FOLLOW_MS)
    expect(await health(port)).toBe(false)
  }, 120_000)
})
