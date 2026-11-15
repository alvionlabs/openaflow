// The sessions main started in this app life, and the ends at quit and on leftovers. The rules are in
// pod-docs/sprints/session-life.md (§3, §7). No `electron` import: D2 feeds it from the relay and the starter.

import type { JobControl, SessionEnder } from './session-ender.ts'

/** The most `endAll` waits for the host's `flushed`. */
export const FLUSH_LIMIT_MS = 2_000

export type RosterState = 'starting' | 'live' | 'ended'
export type RosterSession = { id: string; pid: number; stop?: string[]; label?: string; state: RosterState }

export type SessionRoster = {
  /** The relay sent the host a start. The pid is 0 until `started`. */
  starting(id: string, stop?: string[]): void
  /** The host's `started`. On Windows it assigns the session's job. */
  started(id: string, pid: number): void
  /** The host's `exit`, or a `start-failed`. It stays for the sweep at `endAll`. */
  ended(id: string): void
  /** The server's newest `labels` list; it replaces the last one. */
  setLabels(labels: { id: string; label: string }[]): void
  /** Every session of this app life, in start order. */
  sessions(): RosterSession[]
  /** The sessions a quit asks about: live, or waiting for their pid. */
  live(): RosterSession[]
  /** Flush (2 s at most), then end each live one and sweep each ended one, all at once. Never rejects. */
  endAll(): Promise<void>
  /** The host crashed with these live: sweep each, once. */
  lost(ids: string[]): Promise<void>
  /** The server's `sweep`: skips live and pid-waiting ids, and ids swept already. */
  sweep(sessions: { id: string; stop?: string[] }[]): Promise<void>
}

export type RosterOptions = {
  platform: NodeJS.Platform
  ender: SessionEnder
  /** Windows only; ignored elsewhere. */
  jobs?: JobControl
  /** The host's `flush`. */
  flush(): Promise<unknown>
  log(line: string): void
}

type Entry = { id: string; pid: number; stop?: string[]; state: RosterState }

export function createSessionRoster(o: RosterOptions): SessionRoster {
  const entries = new Map<string, Entry>()
  let labels = new Map<string, string>()
  /** Ids already ended or swept here, so none is taken twice. */
  const taken = new Set<string>()
  let ending: Promise<void> | undefined

  const prefix = (id: string) => `openaflow desktop: session ${id.slice(0, 8)}`
  const view = (e: Entry): RosterSession => ({ ...e, ...(labels.has(e.id) ? { label: labels.get(e.id) } : {}) })
  const held = (e: Entry | undefined) => e !== undefined && e.state !== 'ended'
  /** The ender never rejects; this keeps a broken one from rejecting a quit. */
  const settle = (p: Promise<void>) => p.catch((err) => o.log(`openaflow desktop: session end failed: ${String(err)}`))

  const take = (id: string, run: () => Promise<void>) => {
    taken.add(id)
    const e = entries.get(id)
    if (e) e.state = 'ended'
    return settle(Promise.resolve().then(run))
  }

  const flushed = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.resolve().then(o.flush), new Promise<void>((r) => (timer = setTimeout(r, FLUSH_LIMIT_MS)))])
    } catch {
      // A host that can't flush: the screens stay as last saved.
    } finally {
      clearTimeout(timer)
    }
  }

  const endAllOnce = async () => {
    await flushed()
    const runs: Promise<void>[] = []
    for (const e of entries.values()) {
      if (taken.has(e.id)) continue
      const { id, pid, stop, state } = e
      runs.push(take(id, () => (state === 'ended' ? o.ender.sweep(id, stop) : o.ender.end(id, state === 'live' ? pid : 0, stop))))
    }
    await Promise.all(runs)
  }

  return {
    starting(id, stop) {
      if (entries.has(id)) return
      entries.set(id, { id, pid: 0, ...(stop ? { stop } : {}), state: 'starting' })
    },
    started(id, pid) {
      const e = entries.get(id) ?? { id, pid: 0, state: 'starting' as RosterState }
      entries.set(id, e)
      if (taken.has(id)) return
      e.pid = pid
      e.state = 'live'
      const jobs = o.platform === 'win32' ? o.jobs : undefined
      if (!jobs) return
      const noJob = () => o.log(`${prefix(id)} has no job; quit ends it by taskkill only`)
      Promise.resolve()
        .then(() => jobs.assign(id, pid))
        .then((ok) => ok || noJob(), noJob)
    },
    ended(id) {
      const e = entries.get(id)
      if (e) e.state = 'ended'
    },
    setLabels(list) {
      labels = new Map(list.map((l) => [l.id, l.label]))
    },
    sessions: () => [...entries.values()].map(view),
    live: () => [...entries.values()].filter((e) => held(e)).map(view),
    endAll() {
      if (ending) return ending
      ending = endAllOnce().finally(() => (ending = undefined))
      return ending
    },
    async lost(ids) {
      const runs = [...new Set(ids)].filter((id) => !taken.has(id)).map((id) => take(id, () => o.ender.sweep(id, entries.get(id)?.stop)))
      await Promise.all(runs)
    },
    async sweep(list) {
      const runs = list
        .filter((s) => !held(entries.get(s.id)) && !taken.has(s.id))
        .map((s) => take(s.id, () => o.ender.sweep(s.id, s.stop ?? entries.get(s.id)?.stop)))
      await Promise.all(runs)
    },
  }
}
