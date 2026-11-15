// Reads Linux's /proc for the session ender (session-ender.ts): one process's stat line, and the snapshot of a
// session's processes. The rules are in pod-docs/sprints/session-life.md (§7). No `electron` import.

import { readdirSync, readFileSync } from 'node:fs'

/** The env variable that marks every process of a hosted session (host-core §3). */
export const RUN_ENV = 'OPENAFLOW_RUN'
/** A run marker as the host accepts it. Anything else matches no process. */
export const MARKER_RE = /^[a-z0-9-]{1,64}$/

export type ProcStat = { pid: number; ppid: number; pgid: number; state: string; startTime: string }

/** Raw reads of /proc. Each read answers null when the entry is gone or unreadable. */
export type ProcReader = {
  pids(): number[]
  stat(pid: number): string | null
  environ(pid: number): string | null
}

/** pid → start time (field 22 of its stat line). */
export type Snapshot = Map<number, string>

/** Splits after the last `)`, since the program name may hold spaces and brackets. */
export function parseStat(text: string): ProcStat | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const pid = Number(text.slice(0, text.indexOf(' ')))
  const f = text.slice(close + 2).trim().split(' ')
  // After the name: state (field 3), ppid, pgrp, … start time (field 22).
  const [state, ppid, pgid, startTime] = [f[0], Number(f[1]), Number(f[2]), f[19]]
  if (!Number.isInteger(pid) || pid <= 0 || !state || !Number.isInteger(ppid) || !Number.isInteger(pgid)) return null
  if (!startTime || !/^[0-9]+$/.test(startTime)) return null
  return { pid, ppid, pgid, state, startTime }
}

/** True when one whole NUL-separated entry is `OPENAFLOW_RUN=<marker>`. A bad marker matches nothing. */
export function holdsMarker(environ: string, marker: string): boolean {
  if (!MARKER_RE.test(marker)) return false
  return environ.split('\0').includes(`${RUN_ENV}=${marker}`)
}

/** The process's stat, or null when it's gone, unreadable, or a zombie (it has ended; only its entry waits). */
export function readStat(r: ProcReader, pid: number): ProcStat | null {
  const text = r.stat(pid)
  const s = text === null ? null : parseStat(text)
  return s && s.state !== 'Z' ? s : null
}

/**
 * The session's processes: the root pid's group (when the root leads it) and its descendants, plus every process
 * whose env holds the marker. The root counts only while its own env holds the marker; otherwise, or with pid 0,
 * the marker alone decides. Unreadable entries are skipped.
 */
export function snapshot(r: ProcReader, o: { pid: number; marker: string }): Snapshot {
  const out: Snapshot = new Map()
  if (!MARKER_RE.test(o.marker)) return out
  const stats: ProcStat[] = []
  for (const pid of r.pids()) {
    const s = readStat(r, pid)
    if (s) stats.push(s)
  }
  const marks = (pid: number) => {
    const env = r.environ(pid)
    return env !== null && holdsMarker(env, o.marker)
  }
  for (const s of stats) if (marks(s.pid)) out.set(s.pid, s.startTime)
  const root = o.pid > 1 ? stats.find((s) => s.pid === o.pid) : undefined
  if (!root || !out.has(root.pid)) return out
  const tree = new Set<number>([root.pid])
  if (root.pgid === root.pid) for (const s of stats) if (s.pgid === root.pid) tree.add(s.pid)
  // Descendants of the root and of its group, by parent pid, until nothing new turns up.
  for (let grew = true; grew; ) {
    grew = false
    for (const s of stats) {
      if (!tree.has(s.pid) && tree.has(s.ppid)) {
        tree.add(s.pid)
        grew = true
      }
    }
  }
  for (const s of stats) if (tree.has(s.pid)) out.set(s.pid, s.startTime)
  return out
}

export function procReader(root = '/proc'): ProcReader {
  const read = (path: string) => {
    try {
      return readFileSync(path, 'latin1')
    } catch {
      return null
    }
  }
  return {
    pids() {
      try {
        return readdirSync(root)
          .filter((n) => /^[0-9]+$/.test(n))
          .map(Number)
      } catch {
        return []
      }
    },
    stat: (pid) => read(`${root}/${pid}/stat`),
    environ: (pid) => read(`${root}/${pid}/environ`),
  }
}
