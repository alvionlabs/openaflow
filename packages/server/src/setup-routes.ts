// The setup-workflow and use-workflow-version routes, mounted at /api/actions behind the action guard (app.ts).
// Setup creates a repo's `.openaflow/` with the bundled workflow's `workflow.json` and template state; Use rewrites
// one workflow's `version` to the bundled one. These are the only writes the app makes in a repo besides the queue
// line. The rules and why are in pod-docs/feature-details/actions.md.

import { randomBytes } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  WORKFLOW_NAME,
  WORKFLOW_VERSION,
  type Board,
  type BoardRepo,
  type NewActionEntry,
  type SetupWorkflowResult,
  type UseWorkflowVersionResult,
} from '@openaflow/model'
import { Hono } from 'hono'
import { ignoresCase as probeIgnoresCase, isInsideRepo, normalizeRepoPath, repoId, sameRepoPath } from './guard.ts'
import { loadRepos } from './repos-config.ts'
import type { WorkflowResolver } from './workflow-resolver.ts'

export type SetupRouteDeps = {
  /** The current Board. */
  board(): Board
  /** The board's config file: a repo listed there counts, also before the Board shows it. */
  configFile: string
  /** Rebuilds the Board and sends it to every client (the watcher's `rebuild`). */
  rebuild(): Promise<void>
  log: { append(entry: NewActionEntry): Promise<boolean> }
  /** The bundled workflow (start-server's one resolver). */
  workflows: Pick<WorkflowResolver, 'bundled'>
  platform: NodeJS.Platform
  ignoresCase?: (dir: string) => Promise<boolean>
  /** Copies the template folder to a new folder. Tests swap it to fail or wait midway. */
  copy?: (from: string, to: string) => Promise<void>
  /** Moves a finished temp folder or file into place. Tests swap it to fail. */
  rename?: (from: string, to: string) => Promise<void>
}

/** The folder setup creates, and the one that marks a repo as set up. */
const OPENAFLOW = '.openaflow'

/**
 * The template's empty folders, relative to `state/`. The built workflow holds each with a `.gitkeep`, but the packaged
 * app has none of them: electron-builder skips every `.gitkeep` in each copy it makes (builder-util `fs.js`), the
 * AppImage stage too, and no setting changes that. So setup makes them, each with a `.gitkeep`, and a test checks the
 * list against the built workflow.
 */
export const TEMPLATE_FOLDERS = ['plans', 'sprints/archive', 'ideas', 'known-issues', 'feature-details'] as const

/** Makes each `TEMPLATE_FOLDERS` folder under `state` with a `.gitkeep`; one the copy brought is kept as it is. */
async function makeTemplateFolders(state: string): Promise<void> {
  for (const rel of TEMPLATE_FOLDERS) {
    const dir = path.join(state, ...rel.split('/'))
    await mkdir(dir, { recursive: true })
    try {
      await writeFile(path.join(dir, '.gitkeep'), '', { flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

/** The plain copy: links in the template become files, so the repo gets no link into the app's folder. */
const copyTemplate = (from: string, to: string) => cp(from, to, { recursive: true, dereference: true, errorOnExist: true, force: false })

export function createSetupRoutes(deps: SetupRouteDeps): Hono {
  const app = new Hono()
  const ignoresCase = deps.ignoresCase ?? probeIgnoresCase
  const copy = deps.copy ?? copyTemplate
  const move = deps.rename ?? renameWithRetry
  // One setup per repo at a time, keyed by repo identity. `.openaflow` doesn't exist while the copy runs, so this
  // set is the only guard against a second one.
  const inFlight = new Set<string>()

  app.post('/setup-workflow', async (c) => {
    const { path: asked } = (await c.req.json()) as Record<string, unknown>
    if (typeof asked !== 'string' || !isAbsolute(asked, deps.platform)) return c.json({ error: 'bad request' }, 400)
    const repo = await findRepo(asked, deps, ignoresCase)
    if (!repo) return c.json({ error: 'not a repo' }, 404)
    // No await between the check and the add.
    if (inFlight.has(repo.key)) return c.json({ error: 'setup in progress' }, 409)
    inFlight.add(repo.key)
    try {
      return await setUp(repo)
    } finally {
      inFlight.delete(repo.key)
    }

    async function setUp(repo: FoundRepo) {
      const target = path.join(repo.path, OPENAFLOW)
      const present = await exists(target)
      if (present === true) return c.json({ error: 'already set up' }, 409)
      const bundle = deps.workflows.bundled()
      if (!bundle || !(await isFolder(bundle.template))) return c.json({ error: 'workflow missing' }, 409)

      const base = { action: 'setup-workflow', repoId: repo.id, repo: repo.name, target: `${OPENAFLOW}/workflows/${bundle.source} · ${bundle.version}` } as const
      const temp = path.join(repo.path, `${OPENAFLOW}.tmp-${randomBytes(6).toString('hex')}`)
      let outcome: 'created' | 'taken'
      try {
        // A repo folder the server can't read: nothing was made, but it is a failure, not a refusal.
        if (present !== false) throw present
        await mkdir(temp)
        const workflow = path.join(temp, 'workflows', bundle.source)
        await mkdir(workflow, { recursive: true })
        await writeFile(path.join(workflow, 'workflow.json'), JSON.stringify({ source: bundle.source, version: bundle.version }, null, 2) + '\n', { flag: 'wx' })
        await copy(bundle.template, path.join(workflow, 'state'))
        await makeTemplateFolders(path.join(workflow, 'state'))
        // Checked again: on POSIX a rename replaces an empty folder, so one made during the copy would be lost.
        if ((await exists(target)) !== false) outcome = 'taken'
        else {
          await move(temp, target)
          outcome = 'created'
        }
      } catch (err) {
        await rm(temp, { recursive: true, force: true }).catch(() => {})
        const error = `setup failed: ${codeOf(err)}`
        await settle(() => deps.log.append({ ...base, result: 'failed', message: error }))
        await settle(deps.rebuild)
        return c.json({ error }, 500)
      }
      if (outcome === 'taken') {
        await rm(temp, { recursive: true, force: true }).catch(() => {})
        return c.json({ error: 'already set up' }, 409)
      }
      const logged = await settle(() => deps.log.append({ ...base, result: 'created' }))
      // The Board reads the new workflow, and carries the log entry, before the response.
      await settle(deps.rebuild)
      return c.json({ outcome: 'created', logged: logged === true } satisfies SetupWorkflowResult)
    }
  })

  app.post('/use-workflow-version', async (c) => {
    const { repoId: id, name } = (await c.req.json()) as Record<string, unknown>
    if (typeof id !== 'string' || typeof name !== 'string') return c.json({ error: 'bad request' }, 400)
    const repo = deps.board().repos.find((r) => r.id === id)
    // The name comes from the Board's own list, which holds only names that meet the rule; checked again before it
    // joins a path.
    const workflow = repo?.model.workflows?.find((w) => w.name === name && w.source === 'claude-pod')
    if (!repo || !workflow || !WORKFLOW_NAME.test(workflow.name)) return c.json({ error: 'not a workflow' }, 404)
    const bundle = deps.workflows.bundled()
    if (!bundle) return c.json({ error: 'workflow missing' }, 409)

    const read = await readWorkflowJson(repo, path.join(repo.path, OPENAFLOW, 'workflows', workflow.name, 'workflow.json'), deps.platform)
    if (!read) return c.json({ error: 'workflow.json unreadable' }, 409)
    const old = read.json.version
    if (old === bundle.version) return c.json({ error: 'already current' }, 409)

    const from = typeof old === 'string' && WORKFLOW_VERSION.test(old) ? old : 'no version'
    const base = { action: 'use-workflow-version', repoId: repo.id, repo: repo.name, target: `${OPENAFLOW}/workflows/${workflow.name} · ${from} → ${bundle.version}` } as const
    // Spread keeps every key in its place; `version` stays where it was, or comes last when it was missing.
    const text = JSON.stringify({ ...read.json, version: bundle.version }, null, 2) + '\n'
    const temp = `${read.file}.tmp-${randomBytes(6).toString('hex')}`
    try {
      await writeFile(temp, text, { flag: 'wx' })
      await move(temp, read.file)
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {})
      const error = `update failed: ${codeOf(err)}`
      await settle(() => deps.log.append({ ...base, result: 'failed', message: error }))
      await settle(deps.rebuild)
      return c.json({ error }, 500)
    }
    const logged = await settle(() => deps.log.append({ ...base, result: 'updated' }))
    await settle(deps.rebuild)
    return c.json({ outcome: 'updated', logged: logged === true } satisfies UseWorkflowVersionResult)
  })

  return app
}

type FoundRepo = { path: string; key: string; id: string; name: string }

/**
 * The repo a path names, by Repo identity (`sameRepoPath`, as Add repo's duplicate check): first on the Board, with
 * its own case rule, then in the config file. The file system is asked only about registered paths, never about the
 * request's string. The registered path is the one returned and written to.
 */
async function findRepo(asked: string, deps: SetupRouteDeps, ignoresCase: (dir: string) => Promise<boolean>): Promise<FoundRepo | undefined> {
  const { platform } = deps
  const onBoard: BoardRepo | undefined = deps.board().repos.find((r) => sameRepoPath(r.path, asked, platform, r.caseless === true))
  if (onBoard) return { path: onBoard.path, key: identity(onBoard.path, platform, onBoard.caseless === true), id: onBoard.id, name: onBoard.name }
  const loaded = await loadRepos(deps.configFile)
  if ('error' in loaded) return undefined
  for (const listed of loaded.repos) {
    const caseless = await ignoresCase(normalizeRepoPath(listed, platform))
    if (!sameRepoPath(listed, asked, platform, caseless)) continue
    const p = normalizeRepoPath(listed, platform)
    return { path: p, key: identity(p, platform, caseless), id: repoId(p, platform, caseless), name: pathFor(platform).basename(p) }
  }
  return undefined
}

const identity = (p: string, platform: NodeJS.Platform, caseless: boolean) => {
  const n = normalizeRepoPath(p, platform)
  return caseless ? n.toLowerCase() : n
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix)

/** On win32 only a drive path counts, as Add repo's rule; a UNC path never matches a registered repo. */
function isAbsolute(p: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p)
  return path.posix.isAbsolute(p)
}

/** `true` when the name exists as anything (a broken link too), `false` when it is missing, else the error. */
async function exists(p: string): Promise<boolean | unknown> {
  try {
    await lstat(p)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : err
  }
}

async function isFolder(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The workflow's `workflow.json` as a JSON object, and its real path, which must be a plain file inside the repo's
 * real path. Anything else (missing, a folder, a link out of the repo, bad JSON, or JSON that isn't an object) is
 * `undefined`.
 */
async function readWorkflowJson(repo: BoardRepo, file: string, platform: NodeJS.Platform): Promise<{ file: string; json: Record<string, unknown> } | undefined> {
  try {
    const real = await realpath(file)
    if (!isInsideRepo(real, await realpath(repo.path), platform, repo.caseless === true)) return undefined
    if (!(await lstat(real)).isFile()) return undefined
    const json: unknown = JSON.parse(await readFile(real, 'utf8'))
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined
    return { file: real, json: json as Record<string, unknown> }
  } catch {
    return undefined
  }
}

const codeOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown'
}

/** On Windows a rename of something a scanner or watcher just opened fails for a moment. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)))
    }
  }
}

/** Runs `fn`; a throw is `undefined`, so the response still goes out. */
async function settle<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}
