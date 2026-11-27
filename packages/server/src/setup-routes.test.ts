import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Board, NewActionEntry } from '@openaflow/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { createBoardService } from './board-service.ts'
import { createGhReader, type GhExec } from './gh.ts'
import { createSessionToken } from './session-token.ts'
import { createSetupRoutes, TEMPLATE_FOLDERS, type SetupRouteDeps } from './setup-routes.ts'
import { createWorkflowResolver } from './workflow-resolver.ts'

const API = 3060
const WEB = 3061
const TOKEN = createSessionToken()
const HEADERS = { host: `127.0.0.1:${API}`, origin: `http://127.0.0.1:${WEB}`, 'content-type': 'application/json', 'x-openaflow-token': TOKEN }
const NOW = Date.parse('2026-11-24T12:00:00Z')
const platform = process.platform
const BUNDLED = '0.11.10'

let root: string
let cfgFile: string
/** The folder that holds `claude-pod/`, as OPENAFLOW_WORKFLOWS_DIR names it. */
let bundleRoot: string
let template: string
/** Registered, with no docs and no `.openaflow`. */
let plain: string
/** Registered, and set up with an older version. */
let setUp: string

/** Every file under a folder with its text, so a test can show what changed. Links and folders are listed too. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const d of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = join(d.parentPath, d.name)
    const key = full.slice(dir.length).replaceAll('\\', '/')
    out[key] = d.isFile() ? await readFile(full, 'utf8') : d.isDirectory() ? '<dir>' : '<link>'
  }
  return out
}

/** A folder link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
const linkDir = (target: string, at: string) => symlink(target, at, platform === 'win32' ? 'junction' : 'dir')

async function makeBundle(version = BUNDLED) {
  const dir = join(bundleRoot, 'claude-pod')
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pod', version }))
  await mkdir(join(template, 'plans'), { recursive: true })
  await mkdir(join(template, 'known-issues'), { recursive: true })
  await writeFile(join(template, 'README.md'), '# pod docs\n\npod docs: 2\n')
  await writeFile(join(template, 'handoff-queue.md'), '# Handoff Queue\n')
  await writeFile(join(template, 'plans', '.gitkeep'), '')
  await writeFile(join(template, 'known-issues', 'README.md'), '# Known issues\n')
}

async function makeSetUp(repo: string, json: string) {
  const wf = join(repo, '.openaflow', 'workflows', 'claude-pod')
  await mkdir(join(wf, 'state'), { recursive: true })
  await writeFile(join(wf, 'workflow.json'), json)
  await writeFile(join(wf, 'state', 'handoff-queue.md'), '# Handoff Queue\n')
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'openaflow-setup-')))
  bundleRoot = join(root, 'workflows')
  template = join(bundleRoot, 'claude-pod', 'skills', 'init', 'scaffold', '.openaflow', 'workflows', 'claude-pod', 'state')
  await makeBundle()
  plain = join(root, 'repos', 'plain')
  setUp = join(root, 'repos', 'set-up')
  await mkdir(plain, { recursive: true })
  await mkdir(setUp, { recursive: true })
  await makeSetUp(setUp, '{\n  "source": "claude-pod",\n  "version": "0.11.9",\n  "note": "kept",\n  "extra": { "a": [1, 2] }\n}\n')
  cfgFile = join(root, 'cfg', 'config.json')
  await mkdir(join(root, 'cfg'), { recursive: true })
  await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [{ path: plain }, { path: setUp }] }))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ghExec = (async (args: string[]) => (args[0] === 'auth' ? { status: 'ok', stdout: '' } : { status: 'ok', stdout: '[]' })) as GhExec

type Opts = {
  append?: (e: NewActionEntry) => Promise<boolean>
  copy?: SetupRouteDeps['copy']
  rename?: SetupRouteDeps['rename']
  mapBoard?: (b: Board) => Board
  /** OPENAFLOW_WORKFLOWS_DIR; defaults to the temp bundle. */
  workflowsRoot?: string | undefined
}

/** The setup routes behind the real app and guard, over a real board service, config file, resolver, and temp repos. */
async function setup(opts: Opts = {}) {
  const logged: NewActionEntry[] = []
  const events: string[] = []
  const service = createBoardService({
    configFile: cfgFile,
    portsDir: join(root, 'ports'),
    claudeDir: join(root, 'claude'),
    transcriptDays: 30,
    platform,
    gh: createGhReader({ exec: ghExec, now: () => NOW }),
    now: () => NOW,
  })
  const build = async () => (opts.mapBoard ?? ((b: Board) => b))(await service.build())
  let board: Board = await build()
  const source = {
    board: () => board,
    subscribe: () => () => {},
    rebuild: async () => {
      events.push('rebuild')
      board = await build()
    },
  }
  const routes = createSetupRoutes({
    board: source.board,
    configFile: cfgFile,
    rebuild: source.rebuild,
    workflows: createWorkflowResolver({ root: 'workflowsRoot' in opts ? opts.workflowsRoot : bundleRoot }),
    platform,
    ...(opts.copy ? { copy: opts.copy } : {}),
    ...(opts.rename ? { rename: opts.rename } : {}),
    log: {
      append: async (e) => {
        events.push('log')
        if (opts.append) return opts.append(e)
        logged.push(e)
        return true
      },
    },
  })
  const app = createApp({
    ports: [API, WEB],
    token: TOKEN,
    source,
    addRepo: async () => ({ error: 'not a directory' }),
    timeline: async () => undefined,
    actions: new Hono().route('/', routes),
  })
  const repoOf = (path: string) => board.repos.find((r) => r.path === path)!
  const request = (route: string, body: unknown, headers: Record<string, string> = HEADERS, method = 'POST') =>
    app.request(`/api/actions/${route}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) })
  const post = async (route: string, body: unknown) => {
    const res = await request(route, body)
    return { status: res.status, body: (await res.json()) as unknown }
  }
  return { request, post, logged, events, board: () => board, repoOf, rebuild: source.rebuild }
}

/** The empty folders setup makes in state/, each held by a `.gitkeep`, as `snapshot` lists them. */
const KEEPS: Record<string, string> = {
  '/plans': '<dir>',
  '/plans/.gitkeep': '',
  '/sprints': '<dir>',
  '/sprints/archive': '<dir>',
  '/sprints/archive/.gitkeep': '',
  '/ideas': '<dir>',
  '/ideas/.gitkeep': '',
  '/known-issues': '<dir>',
  '/known-issues/.gitkeep': '',
  '/feature-details': '<dir>',
  '/feature-details/.gitkeep': '',
}

/** Every `.gitkeep` under `dir` removed, and each folder left empty by that removed too: what electron-builder packages. */
async function stripKeeps(dir: string): Promise<void> {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, d.name)
    if (d.isDirectory()) {
      await stripKeeps(full)
      if ((await readdir(full)).length === 0) await rm(full, { recursive: true })
    } else if (d.name === '.gitkeep') await rm(full)
  }
}

const workflowJson = (repo: string, name = 'claude-pod') => join(repo, '.openaflow', 'workflows', name, 'workflow.json')
/** The names in a repo folder that a setup's temp folder would have. */
const temps = async (repo: string) => (await readdir(repo)).filter((n) => n.startsWith('.openaflow.tmp-'))

describe('setup-workflow route', () => {
  test('creates .openaflow', async () => {
    const s = await setup()
    expect(await s.post('setup-workflow', { path: plain })).toEqual({ status: 200, body: { outcome: 'created', logged: true } })
    expect(await readFile(workflowJson(plain), 'utf8')).toBe(`{\n  "source": "claude-pod",\n  "version": "${BUNDLED}"\n}\n`)
    // The template is copied whole as state/, plus the template's empty folders, with nothing else in the repo but `.openaflow`.
    expect(await snapshot(join(plain, '.openaflow', 'workflows', 'claude-pod', 'state'))).toEqual({ ...(await snapshot(template)), ...KEEPS })
    expect(await readdir(plain)).toEqual(['.openaflow'])
    expect(await readdir(join(plain, '.openaflow'))).toEqual(['workflows'])
    expect((await readdir(join(plain, '.openaflow', 'workflows', 'claude-pod'))).sort()).toEqual(['state', 'workflow.json'])
    // The template itself is untouched.
    expect(await readdir(template)).toContain('README.md')
  })

  test('a packaged template with no .gitkeep files gives the same state as the built one', async () => {
    const s = await setup()
    expect((await s.post('setup-workflow', { path: plain })).status).toBe(200)
    const built = await snapshot(join(plain, '.openaflow', 'workflows', 'claude-pod', 'state'))
    await stripKeeps(template)
    expect(await readdir(template)).not.toContain('plans')
    const other = join(root, 'repos', 'other')
    await mkdir(other)
    await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [{ path: plain }, { path: setUp }, { path: other }] }))
    expect((await s.post('setup-workflow', { path: other })).status).toBe(200)
    expect(await snapshot(join(other, '.openaflow', 'workflows', 'claude-pod', 'state'))).toEqual(built)
    for (const [key, value] of Object.entries(KEEPS)) expect(built[key], key).toBe(value)
  })

  test('a template folder setup cannot make fails as a failed copy does, and leaves nothing', async () => {
    // `ideas` is a file in this template, so the folder can't be made.
    await writeFile(join(template, 'ideas'), 'not a folder')
    const s = await setup()
    // The code differs by system (EEXIST here; Windows may say another), so only its shape is checked.
    const res = await s.post('setup-workflow', { path: plain })
    expect(res.status).toBe(500)
    expect((res.body as { error: string }).error).toMatch(/^setup failed: [A-Z]+$/)
    expect(await readdir(plain)).toEqual([])
    expect(s.logged).toEqual([expect.objectContaining({ action: 'setup-workflow', result: 'failed', message: (res.body as { error: string }).error })])
  })

  test("the list covers every empty folder in the built workflow's template", async (ctx) => {
    const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workflow', 'dist', 'claude-pod', 'skills', 'init', 'scaffold', '.openaflow', 'workflows', 'claude-pod', 'state')
    // Locally the guard skips until the workflow is built; on CI, `pnpm verify` builds it first, so a missing one fails.
    if (!existsSync(dist)) {
      if (process.env.CI) throw new Error(`no built workflow at ${dist}: CI must build it before the tests`)
      return ctx.skip()
    }
    const keeps = (await readdir(dist, { recursive: true, withFileTypes: true }))
      .filter((d) => d.name === '.gitkeep')
      .map((d) => d.parentPath.slice(dist.length + 1).replaceAll('\\', '/'))
      .sort()
    expect(keeps).toEqual([...TEMPLATE_FOLDERS].sort())
  })

  test('the path is matched by repo identity, and the registered path is the one written', async () => {
    const s = await setup()
    // A trailing separator and a `..` step name the same repo.
    expect((await s.post('setup-workflow', { path: join(plain, '..', 'plain') + '/' })).status).toBe(200)
    expect(await readFile(workflowJson(plain), 'utf8')).toContain(BUNDLED)
  })

  test('a repo on the Board whose file system ignores case matches another spelling', async () => {
    // Forced: this test machine's temp folder may be case-sensitive, so the Board says the repo's isn't.
    const s = await setup({ mapBoard: (b) => ({ ...b, repos: b.repos.map((r) => (r.path === plain ? { ...r, caseless: true } : r)) }) })
    const id = s.repoOf(plain).id
    // Out of the config, so only the Board can match it.
    await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [] }))
    const res = await s.post('setup-workflow', { path: plain.toUpperCase() })
    expect(res).toEqual({ status: 200, body: { outcome: 'created', logged: true } })
    // Written at the Board's spelling, not the request's.
    expect(await readFile(workflowJson(plain), 'utf8')).toContain(BUNDLED)
    expect(s.logged[0]).toMatchObject({ repoId: id, repo: 'plain' })
  })

  test('a repo only in the config, not yet on the Board, is a repo', async () => {
    const s = await setup()
    const late = join(root, 'repos', 'late')
    await mkdir(late)
    await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [{ path: plain }, { path: setUp }, { path: late }] }))
    expect(s.board().repos.some((r) => r.path === late)).toBe(false)
    expect((await s.post('setup-workflow', { path: late })).status).toBe(200)
    expect(await readFile(workflowJson(late), 'utf8')).toContain(BUNDLED)
    expect(s.logged[0]).toMatchObject({ action: 'setup-workflow', repo: 'late', result: 'created' })
    expect(s.logged[0]!.repoId).toMatch(/late$/)
  })

  test('not a repo', async () => {
    const s = await setup()
    const other = join(root, 'repos', 'other')
    await mkdir(other)
    const before = await snapshot(join(root, 'repos'))
    for (const path of [other, join(plain, 'sub'), join(root, 'repos')]) {
      expect(await s.post('setup-workflow', { path }), path).toEqual({ status: 404, body: { error: 'not a repo' } })
    }
    // An unreadable config still leaves the Board's repos.
    await writeFile(cfgFile, '{ corrupt')
    expect(await s.post('setup-workflow', { path: other })).toEqual({ status: 404, body: { error: 'not a repo' } })
    expect(await snapshot(join(root, 'repos'))).toEqual(before)
    expect(s.logged).toEqual([])
    expect(s.events).toEqual([])
  })

  test('a missing, relative, or non-string path is a bad request', async () => {
    const s = await setup()
    for (const body of [{}, { path: 7 }, { path: 'repos/plain' }, { path: '' }]) {
      expect(await s.post('setup-workflow', body), JSON.stringify(body)).toEqual({ status: 400, body: { error: 'bad request' } })
    }
    expect(await readdir(plain)).toEqual([])
  })

  test('already set up', async () => {
    const s = await setup()
    const cases: [string, (repo: string) => Promise<void>][] = [
      ['folder', (repo) => mkdir(join(repo, '.openaflow'))],
      ['file', (repo) => writeFile(join(repo, '.openaflow'), 'x')],
      ['link', (repo) => linkDir(join(root, 'elsewhere'), join(repo, '.openaflow'))],
    ]
    for (const [name, make] of cases) {
      await rm(join(plain, '.openaflow'), { recursive: true, force: true })
      await make(plain)
      const before = await snapshot(plain)
      expect(await s.post('setup-workflow', { path: plain }), name).toEqual({ status: 409, body: { error: 'already set up' } })
      expect(await snapshot(plain), name).toEqual(before)
    }
    // The set-up repo too, read from the Board.
    expect(await s.post('setup-workflow', { path: setUp })).toEqual({ status: 409, body: { error: 'already set up' } })
    expect(s.logged).toEqual([])
  })

  test('workflow missing', async () => {
    // No bundle: the env unset, or set but with no plugin.json.
    for (const workflowsRoot of [undefined, join(root, 'nowhere')]) {
      const s = await setup({ workflowsRoot })
      expect(await s.post('setup-workflow', { path: plain })).toEqual({ status: 409, body: { error: 'workflow missing' } })
    }
    // A bundle with no template, or a file where the template folder should be.
    await rm(template, { recursive: true })
    const noTemplate = await setup()
    expect(await noTemplate.post('setup-workflow', { path: plain })).toEqual({ status: 409, body: { error: 'workflow missing' } })
    await writeFile(template, 'not a folder')
    const fileTemplate = await setup()
    expect(await fileTemplate.post('setup-workflow', { path: plain })).toEqual({ status: 409, body: { error: 'workflow missing' } })
    expect(await readdir(plain)).toEqual([])
    expect(noTemplate.logged).toEqual([])
  })

  test('failed copy leaves nothing', async () => {
    const s = await setup({
      copy: async (_from, to) => {
        // Part of the copy lands, then the disk fills.
        await mkdir(join(to, 'plans'), { recursive: true })
        await writeFile(join(to, 'README.md'), 'half')
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      },
    })
    expect(await s.post('setup-workflow', { path: plain })).toEqual({ status: 500, body: { error: 'setup failed: ENOSPC' } })
    expect(await readdir(plain)).toEqual([])
    expect(s.logged).toEqual([{ action: 'setup-workflow', repoId: s.repoOf(plain).id, repo: 'plain', target: `.openaflow/workflows/claude-pod · ${BUNDLED}`, result: 'failed', message: 'setup failed: ENOSPC' }])
    expect(s.events).toEqual(['log', 'rebuild'])
  })

  test('an error with no code reads setup failed: unknown', async () => {
    const s = await setup({ copy: () => Promise.reject(new Error('odd')) })
    expect(await s.post('setup-workflow', { path: plain })).toEqual({ status: 500, body: { error: 'setup failed: unknown' } })
    expect(await readdir(plain)).toEqual([])
  })

  test('a .openaflow made while the copy runs is kept, and the temp folder goes', async () => {
    const s = await setup({
      copy: async (_from, to) => {
        await mkdir(to)
        // Another tool (or the human) makes an empty `.openaflow` now. A rename onto it would replace it on POSIX.
        await mkdir(join(plain, '.openaflow'))
        await writeFile(join(plain, '.openaflow', 'theirs.txt'), 'theirs')
      },
    })
    expect(await s.post('setup-workflow', { path: plain })).toEqual({ status: 409, body: { error: 'already set up' } })
    expect(await snapshot(join(plain, '.openaflow'))).toEqual({ '/theirs.txt': 'theirs' })
    expect(await temps(plain)).toEqual([])
  })

  test('one at a time', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let copies = 0
    const s = await setup({
      copy: async (from, to) => {
        copies++
        if (copies === 1) await held
        const { cp } = await import('node:fs/promises')
        await cp(from, to, { recursive: true })
      },
    })
    const first = s.post('setup-workflow', { path: plain })
    await expect.poll(() => copies).toBe(1)
    // Another spelling of the same repo is the same setup.
    expect(await s.post('setup-workflow', { path: plain + '/' })).toEqual({ status: 409, body: { error: 'setup in progress' } })
    // Another repo is not held up.
    const other = join(root, 'repos', 'other')
    await mkdir(other)
    await writeFile(cfgFile, JSON.stringify({ version: 1, repos: [{ path: plain }, { path: setUp }, { path: other }] }))
    expect((await s.post('setup-workflow', { path: other })).status).toBe(200)
    release()
    expect(await first).toEqual({ status: 200, body: { outcome: 'created', logged: true } })
    // Done: the next one is refused for what is there, not for a setup in progress.
    expect(await s.post('setup-workflow', { path: plain })).toEqual({ status: 409, body: { error: 'already set up' } })
  })

  test('a failed setup frees the repo for the next one', async () => {
    let fail = true
    const s = await setup({
      copy: async (from, to) => {
        if (fail) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        const { cp } = await import('node:fs/promises')
        await cp(from, to, { recursive: true })
      },
    })
    expect((await s.post('setup-workflow', { path: plain })).status).toBe(500)
    fail = false
    expect((await s.post('setup-workflow', { path: plain })).status).toBe(200)
  })

  test('logs and rebuilds', async () => {
    let boardAtLog: Board | undefined
    const s2 = await setup({
      append: async () => {
        boardAtLog = s2.board()
        return true
      },
    })
    const res = await s2.post('setup-workflow', { path: plain })
    expect(res).toEqual({ status: 200, body: { outcome: 'created', logged: true } })
    expect(s2.events).toEqual(['log', 'rebuild'])
    // Before the log the Board had no workflow; the answer comes after the rebuild, which reads it.
    expect(boardAtLog!.repos.find((r) => r.path === plain)!.model.openaflow).toBeUndefined()
    expect(s2.repoOf(plain).model).toMatchObject({ openaflow: true, workflows: [{ name: 'claude-pod', source: 'claude-pod', version: BUNDLED }] })
  })

  test('the entry names the workflow and version; a failed append gives logged false', async () => {
    const s = await setup()
    await s.post('setup-workflow', { path: plain })
    expect(s.logged).toEqual([{ action: 'setup-workflow', repoId: s.repoOf(plain).id, repo: 'plain', target: `.openaflow/workflows/claude-pod · ${BUNDLED}`, result: 'created' }])
    await rm(join(plain, '.openaflow'), { recursive: true })
    const noLog = await setup({ append: async () => false })
    expect(await noLog.post('setup-workflow', { path: plain })).toEqual({ status: 200, body: { outcome: 'created', logged: false } })
    await rm(join(plain, '.openaflow'), { recursive: true })
    const throws = await setup({ append: () => Promise.reject(new Error('disk')) })
    expect(await throws.post('setup-workflow', { path: plain })).toEqual({ status: 200, body: { outcome: 'created', logged: false } })
  })
})

describe('use-workflow-version route', () => {
  test('use rewrites version', async () => {
    const s = await setup()
    const res = await s.post('use-workflow-version', { repoId: s.repoOf(setUp).id, name: 'claude-pod' })
    expect(res).toEqual({ status: 200, body: { outcome: 'updated', logged: true } })
    // Only `version` changed: every key stays, in its place, as 2-space JSON with a final newline.
    expect(await readFile(workflowJson(setUp), 'utf8')).toBe(`{\n  "source": "claude-pod",\n  "version": "${BUNDLED}",\n  "note": "kept",\n  "extra": {\n    "a": [\n      1,\n      2\n    ]\n  }\n}\n`)
    expect((await readdir(join(setUp, '.openaflow', 'workflows', 'claude-pod'))).sort()).toEqual(['state', 'workflow.json'])
    expect(s.logged).toEqual([
      { action: 'use-workflow-version', repoId: s.repoOf(setUp).id, repo: 'set-up', target: `.openaflow/workflows/claude-pod · 0.11.9 → ${BUNDLED}`, result: 'updated' },
    ])
    expect(s.events).toEqual(['log', 'rebuild'])
    expect(s.repoOf(setUp).model.workflows).toEqual([expect.objectContaining({ name: 'claude-pod', version: BUNDLED })])
  })

  test('a workflow.json with no version gets one', async () => {
    await writeFile(workflowJson(setUp), '{"source":"claude-pod"}')
    const s = await setup()
    expect((await s.post('use-workflow-version', { repoId: s.repoOf(setUp).id, name: 'claude-pod' })).status).toBe(200)
    expect(await readFile(workflowJson(setUp), 'utf8')).toBe(`{\n  "source": "claude-pod",\n  "version": "${BUNDLED}"\n}\n`)
    expect(s.logged[0]!.target).toBe(`.openaflow/workflows/claude-pod · no version → ${BUNDLED}`)
  })

  test('use edges', async () => {
    const s = await setup()
    const id = s.repoOf(setUp).id
    const use = (body: unknown) => s.post('use-workflow-version', body)
    const notAWorkflow = { status: 404, body: { error: 'not a workflow' } }
    const unreadable = { status: 409, body: { error: 'workflow.json unreadable' } }

    // Names and repos the Board doesn't hold.
    expect(await use({ repoId: id, name: 'other' })).toEqual(notAWorkflow)
    expect(await use({ repoId: id, name: '../set-up' })).toEqual(notAWorkflow)
    expect(await use({ repoId: s.repoOf(plain).id, name: 'claude-pod' })).toEqual(notAWorkflow)
    expect(await use({ repoId: 'nope', name: 'claude-pod' })).toEqual(notAWorkflow)

    // Each bad file is put in place after the Board was built, which still reads it as a claude-pod workflow.
    const file = workflowJson(setUp)
    for (const text of ['{ corrupt', '[]', 'null', '"claude-pod"', '']) {
      await writeFile(file, text)
      expect(await use({ repoId: id, name: 'claude-pod' }), JSON.stringify(text)).toEqual(unreadable)
      expect(await readFile(file, 'utf8')).toBe(text)
    }
    await rm(file)
    expect(await use({ repoId: id, name: 'claude-pod' })).toEqual(unreadable)
    // A folder in its place.
    await mkdir(file)
    expect(await use({ repoId: id, name: 'claude-pod' })).toEqual(unreadable)
    await rm(file, { recursive: true })

    // A link out of the repo: the file outside is never written.
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'workflow.json'), '{"source":"claude-pod","version":"0.11.9"}')
    const wf = join(setUp, '.openaflow', 'workflows', 'claude-pod')
    await rm(wf, { recursive: true })
    await linkDir(outside, wf)
    expect(await use({ repoId: id, name: 'claude-pod' })).toEqual(unreadable)
    expect(await readFile(join(outside, 'workflow.json'), 'utf8')).toBe('{"source":"claude-pod","version":"0.11.9"}')
    await rm(wf, { recursive: true, force: true })

    // Same version → already current, nothing written.
    await makeSetUp(setUp, `{"source":"claude-pod","version":"${BUNDLED}"}`)
    expect(await use({ repoId: id, name: 'claude-pod' })).toEqual({ status: 409, body: { error: 'already current' } })
    expect(await readFile(file, 'utf8')).toBe(`{"source":"claude-pod","version":"${BUNDLED}"}`)

    // Bad requests.
    for (const body of [{}, { repoId: id }, { repoId: id, name: 3 }, { repoId: 1, name: 'claude-pod' }]) {
      expect(await use(body), JSON.stringify(body)).toEqual({ status: 400, body: { error: 'bad request' } })
    }
    expect(s.logged).toEqual([])
    expect(s.events).toEqual([])
  })

  test('a workflow whose source is not claude-pod, or unset, is not a workflow', async () => {
    const other = join(setUp, '.openaflow', 'workflows', 'mine')
    await mkdir(join(other, 'state'), { recursive: true })
    await writeFile(join(other, 'workflow.json'), '{"source":"mine","version":"1.0.0"}')
    const bare = join(setUp, '.openaflow', 'workflows', 'bare')
    await mkdir(join(bare, 'state'), { recursive: true })
    const s = await setup()
    const id = s.repoOf(setUp).id
    expect(s.repoOf(setUp).model.workflows!.map((w) => w.name)).toEqual(['bare', 'claude-pod', 'mine'])
    for (const name of ['mine', 'bare']) {
      expect(await s.post('use-workflow-version', { repoId: id, name }), name).toEqual({ status: 404, body: { error: 'not a workflow' } })
    }
    expect(await readFile(join(other, 'workflow.json'), 'utf8')).toBe('{"source":"mine","version":"1.0.0"}')
  })

  test('no bundle → workflow missing, nothing written', async () => {
    const s = await setup({ workflowsRoot: undefined })
    const before = await readFile(workflowJson(setUp), 'utf8')
    expect(await s.post('use-workflow-version', { repoId: s.repoOf(setUp).id, name: 'claude-pod' })).toEqual({ status: 409, body: { error: 'workflow missing' } })
    expect(await readFile(workflowJson(setUp), 'utf8')).toBe(before)
  })

  test('a write that fails leaves the file and no temp file → 500 update failed, logged', async (ctx) => {
    if (platform === 'win32' || process.getuid?.() === 0) ctx.skip('needs POSIX modes and a non-root user')
    const s = await setup()
    const dir = join(setUp, '.openaflow', 'workflows', 'claude-pod')
    const before = await readFile(workflowJson(setUp), 'utf8')
    await chmod(dir, 0o500)
    try {
      expect(await s.post('use-workflow-version', { repoId: s.repoOf(setUp).id, name: 'claude-pod' })).toEqual({ status: 500, body: { error: 'update failed: EACCES' } })
    } finally {
      await chmod(dir, 0o700)
    }
    expect(await readFile(workflowJson(setUp), 'utf8')).toBe(before)
    expect((await readdir(dir)).sort()).toEqual(['state', 'workflow.json'])
    expect(s.logged).toEqual([expect.objectContaining({ action: 'use-workflow-version', result: 'failed', message: 'update failed: EACCES' })])
    expect(s.events).toEqual(['log', 'rebuild'])
  })
})

describe('use-workflow-version route: failures', () => {
  test('a rename that fails leaves the file as it was and no temp file', async () => {
    const s = await setup({ rename: () => Promise.reject(Object.assign(new Error('held'), { code: 'EBUSY' })) })
    const dir = join(setUp, '.openaflow', 'workflows', 'claude-pod')
    const before = await readFile(workflowJson(setUp), 'utf8')
    expect(await s.post('use-workflow-version', { repoId: s.repoOf(setUp).id, name: 'claude-pod' })).toEqual({ status: 500, body: { error: 'update failed: EBUSY' } })
    expect(await readFile(workflowJson(setUp), 'utf8')).toBe(before)
    expect((await readdir(dir)).sort()).toEqual(['state', 'workflow.json'])
  })

  test('a workflow.json that is not a plain file (a FIFO) is unreadable, and is never opened', async (ctx) => {
    if (platform === 'win32') ctx.skip('no FIFOs on Windows')
    const s = await setup()
    await rm(workflowJson(setUp))
    // Opening a FIFO with no writer would hang the request.
    execFileSync('mkfifo', [workflowJson(setUp)], { windowsHide: true })
    expect(await s.post('use-workflow-version', { repoId: s.repoOf(setUp).id, name: 'claude-pod' })).toEqual({ status: 409, body: { error: 'workflow.json unreadable' } })
  }, 3000)
})

describe('setup routes: the action guard', () => {
  test('behind the action guard', async () => {
    const s = await setup()
    const before = { plain: await snapshot(plain), setUp: await snapshot(setUp) }
    const { origin: _o, ...noOrigin } = HEADERS
    const { 'x-openaflow-token': _t, ...noToken } = HEADERS
    const cases: [Record<string, string>, string, number, string][] = [
      [noToken, 'POST', 403, 'bad token'],
      [{ ...HEADERS, 'x-openaflow-token': 'wrong' }, 'POST', 403, 'bad token'],
      [{ ...HEADERS, origin: 'http://evil.example' }, 'POST', 403, 'forbidden origin'],
      [noOrigin, 'POST', 403, 'forbidden origin'],
      [HEADERS, 'GET', 405, 'method not allowed'],
    ]
    const bodies: [string, unknown][] = [
      ['setup-workflow', { path: plain }],
      ['use-workflow-version', { repoId: s.repoOf(setUp).id, name: 'claude-pod' }],
    ]
    for (const [route, body] of bodies) {
      for (const [headers, method, status, error] of cases) {
        const res = await s.request(route, body, headers, method)
        expect(res.status, `${route} ${method} ${error}`).toBe(status)
        expect(await res.json()).toEqual({ error })
      }
      // A body that isn't a JSON object.
      const arr = await s.request(route, [])
      expect(arr.status, `${route} array body`).toBe(400)
    }
    expect({ plain: await snapshot(plain), setUp: await snapshot(setUp) }).toEqual(before)
    expect(s.logged).toEqual([])
  })
})
