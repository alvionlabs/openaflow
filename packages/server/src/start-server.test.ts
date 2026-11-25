import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { liveConfigDir } from './config.ts'
import type { ParentChannel } from './parent-link.ts'
import { readSessionToken } from './session-token.ts'
import { startServer, type Production, type Started } from './start-server.ts'
import { projectDirName } from './transcript-files.ts'

// Pass-through spies: the real watcher and check run, and the tests see whether they started.
const spies = vi.hoisted(() => ({
  watcherStarts: 0,
  watcherCloses: 0,
  autoStarts: 0,
  watcherStartsAtFirstCheck: undefined as number | undefined,
  /** The folders the fake `gh` was asked to run in. */
  ghCwds: [] as string[],
  /** Set: the config folder copy's `copyFile` throws what this returns for a source, as an unreadable file would. */
  copyFails: undefined as ((source: string) => NodeJS.ErrnoException | undefined) | undefined,
}))

// Pass-through `copyFile`, so a test can make one file of the config folder copy fail.
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  const copyFile: typeof real.copyFile = (src, ...rest) => {
    const err = spies.copyFails?.(String(src))
    return err ? Promise.reject(err) : real.copyFile(src, ...rest)
  }
  return { ...real, default: { ...real, copyFile }, copyFile }
})

vi.mock('./watcher.ts', async (original) => {
  const real = await original<typeof import('./watcher.ts')>()
  return {
    ...real,
    createBoardWatcher: (o: Parameters<typeof real.createBoardWatcher>[0]) => {
      const w = real.createBoardWatcher(o)
      const { start, close } = w
      w.start = () => {
        spies.watcherStarts++
        return start()
      }
      w.close = () => {
        spies.watcherCloses++
        return close()
      }
      return w
    },
  }
})

vi.mock('./auto-continue.ts', async (original) => {
  const real = await original<typeof import('./auto-continue.ts')>()
  return {
    ...real,
    createAutoContinue: (...args: Parameters<typeof real.createAutoContinue>) => {
      const a = real.createAutoContinue(...args)
      const { start } = a
      a.start = () => {
        spies.autoStarts++
        start()
      }
      return a
    },
  }
})

// No real `gh`: a run starts in the repo's folder and can outlive the server's stop, and on Windows its working
// folder can't be removed. The fake answers `not-found` at once and records each folder it was asked to run in.
vi.mock('./gh.ts', async (original) => {
  const real = await original<typeof import('./gh.ts')>()
  const fake: typeof real.defaultGhExec = (_args, cwd) => {
    spies.ghCwds.push(cwd)
    return Promise.resolve({ status: 'not-found', stdout: '' })
  }
  return { ...real, defaultGhExec: fake, createFoundGhExec: () => fake }
})

vi.mock('./tool-finder.ts', async (original) => {
  const real = await original<typeof import('./tool-finder.ts')>()
  return {
    ...real,
    createToolFinder: (...args: Parameters<typeof real.createToolFinder>) => {
      const finder = real.createToolFinder(...args)
      const { check } = finder
      finder.check = () => {
        spies.watcherStartsAtFirstCheck ??= spies.watcherStarts
        return check()
      }
      return finder
    },
  }
})

/** A pid no process can have: the largest one `process.kill` takes. The pid of an ended child can be reused while the suite runs. */
const DEAD_PID = 2147483647
const META = /<meta name="openaflow-token" content="([^"]+)">/
const INDEX = '<!doctype html><html><head><title>Board</title></head><body>page body</body></html>'

let tmp: string
let cfg: string
let webDir: string
let logs: string[]
const running: Array<{ started: Started; exited: Promise<number> }> = []
const holders: Server[] = []

/** Removes a folder, trying again while Windows still holds it. */
const removeWithRetry = async (path: string) => {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (tries >= 40 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw err
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

/** Binds a port on 127.0.0.1 and keeps it until teardown. Port 0 asks the OS for one. */
const holdPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      holders.push(server)
      resolve((server.address() as { port: number }).port)
    })
  })

const closeServer = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

/** Asks the OS for a free port and gives it back. */
const freePort = async (): Promise<number> => {
  const port = await holdPort()
  await closeServer(holders.pop()!)
  return port
}

/** A real request, so the `Host` header is the test's own. */
const send = (
  port: number,
  path: string,
  o: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: o.method ?? 'GET',
        agent: false,
        headers: { Host: o.host ?? `127.0.0.1:${port}`, ...o.headers },
      },
      (res) => {
        let text = ''
        res.on('data', (d) => (text += String(d)))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.once('error', reject)
    req.end(o.body)
  })

/** Temp folders for everything the server reads and writes. Never the real config or claims. */
const envFor = (over: Record<string, string> = {}): Record<string, string> => ({
  OPENAFLOW_CONFIG_DIR: cfg,
  OPENAFLOW_PORTS_DIR: join(tmp, 'ports'),
  OPENAFLOW_CLAUDE_DIR: join(tmp, 'claude'),
  OPENAFLOW_CLAUDE_BIN: join(tmp, 'missing', 'claude'),
  ...over,
})

/** Starts a server with a fake exit, and keeps it for teardown. The managed settings file is a temp one, never the machine's. */
const start = async (env: Record<string, string>, production?: Production, terminals?: ParentChannel) => {
  let exit = (_code: number) => {}
  const exited = new Promise<number>((resolve) => (exit = resolve))
  const managedSettings = join(tmp, 'managed-settings.json')
  const started = await startServer(env, { exit: (code) => exit(code), managedSettings, ...(production ? { production } : {}), ...(terminals ? { terminals } : {}) })
  const entry = { started, exited }
  running.push(entry)
  return entry
}

/** A production server on a port the test owns. */
const startProduction = async (over: Record<string, string> = {}) => {
  const port = await freePort()
  return start(envFor({ OPENAFLOW_API_PORT: String(port), ...over }), { webDir })
}

const pageToken = async (port: number): Promise<string> => {
  const { status, text } = await send(port, '/')
  expect(status).toBe(200)
  const token = META.exec(text)?.[1]
  expect(token).toBeTruthy()
  return token!
}

const mergePreview = (port: number, token?: string) =>
  send(port, '/api/actions/merge-preview', {
    method: 'POST',
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      'Content-Type': 'application/json',
      ...(token ? { 'X-OpenAFlow-Token': token } : {}),
    },
    body: JSON.stringify({ repoId: 'x', number: 1 }),
  })

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'openaflow-start-')))
  cfg = join(tmp, 'cfg')
  webDir = join(tmp, 'web')
  await mkdir(webDir)
  await writeFile(join(webDir, 'index.html'), INDEX)
  logs = []
  const keep = (...args: unknown[]) => void logs.push(args.join(' '))
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
  spies.watcherStarts = 0
  spies.watcherCloses = 0
  spies.autoStarts = 0
  spies.watcherStartsAtFirstCheck = undefined
  spies.copyFails = undefined
  spies.ghCwds = []
})

afterEach(async () => {
  for (const { started, exited } of running.splice(0)) {
    started.stop()
    await exited
  }
  await Promise.all(holders.splice(0).map(closeServer))
  vi.restoreAllMocks()
  await removeWithRetry(tmp)
})

describe('dev', () => {
  test('dev keeps the token file and both ports', async () => {
    const api = await freePort()
    const web = await freePort()
    const { started } = await start(envFor({ OPENAFLOW_API_PORT: String(api), OPENAFLOW_WEB_PORT: String(web) }))
    expect(started.port).toBe(api)

    const token = (await readFile(join(cfg, 'session-token'), 'utf8')).trim()
    expect(token).toHaveLength(43)

    expect((await send(api, '/api/health')).status).toBe(200)
    expect((await send(api, '/api/health', { host: `127.0.0.1:${web}` })).status).toBe(200)
    expect((await send(api, '/api/health', { host: 'localhost:1' })).status).toBe(403)
    // The dev API serves no page.
    expect((await send(api, '/')).status).toBe(404)

    expect(logs).toContain(`openaflow API listening on http://127.0.0.1:${api}`)
    expect(logs.join('\n')).not.toContain(token)
  })

  test('dev defaults its web port to 3001', async () => {
    const api = await freePort()
    await start(envFor({ OPENAFLOW_API_PORT: String(api) }))
    expect((await send(api, '/api/health', { host: '127.0.0.1:3001' })).status).toBe(200)
  })

  test('a bad setting rejects, naming the variable', async () => {
    await expect(start(envFor({ OPENAFLOW_API_PORT: 'abc' }))).rejects.toThrow(/OPENAFLOW_API_PORT/)
    await expect(start(envFor({ OPENAFLOW_API_PORT: String(await freePort()), OPENAFLOW_WEB_PORT: 'abc' }))).rejects.toThrow(/OPENAFLOW_WEB_PORT/)
    expect(spies.watcherStarts).toBe(0)
  })

  test('a failed token write rejects before anything watches', async () => {
    await writeFile(cfg, 'a file, not a folder')
    await expect(start(envFor({ OPENAFLOW_API_PORT: String(await freePort()) }))).rejects.toThrow(/session token file/)
    expect(spies.watcherStarts).toBe(0)
  })

  test('a busy API port rejects, sends nothing, and closes the watcher', async () => {
    const busy = await holdPort()
    await expect(start(envFor({ OPENAFLOW_API_PORT: String(busy) }))).rejects.toThrow(new RegExp(`OPENAFLOW_API_PORT.*${busy}`))
    expect(spies.watcherCloses).toBe(spies.watcherStarts)
    expect(spies.autoStarts).toBe(0)
  })
})

describe('settings', () => {
  test('both modes serve the settings routes on the config folder', async () => {
    // Dev: the token file's token.
    const api = await freePort()
    const dev = await start(envFor({ OPENAFLOW_API_PORT: String(api), OPENAFLOW_WEB_PORT: String(await freePort()) }))
    const devToken = readFileSync(join(cfg, 'session-token'), 'utf8').trim()
    expect((await send(dev.started.port, '/api/settings')).status).toBe(403)
    const read = await send(dev.started.port, '/api/settings', { headers: { 'X-OpenAFlow-Token': devToken } })
    expect(read.status).toBe(200)
    expect(JSON.parse(read.text)).toMatchObject({ scrollback: 5000 })
    const post = (port: number, token: string, body: unknown) =>
      send(port, '/api/actions/settings', {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
        body: JSON.stringify(body),
      })
    const saved = await post(dev.started.port, devToken, { scrollback: 300 })
    expect(saved.status).toBe(200)
    expect(JSON.parse(saved.text)).toMatchObject({ scrollback: 300 })
    expect(JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'))).toEqual({ v: 1, scrollback: 300 })
    dev.started.stop()
    await dev.exited
    running.splice(0)

    // Production: the page's token; it reads what dev wrote, and a hand edit applies to the next read.
    const { started } = await startProduction()
    const token = await pageToken(started.port)
    expect(JSON.parse((await send(started.port, '/api/settings', { headers: { 'X-OpenAFlow-Token': token } })).text)).toMatchObject({ scrollback: 300 })
    await writeFile(join(cfg, 'settings.json'), JSON.stringify({ v: 1, scrollback: 400 }))
    expect(JSON.parse((await send(started.port, '/api/settings', { headers: { 'X-OpenAFlow-Token': token } })).text)).toMatchObject({ scrollback: 400 })
    expect((await post(started.port, token, { scrollback: 99 })).text).toBe(JSON.stringify({ error: 'bad scrollback' }))
  })
})

describe('production', () => {
  test('tool routes are production only', async () => {
    const { started } = await startProduction()
    const token = await pageToken(started.port)
    const headers = { 'X-OpenAFlow-Token': token }
    const res = await send(started.port, '/api/tools', { headers })
    expect(res.status).toBe(200)
    expect((JSON.parse(res.text) as { tools: { tool: string }[] }).tools.map((t) => t.tool)).toEqual(['git', 'gh', 'claude'])
    expect((await send(started.port, '/api/tools')).status).toBe(403)
    // The first check ran before the watcher started.
    expect(spies.watcherStartsAtFirstCheck).toBe(0)

    const saved = await send(started.port, '/api/actions/tool-path', {
      method: 'POST',
      headers: { ...headers, Origin: `http://127.0.0.1:${started.port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'gh', path: null }),
    })
    expect(saved.status).toBe(200)
    expect(existsSync(join(cfg, 'tool-paths.json'))).toBe(true)

    // Dev has neither route, even with the right token, and it writes no file.
    const devCfg = join(tmp, 'dev-cfg')
    const apiPort = await freePort()
    const dev = await start(envFor({ OPENAFLOW_CONFIG_DIR: devCfg, OPENAFLOW_API_PORT: String(apiPort), OPENAFLOW_WEB_PORT: String(await freePort()) }))
    const devToken = (await readFile(join(devCfg, 'session-token'), 'utf8')).trim()
    const devHeaders = { 'X-OpenAFlow-Token': devToken }
    expect((await send(dev.started.port, '/api/tools', { headers: devHeaders })).status).toBe(404)
    const devSave = await send(dev.started.port, '/api/actions/tool-path', {
      method: 'POST',
      headers: { ...devHeaders, Origin: `http://127.0.0.1:${apiPort}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'gh', path: null }),
    })
    expect(devSave.status).toBe(404)
    expect(existsSync(join(devCfg, 'tool-paths.json'))).toBe(false)
  })

  test('production never touches the token file', async () => {
    // With no file, none appears.
    const first = await startProduction()
    await pageToken(first.started.port)
    expect(existsSync(join(cfg, 'session-token'))).toBe(false)
    expect((await readdir(cfg)).filter((f) => f.startsWith('session-token'))).toEqual([])
    first.started.stop()
    await first.exited
    running.splice(0)

    // An existing file stays byte for byte, and its mtime stays too.
    const bytes = 'token-of-a-dev-page\r\n'
    const file = join(cfg, 'session-token')
    await writeFile(file, bytes)
    const before = await stat(file)
    const second = await startProduction()
    const token = await pageToken(second.started.port)
    expect(token).not.toBe(bytes.trim())
    expect(await readFile(file, 'utf8')).toBe(bytes)
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
    expect(logs.join('\n')).not.toContain(token)
  })

  test('production makes the config folder', async () => {
    const nested = join(tmp, 'deep', 'er', 'cfg')
    const { started } = await startProduction({ OPENAFLOW_CONFIG_DIR: nested })
    expect((await stat(nested)).isDirectory()).toBe(true)
    expect((await send(started.port, '/api/board')).status).toBe(200)
  })

  test('production stops, naming the folder, when it cannot make the config folder', async () => {
    await writeFile(cfg, 'a file, not a folder')
    const port = await freePort()
    await expect(start(envFor({ OPENAFLOW_API_PORT: String(port) }), { webDir })).rejects.toThrow(cfg)
    expect(spies.watcherStarts).toBe(0)
    expect(logs.join('\n')).not.toContain('listening')
  })

  test("the page's token works for actions", async () => {
    const { started } = await startProduction()
    const token = await pageToken(started.port)

    const ok = await mergePreview(started.port, token)
    expect(ok.status).toBe(404)
    expect(JSON.parse(ok.text)).toEqual({ error: 'not waiting on you' })

    const none = await mergePreview(started.port)
    expect(none.status).toBe(403)
    expect(JSON.parse(none.text)).toEqual({ error: 'bad token' })

    const wrong = await mergePreview(started.port, 'x'.repeat(43))
    expect(wrong.status).toBe(403)
  })

  test('a new token per start', async () => {
    const one = await startProduction()
    const first = await pageToken(one.started.port)
    expect(await pageToken(one.started.port)).toBe(first)

    const two = await startProduction()
    const second = await pageToken(two.started.port)
    expect(second).not.toBe(first)
    // Each server takes only its own.
    expect((await mergePreview(two.started.port, first)).status).toBe(403)
  })

  test('production ignores the web port', async () => {
    const web = await freePort()
    const good = await startProduction({ OPENAFLOW_WEB_PORT: String(web) })
    expect((await send(good.started.port, '/')).status).toBe(200)
    const refused = await send(good.started.port, '/', { host: `127.0.0.1:${web}` })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.text)).toEqual({ error: 'forbidden host' })
    // The default dev web port is no exception.
    expect((await send(good.started.port, '/', { host: '127.0.0.1:3001' })).status).toBe(403)

    const bad = await startProduction({ OPENAFLOW_WEB_PORT: 'not a port' })
    expect((await send(bad.started.port, '/')).status).toBe(200)
  })

  test('the Host check uses the real port', async () => {
    const busy = await holdPort()
    const { started } = await start(envFor(), { webDir, preferredPort: busy })
    expect(started.port).not.toBe(busy)
    expect(started.port).toBeGreaterThan(0)

    expect((await send(started.port, '/')).status).toBe(200)
    const atPreferred = await send(started.port, '/', { host: `127.0.0.1:${busy}` })
    expect(atPreferred.status).toBe(403)
    expect(atPreferred.text).not.toMatch(META)

    expect(logs).toContain(`openaflow: port ${busy} is busy; using ${started.port} for this launch`)
    expect(logs).toContain(`openaflow API listening on http://127.0.0.1:${started.port}`)
  })

  test('a free preferred port is used, with no busy line', async () => {
    const port = await freePort()
    const { started } = await start(envFor(), { webDir, preferredPort: port })
    expect(started.port).toBe(port)
    expect(logs.join('\n')).not.toContain('is busy')
    expect(logs).toContain(`openaflow API listening on http://127.0.0.1:${port}`)
  })

  test('an empty OPENAFLOW_API_PORT counts as unset', async () => {
    const port = await freePort()
    const { started } = await start(envFor({ OPENAFLOW_API_PORT: '' }), { webDir, preferredPort: port })
    expect(started.port).toBe(port)
  })

  test('an explicit busy port stops the start', async () => {
    const busy = await holdPort()
    const preferred = await freePort()
    await expect(start(envFor({ OPENAFLOW_API_PORT: String(busy) }), { webDir, preferredPort: preferred })).rejects.toThrow(
      new RegExp(`OPENAFLOW_API_PORT.*${busy}`),
    )
    expect(logs.join('\n')).not.toContain('listening')
    expect(spies.watcherCloses).toBe(spies.watcherStarts)
    expect(spies.autoStarts).toBe(0)
  })

  test('a bad OPENAFLOW_API_PORT stops the start', async () => {
    await expect(start(envFor({ OPENAFLOW_API_PORT: 'abc' }), { webDir })).rejects.toThrow(/OPENAFLOW_API_PORT/)
    expect(spies.watcherStarts).toBe(0)
  })

  test('a bad web folder stops the start', async () => {
    const missing = join(tmp, 'no-web')
    const port = await freePort()
    await expect(start(envFor({ OPENAFLOW_API_PORT: String(port) }), { webDir: missing })).rejects.toThrow(missing)

    expect(spies.watcherStarts).toBe(0)
    expect(spies.autoStarts).toBe(0)
    expect(logs.join('\n')).not.toContain('listening')
    // Nothing took the port.
    await new Promise<void>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
    })
  })

  test('the web app answers with the API on one port', async () => {
    const { started } = await startProduction()
    expect(JSON.parse((await send(started.port, '/api/health')).text)).toEqual({ ok: true })
    expect((await send(started.port, '/some/page')).text).toContain('page body')
    expect((await send(started.port, '/sw.js')).status).toBe(404)
    expect(JSON.parse((await send(started.port, '/api/nope')).text)).toEqual({ error: 'not found' })
  })
})

describe('hosted sessions', () => {
  const M = '11111111-1111-4111-8111-111111111111'
  const S = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  /** Main's side of the parent channel: what the server sent, and a way to answer. */
  const fakeMain = () => {
    const sent: Record<string, unknown>[] = []
    let deliver: (m: unknown) => void = () => {}
    const link: ParentChannel = { onMessage: (fn) => void (deliver = fn), send: (m) => void sent.push(m as Record<string, unknown>) }
    return { link, sent, answer: (m: Record<string, unknown>) => deliver({ type: 'openaflow:terminal', ...m }) }
  }
  /**
   * A `claude` the tool finder takes, in `dir`, which the tests never run: an executable `claude` on POSIX, and on
   * Windows an npm-style `claude.cmd` shim (a `#!/bin/sh` file can't run there), which the session command reads, so
   * its args stay on the command line.
   */
  const fakeClaude = async (dir: string) => {
    await mkdir(dir)
    if (process.platform === 'win32') {
      await writeFile(join(dir, 'cli.js'), 'process.exitCode = 0\n')
      await writeFile(join(dir, 'claude.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\cli.js" %*\r\n')
    } else {
      await writeFile(join(dir, 'claude'), '#!/bin/sh\nexit 0\n')
      await chmod(join(dir, 'claude'), 0o755)
    }
    return dir
  }
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (const end = Date.now() + 10_000; !(await check()); ) {
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  test('reconcile never blocks the start', async () => {
    const repo = join(tmp, 'repo')
    await mkdir(repo)
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
    await writeFile(join(cfg, 'sessions.json'), JSON.stringify({ v: 1, sessions: [{ marker: M, repoPath: repo, sessionId: S, skill: 'plan', startedAt: 1, state: 'live', pid: 5 }] }))
    const main = fakeMain()
    const port = await freePort()
    // Main never answers the list: the server still listens and serves the Board, with the record as stored.
    const { started } = await start(envFor({ OPENAFLOW_API_PORT: String(port), OPENAFLOW_HOOKS_PLUGIN: join(tmp, 'plugin') }), { webDir }, main.link)
    expect((await send(started.port, '/api/health')).status).toBe(200)
    const hosted = async () => (JSON.parse((await send(started.port, '/api/board')).text) as { repos: { hosted?: { state: string; stopReason?: string }[] }[] }).repos[0]!.hosted
    expect(await hosted()).toEqual([expect.objectContaining({ state: 'live' })])
    await until(() => main.sent.some((m) => m.op === 'list'))
    // The answer settles the record, and the Board follows.
    const list = main.sent.find((m) => m.op === 'list')!
    main.answer({ op: 'list', req: list.req, sessions: [] })
    await until(async () => (await hosted())?.[0]?.state === 'stopped')
    expect((await hosted())![0]!.stopReason).toBe('app closed')
  })

  test('sweep after reconcile', async () => {
    const M2 = '22222222-2222-4222-8222-222222222222'
    const M3 = '33333333-3333-4333-8333-333333333333'
    const repo = join(tmp, 'repo')
    await mkdir(repo)
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
    const rec = (marker: string, state: string, over: Record<string, unknown> = {}) => ({ marker, repoPath: repo, sessionId: S, skill: 'plan', startedAt: 1, state, ...over })
    const seed = () =>
      writeFile(join(cfg, 'sessions.json'), JSON.stringify({ v: 1, sessions: [rec(M, 'live', { pid: 5 }), rec(M2, 'starting'), rec(M3, 'ended', { exitCode: 0 })] }))
    // A fake systemd on PATH, so the scope probe answers on (Linux only); it notes each run.
    const bin = join(tmp, 'bin')
    const calls = join(tmp, 'probe-calls')
    await mkdir(bin)
    await writeFile(join(bin, 'systemd-run'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 0\n`)
    await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n')
    await writeFile(join(bin, 'true'), '#!/bin/sh\nexit 0\n')
    for (const f of ['systemd-run', 'systemctl', 'true']) await chmod(join(bin, f), 0o755)
    const env = async () => envFor({ OPENAFLOW_API_PORT: String(await freePort()), OPENAFLOW_HOOKS_PLUGIN: join(tmp, 'plugin'), PATH: bin })
    const states = () => (JSON.parse(readFileSync(join(cfg, 'sessions.json'), 'utf8')) as { sessions: { state: string }[] }).sessions.map((r) => r.state)

    // No channel: no probe runs, and nothing is swept.
    await seed()
    await startProduction({ PATH: bin })
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(calls)).toBe(false)
    for (const { started, exited } of running.splice(0)) {
      started.stop()
      await exited
    }

    // One unlisted record: one sweep. It started before stops were stored, so it has none, even with the probe on.
    await seed()
    const main = fakeMain()
    await start(await env(), { webDir }, main.link)
    await until(() => main.sent.some((m) => m.op === 'list'))
    main.answer({ op: 'list', req: main.sent.find((m) => m.op === 'list')!.req, sessions: [{ id: M2, pid: 6, live: true, startedAt: 1 }] })
    await until(() => states()[0] === 'stopped')
    await until(() => main.sent.some((m) => m.op === 'sweep'))
    expect(main.sent.filter((m) => m.op === 'sweep')).toEqual([{ type: 'openaflow:terminal', op: 'sweep', sessions: [{ id: M }] }])
    expect(states()).toEqual(['stopped', 'live', 'ended'])
    // The labels went at the start, before the reconcile changed anything.
    expect(main.sent.find((m) => m.op === 'labels')).toEqual({ type: 'openaflow:terminal', op: 'labels', labels: [{ id: M, label: 'repo · no plan yet' }, { id: M2, label: 'repo · no plan yet' }] })
    for (const { started, exited } of running.splice(0)) {
      started.stop()
      await exited
    }

    // Every record listed: no sweep.
    await seed()
    const all = fakeMain()
    await start(await env(), { webDir }, all.link)
    await until(() => all.sent.some((m) => m.op === 'list'))
    all.answer({ op: 'list', req: all.sent.find((m) => m.op === 'list')!.req, sessions: [{ id: M, pid: 5, live: true, startedAt: 1 }, { id: M2, pid: 6, live: true, startedAt: 1 }] })
    await until(() => states()[1] === 'live')
    await new Promise((r) => setTimeout(r, 300))
    expect(all.sent.filter((m) => m.op === 'sweep')).toEqual([])
  })

  test('sweep uses the stop each session started with', async () => {
    const M2 = '22222222-2222-4222-8222-222222222222'
    const M3 = '33333333-3333-4333-8333-333333333333'
    const M4 = '44444444-4444-4444-8444-444444444444'
    const repo = join(tmp, 'repo')
    await mkdir(repo)
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
    const rec = (marker: string, state: string, over: Record<string, unknown> = {}) => ({ marker, repoPath: repo, sessionId: S, skill: 'plan', startedAt: 1, state, ...over })
    const OLD_STOP = ['/opt/old/stop', '--unit', `openaflow-run-${M}.scope`]
    await writeFile(
      join(cfg, 'sessions.json'),
      JSON.stringify({ v: 1, sessions: [rec(M, 'live', { pid: 5, stop: OLD_STOP, scrollback: 300 }), rec(M2, 'starting'), rec(M3, 'live', { pid: 7 }), rec(M4, 'ended', { exitCode: 0, stop: ['/x'] })] }),
    )
    // The settings changed since: another stop command, and the default wrapper with a working fake systemd.
    await writeFile(join(cfg, 'settings.json'), JSON.stringify({ v: 1, stopCommand: '/opt/new/stop {unit}' }))
    const bin = join(tmp, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'systemd-run'), '#!/bin/sh\nexit 0\n')
    await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n')
    await writeFile(join(bin, 'true'), '#!/bin/sh\nexit 0\n')
    for (const f of ['systemd-run', 'systemctl', 'true']) await chmod(join(bin, f), 0o755)

    const main = fakeMain()
    await start(envFor({ OPENAFLOW_API_PORT: String(await freePort()), OPENAFLOW_HOOKS_PLUGIN: join(tmp, 'plugin'), PATH: bin }), { webDir }, main.link)
    await until(() => main.sent.some((m) => m.op === 'list'))
    main.answer({ op: 'list', req: main.sent.find((m) => m.op === 'list')!.req, sessions: [{ id: M2, pid: 6, live: true, startedAt: 1 }] })
    await until(() => main.sent.some((m) => m.op === 'sweep'))
    // Each closed record's own stop, and none for one without; the ended record isn't swept.
    expect(main.sent.filter((m) => m.op === 'sweep')).toEqual([{ type: 'openaflow:terminal', op: 'sweep', sessions: [{ id: M, stop: OLD_STOP }, { id: M3 }] }])
    // The records keep them.
    const saved = JSON.parse(readFileSync(join(cfg, 'sessions.json'), 'utf8')) as { sessions: Record<string, unknown>[] }
    expect(saved.sessions[0]).toMatchObject({ state: 'stopped', stop: OLD_STOP, scrollback: 300 })
  })

  test('workflows dir wired', async () => {
    // A set-up repo, an ended session that never hooked, a bundle, a fake claude on PATH, and a managed settings
    // file that turns sideloading off.
    const repo = join(tmp, 'repo')
    await mkdir(join(repo, '.openaflow', 'workflows', 'claude-pod', 'state'), { recursive: true })
    await writeFile(join(repo, '.openaflow', 'workflows', 'claude-pod', 'workflow.json'), JSON.stringify({ source: 'claude-pod', version: '0.11.10' }))
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
    await writeFile(join(cfg, 'sessions.json'), JSON.stringify({ v: 1, sessions: [{ marker: M, repoPath: repo, sessionId: S, skill: 'plan', startedAt: 1, state: 'ended', exitCode: 1 }] }))
    await writeFile(join(tmp, 'managed-settings.json'), JSON.stringify({ disableSideloadFlags: true }))
    const workflows = join(tmp, 'workflows')
    await mkdir(join(workflows, 'claude-pod', '.claude-plugin'), { recursive: true })
    await writeFile(join(workflows, 'claude-pod', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pod', version: '0.11.10' }))
    const bin = await fakeClaude(join(tmp, 'bin'))
    const hooksPlugin = join(tmp, 'plugin')

    const main = fakeMain()
    const env = envFor({ OPENAFLOW_API_PORT: String(await freePort()), OPENAFLOW_HOOKS_PLUGIN: hooksPlugin, OPENAFLOW_WORKFLOWS_DIR: workflows, OPENAFLOW_CLAUDE_BIN: join(bin, 'claude') })
    const { started } = await start(env, { webDir }, main.link)
    const token = await pageToken(started.port)
    const headers = { Origin: `http://127.0.0.1:${started.port}`, 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token }
    type B = { workflow?: unknown; repos: { id: string; hosted?: { marker: string; blocked?: string }[] }[] }
    const board = JSON.parse((await send(started.port, '/api/board')).text) as B
    // The Board: the bundle's version, and the ended session blocked by the managed settings.
    expect(board.workflow).toEqual({ source: 'claude-pod', version: '0.11.10' })
    expect(board.repos[0]!.hosted).toEqual([expect.objectContaining({ marker: M, blocked: 'sideload' })])
    // The settings preview: both folders.
    const settings = JSON.parse((await send(started.port, '/api/settings', { headers: { 'X-OpenAFlow-Token': token } })).text) as { wrapper?: { preview: string } }
    if (process.platform !== 'win32') expect(settings.wrapper!.preview).toContain(`--plugin-dir ${hooksPlugin} --add-dir ${join(workflows, 'claude-pod')} --plugin-dir ${join(workflows, 'claude-pod')} `)
    // New session: the start main gets loads both plugins.
    const res = send(started.port, '/api/actions/new-session', { method: 'POST', headers, body: JSON.stringify({ repoId: board.repos[0]!.id, skill: 'plan', text: '' }) })
    await until(() => main.sent.some((m) => m.op === 'start'))
    const startMsg = main.sent.find((m) => m.op === 'start')!
    const args = (startMsg.spec as { args: string[] }).args
    expect(args.slice(-7)).toEqual(['--plugin-dir', hooksPlugin, '--add-dir', join(workflows, 'claude-pod'), '--plugin-dir', join(workflows, 'claude-pod'), '/pod:plan'])
    main.answer({ op: 'started', req: startMsg.req, id: (startMsg.spec as { id: string }).id, pid: 4321 })
    expect((await res).status).toBe(200)
  })

  test('with no workflows dir: no Board workflow, and a set-up repo answers workflow missing', async () => {
    const repo = join(tmp, 'repo')
    await mkdir(join(repo, '.openaflow', 'workflows', 'claude-pod'), { recursive: true })
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
    const bin = await fakeClaude(join(tmp, 'bin'))
    const main = fakeMain()
    const { started } = await start(envFor({ OPENAFLOW_API_PORT: String(await freePort()), OPENAFLOW_HOOKS_PLUGIN: join(tmp, 'plugin'), OPENAFLOW_WORKFLOWS_DIR: '', OPENAFLOW_CLAUDE_BIN: join(bin, 'claude') }), { webDir }, main.link)
    const token = await pageToken(started.port)
    const board = JSON.parse((await send(started.port, '/api/board')).text) as { workflow?: unknown; repos: { id: string }[] }
    expect(board).not.toHaveProperty('workflow')
    const res = await send(started.port, '/api/actions/new-session', {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${started.port}`, 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
      body: JSON.stringify({ repoId: board.repos[0]!.id, skill: 'plan', text: '' }),
    })
    expect({ status: res.status, body: JSON.parse(res.text) }).toEqual({ status: 409, body: { error: 'workflow missing' } })
    expect(main.sent.filter((m) => m.op === 'start')).toEqual([])
  })

  test('Continue in a set-up repo loads the hooks plugin and the bundle', async () => {
    // A set-up repo whose sprint `one` ended: `continue` is sendable. Its session ran outside the app (no
    // sessions.json), so the resume route sends it with `claude -p`.
    const repo = join(tmp, 'repo')
    const state = join(repo, '.openaflow', 'workflows', 'claude-pod', 'state')
    await mkdir(join(state, 'plans'), { recursive: true })
    await mkdir(join(state, 'sprints'), { recursive: true })
    await writeFile(join(repo, '.openaflow', 'workflows', 'claude-pod', 'workflow.json'), JSON.stringify({ source: 'claude-pod', version: '0.11.10' }))
    await writeFile(join(state, 'README.md'), '# pod docs\n\npod docs: 2\n')
    await writeFile(join(state, 'handoff-queue.md'), '# Handoff Queue\n')
    const table = (head: string, rows: string[]) => [head, `|${'---|'.repeat(head.split('|').length - 2)}`, ...rows]
    await writeFile(
      join(state, 'plans', 'alpha.md'),
      ['# Plan: alpha', '', '_Generated: 2026-11-01 · Status: active_', '', '## Sprint sequence', '', ...table('| Sprint | Goal | Status | Depends on |', ['| one | goal | done | — |', '| two | goal | planned | — |']), ''].join('\n'),
    )
    await writeFile(
      join(state, 'sprints', 'one.md'),
      [
        '# Sprint: one',
        '',
        '_From plan: plans/alpha.md · Slug: one · Status: active · Generated: 2026-11-01_',
        '',
        '## Status board',
        '',
        ...table('| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |', ['| 1 | A1 | a | one-A1 | merged | done | high | — |']),
        '',
      ].join('\n'),
    )
    // The session's transcript: one engineer of sprint one, quiet for two hours, so the session is idle.
    const session = 'sess-1'
    const project = join(tmp, 'claude', 'projects', projectDirName(repo))
    const sub = join(project, session, 'subagents')
    await mkdir(sub, { recursive: true })
    const old = new Date(Date.now() - 7_200_000)
    const line = (o: unknown) => JSON.stringify(o) + '\n'
    await writeFile(join(project, `${session}.jsonl`), line({ type: 'user', cwd: repo, message: { role: 'user', content: 'go' } }))
    await writeFile(join(sub, 'agent-eng1.meta.json'), JSON.stringify({ agentType: 'pod:engineer', description: 'Build A1' }))
    const brief = '- **sprint slug:** one\n- **slice code:** A1\n- **branch name:** one-A1\n'
    await writeFile(
      join(sub, 'agent-eng1.jsonl'),
      line({ type: 'user', cwd: repo, timestamp: old.toISOString(), message: { role: 'user', content: brief } }) +
        line({ type: 'assistant', cwd: repo, timestamp: old.toISOString(), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x.ts' } }] } }),
    )
    for (const p of [join(project, `${session}.jsonl`), join(sub, 'agent-eng1.meta.json'), join(sub, 'agent-eng1.jsonl'), sub, join(project, session)]) await utimes(p, old, old)
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
    const workflows = join(tmp, 'workflows')
    await mkdir(join(workflows, 'claude-pod', '.claude-plugin'), { recursive: true })
    await writeFile(join(workflows, 'claude-pod', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pod', version: '0.11.10' }))
    const hooksPlugin = join(tmp, 'plugin')
    // A fake claude that writes its args to a file: a POSIX script, or on Windows an npm-style `claude.cmd` shim that
    // the runner reads and runs with node, as it does the real one.
    const record = join(tmp, 'claude-args.json')
    const bin = join(tmp, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'cli.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)))\n`)
    let claude: string
    if (process.platform === 'win32') {
      claude = join(bin, 'claude.cmd')
      await writeFile(claude, '@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\cli.mjs" %*\r\n')
    } else {
      claude = join(bin, 'claude')
      await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'cli.mjs')}" "$@"\n`)
      await chmod(claude, 0o755)
    }

    const { started } = await start(envFor({ OPENAFLOW_API_PORT: String(await freePort()), OPENAFLOW_HOOKS_PLUGIN: hooksPlugin, OPENAFLOW_WORKFLOWS_DIR: workflows, OPENAFLOW_CLAUDE_BIN: claude }), { webDir })
    const token = await pageToken(started.port)
    const board = JSON.parse((await send(started.port, '/api/board')).text) as { repos: { id: string }[] }
    const res = await send(started.port, '/api/actions/resume', {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${started.port}`, 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
      body: JSON.stringify({ repoId: board.repos[0]!.id, run: 'alpha', reply: 'continue' }),
    })
    expect({ status: res.status, body: JSON.parse(res.text) as unknown }).toEqual({ status: 200, body: expect.objectContaining({ outcome: 'started' }) })
    await until(() => existsSync(record))
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(['-p', '--plugin-dir', hooksPlugin, '--add-dir', join(workflows, 'claude-pod'), '--plugin-dir', join(workflows, 'claude-pod'), '--resume', session, 'continue'])
  })

  test('a server with no channel answers no terminal host and writes no store', async () => {
    const { started } = await startProduction()
    const token = await pageToken(started.port)
    const res = await send(started.port, '/api/actions/new-session', {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${started.port}`, 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
      body: JSON.stringify({ repoId: 'x', skill: 'plan', text: '' }),
    })
    expect(res.status).toBe(409)
    expect(JSON.parse(res.text)).toEqual({ error: 'no terminal host' })
    expect(existsSync(join(cfg, 'sessions.json'))).toBe(false)
  })
})

describe('setup routes', () => {
  test('setup routes wired', async () => {
    // A bundle with its template, and a registered repo with no `.openaflow`.
    const workflows = join(tmp, 'workflows')
    const template = join(workflows, 'claude-pod', 'skills', 'init', 'scaffold', '.openaflow', 'workflows', 'claude-pod', 'state')
    await mkdir(join(workflows, 'claude-pod', '.claude-plugin'), { recursive: true })
    await writeFile(join(workflows, 'claude-pod', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pod', version: '0.11.10' }))
    await mkdir(template, { recursive: true })
    await writeFile(join(template, 'handoff-queue.md'), '# Handoff Queue\n')
    const repo = join(tmp, 'repo')
    await mkdir(repo)
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))

    const { started } = await startProduction({ OPENAFLOW_WORKFLOWS_DIR: workflows })
    const token = await pageToken(started.port)
    const post = (route: string, body: unknown, withToken = true) =>
      send(started.port, `/api/actions/${route}`, {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${started.port}`, 'Content-Type': 'application/json', ...(withToken ? { 'X-OpenAFlow-Token': token } : {}) },
        body: JSON.stringify(body),
      })
    // Behind the guard: no token, nothing written.
    expect((await post('setup-workflow', { path: repo }, false)).status).toBe(403)
    expect(existsSync(join(repo, '.openaflow'))).toBe(false)

    const res = await post('setup-workflow', { path: repo })
    expect({ status: res.status, body: JSON.parse(res.text) }).toEqual({ status: 200, body: { outcome: 'created', logged: true } })
    expect(await readFile(join(repo, '.openaflow', 'workflows', 'claude-pod', 'workflow.json'), 'utf8')).toBe('{\n  "source": "claude-pod",\n  "version": "0.11.10"\n}\n')
    expect(await readFile(join(repo, '.openaflow', 'workflows', 'claude-pod', 'state', 'handoff-queue.md'), 'utf8')).toBe('# Handoff Queue\n')
    // The Board read it before the answer, and the entry is in the config folder's log.
    type B = { repos: { id: string; model: { openaflow?: boolean } }[]; actions?: { action: string; result: string }[] }
    const board = JSON.parse((await send(started.port, '/api/board')).text) as B
    expect(board.repos[0]!.model.openaflow).toBe(true)
    expect(board.actions?.[0]).toMatchObject({ action: 'setup-workflow', result: 'created' })
    expect(await readFile(join(cfg, 'actions.jsonl'), 'utf8')).toContain('"setup-workflow"')
    // Use reads the same bundle: the version is already the bundled one.
    const use = await post('use-workflow-version', { repoId: board.repos[0]!.id, name: 'claude-pod' })
    expect({ status: use.status, body: JSON.parse(use.text) }).toEqual({ status: 409, body: { error: 'already current' } })
  })

  test('with no workflows dir, setup answers workflow missing', async () => {
    const repo = join(tmp, 'repo')
    await mkdir(repo)
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
    const { started } = await startProduction({ OPENAFLOW_WORKFLOWS_DIR: '' })
    const token = await pageToken(started.port)
    const res = await send(started.port, '/api/actions/setup-workflow', {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${started.port}`, 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
      body: JSON.stringify({ path: repo }),
    })
    expect({ status: res.status, body: JSON.parse(res.text) }).toEqual({ status: 409, body: { error: 'workflow missing' } })
    expect(existsSync(join(repo, '.openaflow'))).toBe(false)
  })
})

describe('the owner file', () => {
  const ownerFile = () => join(cfg, 'auto-continue-owner.json')

  test('a failed start holds nothing', async () => {
    const busy = await holdPort()
    await expect(start(envFor({ OPENAFLOW_API_PORT: String(busy) }))).rejects.toThrow(/OPENAFLOW_API_PORT/)
    expect(existsSync(ownerFile())).toBe(false)
    await expect(start(envFor({ OPENAFLOW_API_PORT: String(busy) }), { webDir })).rejects.toThrow(/OPENAFLOW_API_PORT/)
    expect(existsSync(ownerFile())).toBe(false)
    expect(spies.autoStarts).toBe(0)
  })

  test('both modes use the owner file', async () => {
    // Dev first: it takes the file and starts the check.
    const dev = await start(envFor({ OPENAFLOW_API_PORT: String(await freePort()), OPENAFLOW_WEB_PORT: String(await freePort()) }))
    const held = JSON.parse(await readFile(ownerFile(), 'utf8')) as { pid: number; id: string }
    expect(held.pid).toBe(process.pid)
    expect(spies.autoStarts).toBe(1)
    expect(logs.join('\n')).not.toContain('auto-continue')

    // Production on the same folder keeps serving, and starts no check.
    const prod = await startProduction()
    expect(spies.autoStarts).toBe(1)
    expect(JSON.parse(await readFile(ownerFile(), 'utf8'))).toEqual(expect.objectContaining({ id: held.id }))
    expect(logs.filter((l) => l.includes(String(process.pid)) && l.includes(cfg))).toHaveLength(1)
    expect((await send(prod.started.port, '/api/health')).status).toBe(200)

    // The second's stop leaves the first's file; the first's stop removes it.
    prod.started.stop()
    expect(await prod.exited).toBe(0)
    expect(existsSync(ownerFile())).toBe(true)
    dev.started.stop()
    expect(await dev.exited).toBe(0)
    expect(existsSync(ownerFile())).toBe(false)
    running.splice(0)

    // Production alone takes it too.
    const again = await startProduction()
    expect(existsSync(ownerFile())).toBe(true)
    expect(spies.autoStarts).toBe(2)
    again.started.stop()
    expect(await again.exited).toBe(0)
    expect(existsSync(ownerFile())).toBe(false)
    running.splice(0)
  })
})

describe('stop', () => {
  test('stop uses the shared shutdown', async () => {
    const entry = await startProduction()
    expect(spies.autoStarts).toBe(1)
    const { port } = entry.started
    entry.started.stop()
    expect(await entry.exited).toBe(0)
    expect(spies.watcherCloses).toBe(1)
    await expect(send(port, '/api/health')).rejects.toThrow()
  })
})

// No OPENAFLOW_CONFIG_DIR here, so the server picks its own folder. APPDATA and XDG_CONFIG_HOME point into the
// test's temp folder, so the real folder is never read. macOS takes the folder from the home folder: not run there.
describe.runIf(process.platform === 'win32' || process.platform === 'linux')('the config folder before the rename', () => {
  const base = () => join(tmp, 'appdata')
  const oldDir = () => join(base(), 'pod-board')
  const newDir = () => join(base(), 'openaflow-server')
  const ownEnv = (over: Record<string, string> = {}): Record<string, string> => {
    const { OPENAFLOW_CONFIG_DIR: _cfg, ...rest } = envFor({ APPDATA: base(), XDG_CONFIG_HOME: base(), ...over })
    return rest
  }

  /** The old folder with a registered repo, the toggles, the log, a resume log, and a live owner file. */
  const writeOld = async () => {
    const repo = join(tmp, 'repo')
    await mkdir(join(repo, 'pod-docs'), { recursive: true })
    await writeFile(join(repo, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
    await mkdir(join(oldDir(), 'resume-logs'), { recursive: true })
    await writeFile(join(oldDir(), 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
    await writeFile(join(oldDir(), 'auto-continue.json'), '{"version":1,"runs":[]}\n')
    await writeFile(join(oldDir(), 'actions.jsonl'), '')
    await writeFile(join(oldDir(), 'resume-logs', 'a.log'), 'stderr\n')
    // A pid that has ended: the old server is gone, as after an update.
    await writeFile(join(oldDir(), 'auto-continue-owner.json'), JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() }))
    return repo
  }

  /** A production server on the given env as it is: startProduction would put OPENAFLOW_CONFIG_DIR back. */
  const startOwn = async (env: Record<string, string>) => start({ ...env, OPENAFLOW_API_PORT: String(await freePort()) }, { webDir })

  const repoNames = async (port: number) => {
    const { text } = await send(port, '/api/board')
    return (JSON.parse(text) as { repos: { name: string; source: string }[] }).repos.map((r) => `${r.name}:${r.source}`)
  }

  test('a first start copies the old folder, so the registered repos come back', async () => {
    await writeOld()
    const { started } = await startOwn(ownEnv())
    expect(await repoNames(started.port)).toEqual(['repo:registered'])
    expect(existsSync(join(newDir(), 'resume-logs', 'a.log'))).toBe(true)
    expect(existsSync(join(newDir(), 'auto-continue.json'))).toBe(true)
    // The copy leaves the old owner file, so this server owns auto-continue in the new folder.
    expect(spies.autoStarts).toBe(1)
    expect(existsSync(join(oldDir(), 'auto-continue-owner.json'))).toBe(true)
    expect(logs.filter((l) => l.includes(oldDir()) && l.includes(newDir()))).toHaveLength(1)
  })

  test('the copy runs before the dev token file is written', async () => {
    await writeOld()
    const api = await freePort()
    const { started } = await start(ownEnv({ OPENAFLOW_API_PORT: String(api), OPENAFLOW_WEB_PORT: String(await freePort()) }))
    expect(await repoNames(started.port)).toEqual(['repo:registered'])
    expect(existsSync(join(newDir(), 'session-token'))).toBe(true)
    // The board asks gh in the repo's folder: a real gh there could still hold it at teardown.
    expect(spies.ghCwds).toContain(join(tmp, 'repo'))
  })

  test('an existing new folder is never overwritten', async () => {
    await writeOld()
    await mkdir(newDir(), { recursive: true })
    const { started } = await startOwn(ownEnv())
    expect(await repoNames(started.port)).toEqual([])
    expect(existsSync(join(newDir(), 'config.json'))).toBe(false)
  })

  /** The old auto-continue.json can't be read: a needed file the server doesn't need to start, as one another program denies. */
  const togglesUnreadable = (source: string) =>
    source === join(oldDir(), 'auto-continue.json') ? Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }) : undefined

  const stopAll = async () => {
    for (const { started, exited } of running.splice(0)) {
      started.stop()
      await exited
    }
  }

  test('an unreadable auto-continue.json: the start uses the old folder, an Add repo stays, and a later start copies it', async () => {
    await writeOld()
    const second = join(tmp, 'second')
    await mkdir(join(second, 'pod-docs'), { recursive: true })
    await writeFile(join(second, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')

    spies.copyFails = togglesUnreadable
    const first = await startOwn(ownEnv())
    expect(await repoNames(first.started.port)).toEqual(['repo:registered'])
    const failed = logs.filter((l) => l.includes('could not copy'))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain(oldDir())
    expect(failed[0]).toContain(newDir())
    expect(failed[0]).toContain('auto-continue.json')
    expect(failed[0]).toContain('EPERM')
    const token = await pageToken(first.started.port)
    const added = await send(first.started.port, '/api/repos', {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${first.started.port}`, 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
      body: JSON.stringify({ path: second }),
    })
    expect(added.status).toBe(201)
    await stopAll()
    expect(existsSync(newDir())).toBe(false)
    expect(logs.join('\n')).not.toMatch(/temp config/)

    // Still failing: the repo added last time is still there.
    const again = await startOwn(ownEnv())
    expect((await repoNames(again.started.port)).sort()).toEqual(['repo:registered', 'second:registered'])
    await stopAll()

    // The file can be read again: the copy takes the old folder as it is now.
    spies.copyFails = undefined
    const third = await startOwn(ownEnv())
    expect((await repoNames(third.started.port)).sort()).toEqual(['repo:registered', 'second:registered'])
    expect(existsSync(join(newDir(), 'config.json'))).toBe(true)
    expect(logs.filter((l) => l.includes('copied the old config folder'))).toHaveLength(1)
  })

  test('A is live on the old folder when B starts: B runs there too and copies nothing, so A loses no write', async () => {
    await writeOld()
    const second = join(tmp, 'second')
    await mkdir(join(second, 'pod-docs'), { recursive: true })
    await writeFile(join(second, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')

    spies.copyFails = togglesUnreadable
    const a = await startOwn(ownEnv())
    spies.copyFails = undefined
    const b = await startOwn(ownEnv())
    expect(existsSync(newDir())).toBe(false)
    expect(liveConfigDir(ownEnv(), process.platform, tmp)).toBe(oldDir())
    const inUse = logs.filter((l) => l.includes('in use'))
    expect(inUse).toHaveLength(1)
    expect(inUse[0]).toContain(oldDir())
    // One owner for both: A took the old folder's owner file, so B runs no automatic check.
    expect(spies.autoStarts).toBe(1)
    expect(await repoNames(b.started.port)).toEqual(['repo:registered'])

    const token = await pageToken(a.started.port)
    const added = await send(a.started.port, '/api/repos', {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${a.started.port}`, 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
      body: JSON.stringify({ path: second }),
    })
    expect(added.status).toBe(201)
    await stopAll()

    // A is gone: the next start copies the old folder with A's write in it.
    const c = await startOwn(ownEnv())
    expect((await repoNames(c.started.port)).sort()).toEqual(['repo:registered', 'second:registered'])
    expect(existsSync(join(newDir(), 'config.json'))).toBe(true)
  })

  test('dev: after a failed copy the token file is in the old folder, where the dev page looks for it', async () => {
    await writeOld()
    spies.copyFails = togglesUnreadable
    const { started } = await start(ownEnv({ OPENAFLOW_API_PORT: String(await freePort()), OPENAFLOW_WEB_PORT: String(await freePort()) }))
    expect(await repoNames(started.port)).toEqual(['repo:registered'])
    expect(liveConfigDir(ownEnv(), process.platform, tmp)).toBe(oldDir())
    expect(readSessionToken(liveConfigDir(ownEnv(), process.platform, tmp))).toHaveLength(43)
    expect(existsSync(newDir())).toBe(false)
  })

  test('dev: after a copy the token file is in the new folder, where the dev page looks for it', async () => {
    await writeOld()
    await start(ownEnv({ OPENAFLOW_API_PORT: String(await freePort()), OPENAFLOW_WEB_PORT: String(await freePort()) }))
    // A copy that didn't happen says why here, with its error code.
    expect(logs.filter((l) => /could not copy|in use|skipped/.test(l))).toEqual([])
    expect(liveConfigDir(ownEnv(), process.platform, tmp)).toBe(newDir())
    expect(readSessionToken(newDir())).toHaveLength(43)
  })

  test('a set OPENAFLOW_CONFIG_DIR never copies from the folder the server would pick', async () => {
    await writeOld()
    const { started } = await startOwn({ ...ownEnv(), OPENAFLOW_CONFIG_DIR: cfg })
    expect(await repoNames(started.port)).toEqual([])
    expect(existsSync(newDir())).toBe(false)
    expect(existsSync(join(cfg, 'config.json'))).toBe(false)
    expect(logs.some((l) => l.includes(oldDir()))).toBe(false)
  })
})
