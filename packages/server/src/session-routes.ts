// The New session and Dismiss routes, mounted at /api/actions behind the action guard (app.ts). New session starts
// the user's own interactive `claude` in the desktop's terminal host; Dismiss forgets a session that has ended or
// stopped. The rules are sprint terminal-tab's shared contract §5; the why is in
// pod-docs/feature-details/hosted-sessions.md.

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { skillCommand, type Board, type BoardRepo, type DismissSessionResult, type NewActionEntry, type NewSessionResult, type SkillId } from '@openaflow/model'
import { Hono, type Context } from 'hono'
import { normalizeRepoPath, sameRepoPath } from './guard.ts'
import { sessionCommand, type SessionCommandInput } from './session-command.ts'
import type { SessionStore, StoredSession } from './session-store.ts'
import { NoAnswer, type TerminalChannel } from './terminal-channel.ts'

export type SessionRouteDeps = {
  /** The current Board. */
  board(): Board
  /** Rebuilds the Board and sends it to every client (the watcher's `rebuild`). */
  rebuild(): Promise<void>
  log: { append(entry: NewActionEntry): Promise<boolean> }
  store: SessionStore
  /** The channel to the desktop's main process. None (dev, `pnpm start`): `409 no terminal host`. */
  terminals: Pick<TerminalChannel, 'start' | 'dispose'> | undefined
  /** The found `claude`'s absolute path, read at each start. */
  claude(): string | undefined
  /** `OPENAFLOW_HOOKS_PLUGIN`: the hooks plugin folder main names. None: `409 no terminal host`. */
  pluginDir: string | undefined
  /** The live config folder: the hook files go to its `hooks` folder. */
  configDir: string
  /** The env a session starts from (the tool finder's, in production). */
  env(): NodeJS.ProcessEnv
  platform: NodeJS.Platform
  now(): number
  /** A UUID v4. Left out: `crypto.randomUUID`. */
  newId?: () => string
  windows?: SessionCommandInput['windows']
}

/** At most this many sessions `starting` or `live`, in all repos. */
export const MAX_OPEN_SESSIONS = 10
const SIZE = { cols: { min: 2, max: 500, default: 120 }, rows: { min: 1, max: 200, default: 30 } }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isOpen = (r: StoredSession) => r.state === 'starting' || r.state === 'live'
/** A size field: absent gives the default; otherwise an integer in range, or `undefined` for a bad one. */
const size = (v: unknown, r: { min: number; max: number; default: number }) =>
  v === undefined ? r.default : Number.isInteger(v) && (v as number) >= r.min && (v as number) <= r.max ? (v as number) : undefined
/** The log's target: the skill's command or `plain`, and the marker's first 8 characters. Never the text. */
const targetOf = (skill: SkillId, marker: string) => `${skillCommand(skill) ?? 'plain'} · ${marker.slice(0, 8)}`

async function body(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const v: unknown = await c.req.json()
    return isRecord(v) ? v : undefined
  } catch {
    return undefined
  }
}

export function createSessionRoutes(deps: SessionRouteDeps): Hono {
  const app = new Hono()
  const newId = deps.newId ?? randomUUID
  const inRepo = (repo: BoardRepo, r: StoredSession) => sameRepoPath(repo.path, normalizeRepoPath(r.repoPath, deps.platform), deps.platform, repo.caseless === true)
  /** Runs `fn`; a throw is `undefined`, so the response still goes out. */
  const settle = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn()
    } catch {
      return undefined
    }
  }

  app.post('/new-session', async (c) => {
    const b = await body(c)
    const cols = size(b?.cols, SIZE.cols)
    const rows = size(b?.rows, SIZE.rows)
    if (!b || typeof b.repoId !== 'string' || typeof b.skill !== 'string' || typeof b.text !== 'string' || cols === undefined || rows === undefined)
      return c.json({ error: 'bad request' }, 400)
    const terminals = deps.terminals
    if (!terminals || deps.pluginDir === undefined) return c.json({ error: 'no terminal host' }, 409)
    const repo = deps.board().repos.find((r) => r.id === b.repoId)
    if (!repo) return c.json({ error: 'not a repo' }, 404)
    const claude = deps.claude()
    if (claude === undefined) return c.json({ error: 'claude not found' }, 409)

    // From here to the store's add, nothing waits: a second request sees this one's record.
    const records = deps.store.list()
    if (records.some((r) => r.state === 'starting' && inRepo(repo, r))) return c.json({ error: 'session starting' }, 409)
    if (records.filter(isOpen).length >= MAX_OPEN_SESSIONS) return c.json({ error: 'too many sessions' }, 409)
    const marker = newId()
    const sessionId = newId()
    const skill = b.skill as SkillId
    const cmd = sessionCommand({
      claude,
      repo: repo.path,
      skill,
      text: b.text,
      sessionId,
      runMarker: marker,
      pluginDir: deps.pluginDir,
      configDir: deps.configDir,
      env: deps.env(),
      platform: deps.platform,
      windows: deps.windows,
    })
    if (typeof cmd === 'string') return c.json({ error: cmd }, 400)

    const record: StoredSession = { marker, repoPath: repo.path, sessionId, skill, startedAt: deps.now(), state: 'starting', ...(cmd.typeYourself ? { typeYourself: true as const } : {}) }
    await deps.store.add(record)
    const base = { action: 'new-session', repoId: repo.id, repo: repo.name, target: targetOf(skill, marker) } as const
    const { typeYourself, ...run } = cmd
    let failure: { status: 502 | 504; error: string; message: string } | undefined
    try {
      const { pid } = await terminals.start({ id: marker, ...run, cols, rows })
      // The channel's event has done this already; a start without one (a test's fake) still lands here.
      await deps.store.started(marker, pid)
    } catch (err) {
      const word = err instanceof Error ? err.message : String(err)
      // No answer: the record stays `starting` until a late answer or the next start's reconcile.
      if (err instanceof NoAnswer) failure = { status: 504, error: 'terminals unavailable', message: 'no answer' }
      else {
        failure = { status: 502, error: `start failed: ${word}`, message: word }
        await deps.store.failed(marker)
      }
    }
    const logged = await settle(() => deps.log.append(failure ? { ...base, result: 'failed', message: failure.message } : { ...base, result: 'started' }))
    await settle(deps.rebuild)
    if (failure) return c.json({ error: failure.error }, failure.status)
    return c.json({ outcome: 'started', marker, logged: logged === true, ...(typeYourself ? { typeYourself } : {}) } satisfies NewSessionResult)
  })

  app.post('/dismiss-session', async (c) => {
    const b = await body(c)
    if (!b || typeof b.repoId !== 'string' || typeof b.marker !== 'string') return c.json({ error: 'bad request' }, 400)
    const terminals = deps.terminals
    if (!terminals) return c.json({ error: 'no terminal host' }, 409)
    const repo = deps.board().repos.find((r) => r.id === b.repoId)
    // Only a marker the store holds goes on: it names the hook file deleted below.
    const record = repo && deps.store.list().find((r) => r.marker === b.marker && inRepo(repo, r))
    if (!repo || !record) return c.json({ error: 'no session' }, 404)
    if (isOpen(record)) return c.json({ error: 'session is live' }, 409)

    await deps.store.remove(record.marker)
    const hookFile = path.join(deps.configDir, 'hooks', `${record.marker}.jsonl`)
    const deleted = await unlink(hookFile).then(
      () => true,
      (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
    )
    // The host may still hold its screen; nothing else will ask for it.
    terminals.dispose(record.marker)
    const base = { action: 'dismiss-session', repoId: repo.id, repo: repo.name, target: targetOf(record.skill, record.marker) } as const
    const logged = await settle(() => deps.log.append({ ...base, result: 'dismissed', ...(deleted ? {} : { message: "Couldn't delete its hook file." }) }))
    await settle(deps.rebuild)
    return c.json({ outcome: 'dismissed', logged: logged === true } satisfies DismissSessionResult)
  })

  return app
}
