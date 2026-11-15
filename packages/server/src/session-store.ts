// The hosted sessions the app started: `<config dir>/sessions.json`, their state changes, the reconcile at each start,
// and each one's hook state file. Only a server with a terminal channel writes the file; any server reads it.
// The shapes are sprint terminal-tab's shared contract §3; the rules and why are in
// pod-docs/feature-details/hosted-sessions.md.

import { readFileSync, statSync } from 'node:fs'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isSkillId, type HostedSession, type SkillId, type StopReason, type StoredSessionState } from '@openaflow/model'
import { readHookState, type HookState } from './hook-state.ts'
import type { SessionInfo, TerminalEvent } from './terminal-channel.ts'

export type StoredSession = {
  marker: string
  repoPath: string
  sessionId: string
  skill: SkillId
  startedAt: number
  state: StoredSessionState
  pid?: number
  endedAt?: number
  exitCode?: number
  /** Only with state `stopped`. */
  stopReason?: StopReason
  /** The start line went to the user to type; the text is never stored. */
  typeYourself?: true
  /** The marker of the session this one resumes. Only while `starting`: every change out of it drops it. */
  resumedFrom?: string
}

export type SessionsFile = { v: 1; sessions: StoredSession[] }

export type SessionStore = {
  /** The records, oldest first. A read-only store reads the file again when it changed. */
  list(): StoredSession[]
  /** Saves a new record (state `starting`). Memory changes at once; the promise settles after the write. */
  add(record: StoredSession): Promise<void>
  /** `started`: a `starting` record is `live` with its pid. */
  started(marker: string, pid: number): Promise<void>
  /** `start-failed`: a `starting` record is removed. */
  failed(marker: string): Promise<void>
  /** `exit`: a `starting` or `live` record is `ended`. */
  exited(marker: string, exitCode: number): Promise<void>
  /** `lost`: each named `starting` or `live` record is `stopped · terminals restarted`. */
  lost(ids: readonly string[]): Promise<void>
  /** Dismiss: removes the record. `false` when there was none. */
  remove(marker: string): Promise<boolean>
  /** Applies a reconcile's states to the records it names. Internal to `reconcileSessions`. */
  settle(changes: ReadonlyMap<string, Partial<StoredSession>>): Promise<void>
  /** Settles once every write asked for so far is done. */
  saved(): Promise<void>
  /** Called after each change in memory. Returns the unsubscribe. */
  onChange(fn: () => void): () => void
}

/** A run marker or session id: a lowercase UUID v4. The marker names the hook file Dismiss deletes. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STATES = new Set<unknown>(['starting', 'live', 'ended', 'stopped'] satisfies StoredSessionState[])
const REASONS = new Set<unknown>(['terminals restarted', 'app closed'] satisfies StopReason[])
/** How long the reconcile waits before it asks again after a failure other than `terminals unavailable`. */
export const RECONCILE_RETRY_MS = 30_000
const UNAVAILABLE = 'terminals unavailable'

const isOpen = (r: StoredSession) => r.state === 'starting' || r.state === 'live'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** One stored record, or `undefined` for one that breaks a rule. Unknown keys are dropped. */
function readRecord(v: unknown): StoredSession | undefined {
  if (!isRecord(v)) return undefined
  const { marker, repoPath, sessionId, skill, startedAt, state, pid, endedAt, exitCode, stopReason, typeYourself, resumedFrom } = v
  if (typeof marker !== 'string' || !UUID_V4.test(marker) || typeof sessionId !== 'string' || !UUID_V4.test(sessionId)) return undefined
  if (typeof repoPath !== 'string' || repoPath === '' || !isSkillId(skill) || !isTime(startedAt) || !STATES.has(state)) return undefined
  if (pid !== undefined && !(Number.isSafeInteger(pid) && (pid as number) > 0)) return undefined
  if ((endedAt !== undefined && !isTime(endedAt)) || (exitCode !== undefined && !Number.isInteger(exitCode))) return undefined
  if (stopReason !== undefined && (state !== 'stopped' || !REASONS.has(stopReason))) return undefined
  if (typeYourself !== undefined && typeYourself !== true) return undefined
  const out: StoredSession = { marker, repoPath, sessionId, skill, startedAt, state: state as StoredSessionState }
  if (pid !== undefined) out.pid = pid as number
  if (endedAt !== undefined) out.endedAt = endedAt
  if (exitCode !== undefined) out.exitCode = exitCode as number
  if (stopReason !== undefined) out.stopReason = stopReason as StopReason
  if (typeYourself) out.typeYourself = true
  // A bad one, or one on a record past `starting`, is dropped; the record itself is still good.
  if (state === 'starting' && typeof resumedFrom === 'string' && UUID_V4.test(resumedFrom)) out.resumedFrom = resumedFrom
  return out
}

/** `r` with no `resumedFrom`: it leaves `starting`. */
const leftStarting = ({ resumedFrom: _, ...r }: StoredSession): StoredSession => r

/** The file's records. A missing file is empty; a file that doesn't parse is empty with one log line. */
function readStore(file: string, log: (line: string) => void): StoredSession[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`openaflow: could not read ${path.basename(file)}; no hosted sessions are listed`)
    return []
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  if (!isRecord(data) || data.v !== 1 || !Array.isArray(data.sessions)) {
    log(`openaflow: ${path.basename(file)} is unreadable; no hosted sessions are listed until the next change`)
    return []
  }
  const out: StoredSession[] = []
  for (const raw of data.sessions) {
    const r = readRecord(raw)
    if (r && !out.some((o) => o.marker === r.marker)) out.push(r)
  }
  return out
}

/** The file's size and change time, or `''` when it is missing. */
function fileStamp(file: string): string {
  try {
    const s = statSync(file)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return ''
  }
}

export function createSessionStore(o: { file: string; writable: boolean; now: () => number; log: (line: string) => void }): SessionStore {
  let records = readStore(o.file, o.log)
  let readStamp = o.writable ? '' : fileStamp(o.file)
  const listeners = new Set<() => void>()
  let writes: Promise<void> = Promise.resolve()
  let tempCount = 0

  /** Writes the whole store to a temp file, then renames it over the real one. One write at a time, in order. */
  const save = (): Promise<void> => {
    const body: SessionsFile = { v: 1, sessions: records }
    const text = JSON.stringify(body, null, 2) + '\n'
    writes = writes.then(async () => {
      const temp = `${o.file}.${process.pid}.${++tempCount}.tmp`
      try {
        await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
        await rename(temp, o.file)
      } catch (err) {
        o.log(`openaflow: could not save ${path.basename(o.file)}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`)
        await unlink(temp).catch(() => {})
      }
    })
    return writes
  }

  /** Swaps in the new list, tells listeners, and saves. A read-only store changes nothing. */
  const commit = (next: StoredSession[]): Promise<void> => {
    if (!o.writable) return Promise.resolve()
    records = next
    for (const fn of [...listeners]) fn()
    return save()
  }

  /** Changes one record when `when` holds for it; an unknown marker changes nothing. */
  const change = (marker: string, when: (r: StoredSession) => boolean, to: (r: StoredSession) => StoredSession | undefined): Promise<void> => {
    const i = records.findIndex((r) => r.marker === marker)
    if (i < 0 || !when(records[i]!)) return Promise.resolve()
    const next = to(records[i]!)
    return commit(next ? records.map((r, j) => (j === i ? next : r)) : records.filter((_, j) => j !== i))
  }

  return {
    list() {
      if (!o.writable) {
        const stamp = fileStamp(o.file)
        if (stamp !== readStamp) {
          readStamp = stamp
          records = readStore(o.file, o.log)
        }
      }
      return records
    },
    add: (record) => commit([...records.filter((r) => r.marker !== record.marker), record]),
    started: (marker, pid) => change(marker, (r) => r.state === 'starting', (r) => ({ ...leftStarting(r), state: 'live', pid })),
    failed: (marker) => change(marker, (r) => r.state === 'starting', () => undefined),
    exited: (marker, exitCode) => change(marker, isOpen, (r) => ({ ...leftStarting(r), state: 'ended', exitCode, endedAt: o.now() })),
    lost(ids) {
      const named = new Set(ids)
      if (!records.some((r) => named.has(r.marker) && isOpen(r))) return Promise.resolve()
      const at = o.now()
      return commit(records.map((r) => (named.has(r.marker) && isOpen(r) ? { ...leftStarting(r), state: 'stopped', stopReason: 'terminals restarted', endedAt: at } : r)))
    },
    async remove(marker) {
      if (!records.some((r) => r.marker === marker)) return false
      await commit(records.filter((r) => r.marker !== marker))
      return o.writable
    },
    settle(changes) {
      if (changes.size === 0) return Promise.resolve()
      // Each reconcile change moves its record to `live`, `ended`, or `stopped`: out of `starting`.
      return commit(records.map((r) => (changes.has(r.marker) ? { ...leftStarting(r), ...changes.get(r.marker) } : r)))
    },
    saved: () => writes,
    onChange(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
  }
}

/** Applies the channel's events to the store. Returns the unsubscribe. */
export function followChannel(store: SessionStore, channel: { onEvent(fn: (e: TerminalEvent) => void): () => void }): () => void {
  return channel.onEvent((e) => {
    if (e.op === 'started') void store.started(e.id, e.pid)
    else if (e.op === 'start-failed') void store.failed(e.id)
    else if (e.op === 'exit') void store.exited(e.id, e.exitCode)
    else void store.lost(e.ids)
  })
}

/**
 * At a start with a terminal channel: asks the host which sessions it holds, and settles the `starting` and `live`
 * records there were when it asked. A record that changed meanwhile, or one added since, is left alone. `terminals
 * unavailable` stops them; any other failure asks once more `retryMs` later, then changes nothing.
 * Answers the markers it set to `stopped · app closed`, oldest first: main sweeps what they left behind.
 */
export async function reconcileSessions(
  store: SessionStore,
  o: { list(): Promise<SessionInfo[]>; retryMs?: number; wait?: (ms: number) => Promise<void> },
): Promise<string[]> {
  const asked = new Map(store.list().filter(isOpen).map((r) => [r.marker, r.state]))
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()))
  for (let attempt = 1; attempt <= 2; attempt++) {
    let listed: SessionInfo[] | undefined
    let error = ''
    try {
      listed = await o.list()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    if (listed === undefined && error !== UNAVAILABLE) {
      if (attempt === 1) await wait(o.retryMs ?? RECONCILE_RETRY_MS)
      continue
    }
    const changes = new Map<string, Partial<StoredSession>>()
    for (const r of store.list()) {
      if (asked.get(r.marker) !== r.state) continue
      if (listed === undefined) {
        changes.set(r.marker, { state: 'stopped', stopReason: 'terminals restarted' })
        continue
      }
      const info = listed.find((s) => s.id === r.marker)
      if (!info) changes.set(r.marker, { state: 'stopped', stopReason: 'app closed' })
      else if (info.live) changes.set(r.marker, { state: 'live', pid: info.pid })
      else changes.set(r.marker, { state: 'ended' })
    }
    await store.settle(changes)
    return [...changes].filter(([, c]) => c.stopReason === 'app closed').map(([marker]) => marker)
  }
  return []
}

/** Reads `<hooks dir>/<marker>.jsonl` with `readHookState`, again only when its size or change time differs. */
export function createHookReader(dir: string, o: { readText?(file: string): Promise<string> } = {}) {
  const readText = o.readText ?? ((file: string) => readFile(file, 'utf8'))
  const cache = new Map<string, { stamp: string; state: HookState }>()
  return {
    async read(marker: string): Promise<HookState | undefined> {
      if (!UUID_V4.test(marker)) return undefined
      const file = path.join(dir, `${marker}.jsonl`)
      let stamp: string
      try {
        const s = await stat(file)
        stamp = `${s.size}:${s.mtimeMs}`
      } catch {
        cache.delete(marker)
        return undefined
      }
      const hit = cache.get(marker)
      if (hit?.stamp === stamp) return hit.state
      try {
        const state = readHookState(await readText(file))
        cache.set(marker, { stamp, state })
        return state
      } catch {
        cache.delete(marker)
        return undefined
      }
    },
    /** Forgets every marker not in the list. */
    retain(markers: readonly string[]) {
      const keep = new Set(markers)
      for (const m of cache.keys()) if (!keep.has(m)) cache.delete(m)
    },
  }
}

export type HookReader = ReturnType<typeof createHookReader>

/** A stored record and its hook state as the Board's `HostedSession`. Hook events give ids only, never text. */
export function hostedSession(r: StoredSession, hook: HookState | undefined): HostedSession {
  const starts = (hook?.events ?? []).filter((e) => e.event === 'SessionStart' && e.session !== '')
  const sessions = [r.sessionId]
  for (const e of starts) if (!sessions.includes(e.session)) sessions.push(e.session)
  const out: HostedSession = {
    marker: r.marker,
    sessionId: r.sessionId,
    liveSession: hook?.live?.session ?? r.sessionId,
    sessions,
    skill: r.skill,
    startedAt: r.startedAt,
    state: r.state,
    hooked: starts.length > 0,
    prompted: (hook?.events ?? []).some((e) => e.event === 'UserPromptSubmit'),
  }
  if (r.stopReason !== undefined) out.stopReason = r.stopReason
  if (r.endedAt !== undefined) out.endedAt = r.endedAt
  if (r.exitCode !== undefined) out.exitCode = r.exitCode
  if (r.typeYourself) out.typeYourself = true
  return out
}
