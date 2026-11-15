// Ends a hosted session's processes at quit and on leftovers. Linux: the stop command, a /proc snapshot, then
// SIGHUP, SIGTERM, SIGKILL. Windows: the session's Job Object, then `taskkill /T /F`. The rules are in
// pod-docs/sprints/session-life.md (§7). OS calls are injected; `realEnderOs()` holds the real ones. No `electron`
// import: D2 wires it in.

import { spawn } from 'node:child_process'
import { procReader, readStat, snapshot, type ProcReader, type Snapshot } from './proc-scan.ts'

/** J1 builds it (windows-jobs.ts); the same shape is declared here so this slice stands alone. */
export type JobControl = { assign(id: string, pid: number): Promise<boolean>; close(id: string): Promise<void>; dispose(): void }

export const STOP_LIMIT_MS = 6_000
export const HUP_WAIT_MS = 3_000
export const TERM_WAIT_MS = 3_000
export const LEFT_CHECK_MS = 500
/** Windows: the most `end` waits for the job and for taskkill. */
export const WINDOWS_WAIT_MS = 3_000
export const POLL_MS = 100

export type Signal = 'SIGHUP' | 'SIGTERM' | 'SIGKILL'

export type EnderOs = {
  proc: ProcReader
  /** As `process.kill`: a negative pid signals that process group. It may throw. */
  kill(pid: number, signal: Signal): void
  /** Runs the argv with no shell. Resolves on exit 0; rejects with the reason otherwise; kills it at `limitMs`. */
  runStop(argv: string[], limitMs: number): Promise<void>
  /** Windows: `taskkill /T /F /PID <pid>`, hidden. */
  taskkill(pid: number): Promise<void>
  /** Windows: the pid still runs. */
  alive(pid: number): boolean
}

export type SessionEnder = {
  /** A session with a pty: `pid` is its program, or 0 while the host waits for it. Never rejects. */
  end(id: string, pid: number, stop?: string[]): Promise<void>
  /** A session with no live pty. Never rejects. */
  sweep(id: string, stop?: string[]): Promise<void>
}

export type EnderOptions = {
  platform: NodeJS.Platform
  os: EnderOs
  /** Windows only. */
  jobs?: JobControl
  /** The host's and the server's pids, read at each end. Main and its parent are always kept. */
  protectedPids(): Array<number | undefined>
  log(line: string): void
  wait?(ms: number): Promise<void>
}

const short = (id: string) => id.slice(0, 8)
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function createSessionEnder(o: EnderOptions): SessionEnder {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const { proc } = o.os
  const prefix = (id: string) => `openaflow desktop: session ${short(id)}`

  /** Pids no signal may reach. Read at each end: the host and the server can restart. */
  const keep = () => {
    const out = new Set<number>([process.pid, process.ppid])
    for (const pid of o.protectedPids()) if (pid !== undefined && pid > 0) out.add(pid)
    return out
  }
  const fine = (pid: number, kept: Set<number>) => Number.isInteger(pid) && pid > 1 && !kept.has(pid)

  /** The snapshot entries that still run with the same start time. */
  const survivors = (snap: Snapshot) => [...snap].filter(([pid, start]) => readStat(proc, pid)?.startTime === start).map(([pid]) => pid)

  /** ESRCH: already gone. EPERM and the rest: it stays a survivor. */
  const send = (pid: number, sig: Signal) => {
    try {
      o.os.kill(pid, sig)
    } catch {
      // See above.
    }
  }

  /** One process of the snapshot, only while it runs with the snapshot's start time. */
  const signalOne = (pid: number, sig: Signal, snap: Snapshot, kept: Set<number>) => {
    if (!fine(pid, kept) || !snap.has(pid)) return
    if (readStat(proc, pid)?.startTime !== snap.get(pid)) return
    send(pid, sig)
  }

  /**
   * The root's group, only when it is still the session's: a live snapshot member leads or sits in it, and no
   * kept process (main, its parent, the host, the server) is in it. Else nothing; the caller signals one by one.
   */
  const signalGroup = (pgid: number, sig: Signal, snap: Snapshot, kept: Set<number>) => {
    if (!fine(pgid, kept)) return false
    let ours = false
    for (const pid of proc.pids()) {
      const s = readStat(proc, pid)
      if (!s || s.pgid !== pgid) continue
      if (kept.has(pid) || pid <= 1) return false
      if (snap.get(pid) === s.startTime) ours = true
    }
    if (!ours) return false
    send(-pgid, sig)
    return true
  }

  /** Polls until every snapshot entry is gone; at most `ms`. Answers the survivors. */
  const waitGone = async (snap: Snapshot, ms: number) => {
    const until = Date.now() + ms
    for (;;) {
      const left = survivors(snap)
      if (left.length === 0 || Date.now() >= until) return left
      await wait(Math.min(POLL_MS, until - Date.now()))
    }
  }

  const runStop = (id: string, stop: string[] | undefined) => {
    if (!stop || stop.length === 0) return Promise.resolve()
    let run: Promise<void>
    try {
      run = o.os.runStop(stop, STOP_LIMIT_MS)
    } catch (err) {
      run = Promise.reject(err)
    }
    return run.catch((err) => o.log(`${prefix(id)} stop command failed: ${reason(err)}`))
  }

  /** Linux steps 1–6; `pid` 0 skips the tree and SIGHUP. */
  const linux = async (id: string, pid: number, stop: string[] | undefined) => {
    // Step 1 runs beside the signals: 6 s for it and 3 + 3 + 0.5 s for them fit in about 7 s.
    const stopped = runStop(id, stop)
    const kept = keep()
    const snap = snapshot(proc, { pid: fine(pid, kept) ? pid : 0, marker: id })
    for (const k of kept) snap.delete(k)
    snap.delete(1)
    const rootStat = snap.has(pid) ? readStat(proc, pid) : null
    /** The root leads its own group: that group is the session's terminal group. */
    const group = rootStat && rootStat.pgid === pid && pid !== readStat(proc, process.pid)?.pgid ? pid : 0
    let left = survivors(snap)
    if (rootStat && left.length > 0) {
      if (!(group && signalGroup(group, 'SIGHUP', snap, kept))) signalOne(pid, 'SIGHUP', snap, kept)
      left = await waitGone(snap, HUP_WAIT_MS)
    }
    if (left.length > 0) {
      if (group) signalGroup(group, 'SIGTERM', snap, kept)
      for (const p of left) signalOne(p, 'SIGTERM', snap, kept)
      left = await waitGone(snap, TERM_WAIT_MS)
    }
    if (left.length > 0) {
      for (const p of left) signalOne(p, 'SIGKILL', snap, kept)
      left = await waitGone(snap, LEFT_CHECK_MS)
      if (left.length > 0) o.log(`${prefix(id)} left ${left.length} processes`)
    }
    await stopped
  }

  const closeJob = async (id: string) => {
    if (!o.jobs) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([o.jobs.close(id), new Promise<void>((r) => (timer = setTimeout(r, WINDOWS_WAIT_MS)))])
    } catch (err) {
      o.log(`${prefix(id)} job close failed: ${reason(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Windows: the job first, then the tree by taskkill; no env reads. */
  const windows = async (id: string, pid: number) => {
    await closeJob(id)
    if (!fine(pid, keep())) return
    const until = Date.now() + WINDOWS_WAIT_MS
    void o.os.taskkill(pid).catch(() => {})
    while (o.os.alive(pid) && Date.now() < until) await wait(Math.min(POLL_MS, until - Date.now()))
    if (o.os.alive(pid)) o.log(`${prefix(id)} left 1 processes`)
  }

  const guard = async (id: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (err) {
      o.log(`${prefix(id)} end failed: ${reason(err)}`)
    }
  }

  return {
    end: (id, pid, stop) => guard(id, () => (o.platform === 'win32' ? windows(id, pid) : linux(id, pid, stop))),
    sweep: (id, stop) => guard(id, () => (o.platform === 'win32' ? windows(id, 0) : linux(id, 0, stop))),
  }
}

export function realEnderOs(): EnderOs {
  return {
    proc: procReader(),
    kill: (pid, signal) => void process.kill(pid, signal),
    runStop: (argv, limitMs) =>
      new Promise((resolve, reject) => {
        const [program, ...args] = argv
        if (!program) return reject(new Error('no program'))
        const child = spawn(program, args, { shell: false, stdio: 'ignore', windowsHide: true })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`no exit in ${limitMs / 1000} s`))
        }, limitMs)
        child.once('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(signal ? `ended by ${signal}` : `exit ${code}`))
        })
      }),
    taskkill: (pid) =>
      new Promise((resolve) => {
        const child = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { shell: false, stdio: 'ignore', windowsHide: true })
        child.once('error', () => resolve())
        child.once('exit', () => resolve())
      }),
    alive(pid) {
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
  }
}
