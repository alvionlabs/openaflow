// The New session, Resume, and Dismiss routes, mounted at /api/actions behind the action guard (app.ts). New session
// starts the user's own interactive `claude` in the desktop's terminal host; Resume starts an ended or stopped one's
// conversation again in a new session; Dismiss forgets a session that has ended or stopped. The rules are sprint
// terminal-tab's shared contract §5 and session-life's §5; the why is in pod-docs/feature-details/hosted-sessions.md.

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  SETTINGS_SCROLLBACK,
  skillCommand,
  type Board,
  type BoardRepo,
  type DismissSessionResult,
  type NewActionEntry,
  type NewSessionResult,
  type ResumeSessionResult,
  type SkillId,
} from '@openaflow/model'
import { Hono, type Context } from 'hono'
import { normalizeRepoPath, sameRepoPath } from './guard.ts'
import { applyPlan, createRunWrapper, type RunWrapper, type ScopeProbe, type WrappedStart } from './run-wrapper.ts'
import { resumeCommand, sessionCommand, type SessionCommand, type SessionCommandInput } from './session-command.ts'
import { hostedSession, resumeFacts, resumeOf, type HookReader, type SessionStore, type StoredSession } from './session-store.ts'
import type { SettingsStore } from './settings-store.ts'
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
  /** The live config folder: the hook files go to its `hooks` folder, the saved screens to its `screens` folder. */
  configDir: string
  /** The hook files' reader: Resume reads each session's live session and the sessions it holds. */
  hooks: Pick<HookReader, 'read'>
  /** The transcript folder: Resume looks there for the live session's conversation. */
  claudeDir: string
  /** The server start's scope probe (`scopeProbe`). Left out: off, so no wrapper and no stop. */
  probe?: () => Promise<ScopeProbe>
  /** The env a session starts from (the tool finder's, in production). */
  env(): NodeJS.ProcessEnv
  platform: NodeJS.Platform
  now(): number
  /** A UUID v4. Left out: `crypto.randomUUID`. */
  newId?: () => string
  windows?: SessionCommandInput['windows']
  /** The settings file, read at each start. Left out: the defaults. */
  settings?: Pick<SettingsStore, 'read'>
  /** The run wrapper's checks, one per server start. Left out: a new one for these routes. */
  wrapper?: RunWrapper
  /** The console. Left out: `console.log`. */
  logLine?: (line: string) => void
}

/** At most this many sessions `starting` or `live`, in all repos. */
export const MAX_OPEN_SESSIONS = 10
const SIZE = { cols: { min: 2, max: 500, default: 120 }, rows: { min: 1, max: 200, default: 30 } }

const PROBE_OFF: ScopeProbe = { on: false, reason: 'no probe' }
const DEFAULT_SETTINGS = { read: async () => ({ scrollback: SETTINGS_SCROLLBACK.default }) }

/** Where the host saves a session's screen text. Only ever built from a marker the store holds or just made. */
export const screenFileOf = (configDir: string, marker: string) => path.join(configDir, 'screens', `${marker}.txt`)
const hookFileOf = (configDir: string, marker: string) => path.join(configDir, 'hooks', `${marker}.jsonl`)
/** Deletes a file; a missing one counts as deleted. */
const removeFile = (file: string) =>
  unlink(file).then(
    () => true,
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
  )
/** Deletes a session's hook and screen files: the log message for the ones that stayed, or none. */
async function removeFiles(configDir: string, marker: string): Promise<{ message?: string }> {
  const [hook, screen] = await Promise.all([removeFile(hookFileOf(configDir, marker)), removeFile(screenFileOf(configDir, marker))])
  const kept = [...(hook ? [] : ['hook file']), ...(screen ? [] : ['screen file'])]
  return kept.length === 0 ? {} : { message: `Couldn't delete its ${kept.join(' or ')}.` }
}

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
  const probe = () => deps.probe?.() ?? Promise.resolve(PROBE_OFF)
  const logLine = deps.logLine ?? ((line: string) => console.log(line))
  const wrapper = deps.wrapper ?? createRunWrapper({ platform: deps.platform, log: logLine })
  const settingsFile = deps.settings ?? DEFAULT_SETTINGS

  /**
   * The settings in force and this start's wrapper plan, or the refusal: `409 run wrapper: …` or `409 stop command: …`,
   * with one console line and no log entry. Reads the file now, so a change applies to the next start.
   */
  const startSettings = async (scope: ScopeProbe) => {
    const settings = await settingsFile.read()
    const plan = await wrapper.plan(settings, scope, deps.env())
    if ('error' in plan) {
      logLine(`openaflow: session start refused: ${plan.error}`)
      return { error: plan.error }
    }
    return { scrollback: settings.scrollback, plan }
  }
  /** What the record keeps of its start: the scrollback, and the stop when there is one. */
  const used = (scrollback: number, w: WrappedStart) => ({ scrollback, ...(w.stop ? { stop: w.stop } : {}) })

  /**
   * Starts `cmd` as session `marker`, wrapped as `w` says, with its screen file and scrollback. `failure` is the
   * answer and log message for a refused start (the record goes) or no answer (the record stays `starting`).
   */
  const startSession = async (
    terminals: NonNullable<SessionRouteDeps['terminals']>,
    marker: string,
    cmd: Omit<SessionCommand, 'typeYourself'>,
    size: { cols: number; rows: number },
    w: WrappedStart,
    scrollback: number,
  ): Promise<{ status: 502 | 504; error: string; message: string } | undefined> => {
    try {
      const { pid } = await terminals.start(
        { id: marker, program: w.program, args: w.args, cwd: cmd.cwd, env: cmd.env, ...size, screenFile: screenFileOf(deps.configDir, marker), scrollback },
        w.stop,
      )
      // The channel's event has done this already; a start without one (a test's fake) still lands here.
      await deps.store.started(marker, pid)
      return undefined
    } catch (err) {
      const word = err instanceof Error ? err.message : String(err)
      // No answer: the record stays `starting` until a late answer or the next start's reconcile.
      if (err instanceof NoAnswer) return { status: 504, error: 'terminals unavailable', message: 'no answer' }
      await deps.store.failed(marker)
      return { status: 502, error: `start failed: ${word}`, message: word }
    }
  }

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
    // Before the checks below: the server start began it, so this waits only for its first answer.
    const scope = await probe()
    const start = await startSettings(scope)
    if ('error' in start) return c.json({ error: start.error }, 409)

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

    const { typeYourself, ...run } = cmd
    const w = applyPlan(start.plan, run, marker)
    const record: StoredSession = {
      marker,
      repoPath: repo.path,
      sessionId,
      skill,
      startedAt: deps.now(),
      state: 'starting',
      ...(cmd.typeYourself ? { typeYourself: true as const } : {}),
      ...used(start.scrollback, w),
    }
    await deps.store.add(record)
    const base = { action: 'new-session', repoId: repo.id, repo: repo.name, target: targetOf(skill, marker) } as const
    const failure = await startSession(terminals, marker, run, { cols, rows }, w, start.scrollback)
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
    const kept = await removeFiles(deps.configDir, record.marker)
    // The host may still hold its screen; nothing else will ask for it.
    terminals.dispose(record.marker)
    const base = { action: 'dismiss-session', repoId: repo.id, repo: repo.name, target: targetOf(record.skill, record.marker) } as const
    const logged = await settle(() => deps.log.append({ ...base, result: 'dismissed', ...kept }))
    await settle(deps.rebuild)
    return c.json({ outcome: 'dismissed', logged: logged === true } satisfies DismissSessionResult)
  })

  app.post('/resume-session', async (c) => {
    const b = await body(c)
    const cols = size(b?.cols, SIZE.cols)
    const rows = size(b?.rows, SIZE.rows)
    if (!b || typeof b.repoId !== 'string' || typeof b.marker !== 'string' || cols === undefined || rows === undefined) return c.json({ error: 'bad request' }, 400)
    const terminals = deps.terminals
    if (!terminals || deps.pluginDir === undefined) return c.json({ error: 'no terminal host' }, 409)
    const repo = deps.board().repos.find((r) => r.id === b.repoId)
    // Only a marker the store holds goes on: it names the files deleted below.
    const find = (records: readonly StoredSession[]) => (repo ? records.find((r) => r.marker === b.marker && inRepo(repo, r)) : undefined)
    const first = find(deps.store.list())
    if (!repo || !first) return c.json({ error: 'no session' }, 404)

    // What the check needs from disk, read now. Every record's sessions, for `in use`; the old one's live session.
    const scope = await probe()
    const start = await startSettings(scope)
    if ('error' in start) return c.json({ error: start.error }, 409)
    const held = new Map(await Promise.all(deps.store.list().map(async (r) => [r.marker, hostedSession(r, await deps.hooks.read(r.marker)).sessions] as const)))
    const liveSession = hostedSession(first, await deps.hooks.read(first.marker)).liveSession
    const facts = await resumeFacts(repo.path, liveSession, deps.claudeDir)

    // From here to the store's add, nothing waits: a second press sees this one's record.
    const records = deps.store.list()
    const old = find(records)
    if (!old) return c.json({ error: 'no session' }, 404)
    if (isOpen(old)) return c.json({ error: 'session is live' }, 409)
    if (records.some((r) => r.state === 'starting' && inRepo(repo, r))) return c.json({ error: 'session starting' }, 409)
    const claude = deps.claude()
    if (claude === undefined) return c.json({ error: 'claude not found' }, 409)
    // A record added since the reads above holds at least its own start id.
    const open = records.filter(isOpen).map((r) => held.get(r.marker) ?? [r.sessionId])
    const resume = resumeOf(facts, liveSession, open)
    if (resume !== 'ok') return c.json({ error: `can't resume: ${resume}` }, 409)
    if (open.length >= MAX_OPEN_SESSIONS) return c.json({ error: 'too many sessions' }, 409)
    const marker = newId()
    const cmd = resumeCommand({
      claude,
      repo: repo.path,
      sessionId: liveSession,
      runMarker: marker,
      pluginDir: deps.pluginDir,
      configDir: deps.configDir,
      env: deps.env(),
      platform: deps.platform,
      windows: deps.windows,
    })
    if (typeof cmd === 'string') return c.json({ error: cmd }, 400)

    const { typeYourself: _none, ...run } = cmd
    const w = applyPlan(start.plan, run, marker)
    await deps.store.add({
      marker,
      repoPath: repo.path,
      sessionId: liveSession,
      skill: old.skill,
      startedAt: deps.now(),
      state: 'starting',
      resumedFrom: old.marker,
      ...used(start.scrollback, w),
    })
    const base = { action: 'resume-session', repoId: repo.id, repo: repo.name, target: targetOf(old.skill, marker) } as const
    const failure = await startSession(terminals, marker, run, { cols, rows }, w, start.scrollback)
    let kept: { message?: string } = {}
    if (!failure) {
      // The new session holds the conversation now: the old record, its files, and the host's copy go.
      await deps.store.remove(old.marker)
      kept = await removeFiles(deps.configDir, old.marker)
      terminals.dispose(old.marker)
    }
    const logged = await settle(() => deps.log.append(failure ? { ...base, result: 'failed', message: failure.message } : { ...base, result: 'started', ...kept }))
    await settle(deps.rebuild)
    if (failure) return c.json({ error: failure.error }, failure.status)
    return c.json({ outcome: 'started', marker, logged: logged === true } satisfies ResumeSessionResult)
  })

  return app
}
