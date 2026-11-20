// Runs the pty host process: fork, ready, heartbeat, restarts, stop, and the main side of its messages. No
// `electron` import: pty-host-main.ts is the glue. The rules are in pod-docs/sprints/host-core.md (§4) and
// pod-docs/feature-details/desktop.md (Terminal host).

import type { HostToMain, SessionInfo, StartSpec } from '@openaflow/pty-host/protocol'
import { FLUSH_WAIT_MS } from '@openaflow/pty-host/protocol'
import { hostLogLine } from './pty-host-launch.ts'

export { FLUSH_WAIT_MS }

export const READY_LIMIT_MS = 20_000
/** A log line when no beat came for this long; the host beats every 5 s. */
export const BEAT_LOG_MS = 6_000
export const UNRESPONSIVE_MS = 11_000
export const STOP_KILL_MS = 3_000
/** Restarts in the app's life. They never come back. */
export const MAX_RESTARTS = 5

export type HostProcess = {
  pid: number | undefined
  postMessage(m: unknown, transfer?: unknown[]): void
  kill(): boolean // this process only
  onMessage(fn: (m: unknown) => void): void
  onExit(fn: (code: number) => void): void
}

export type StarterEvent =
  /** `restarted`: an earlier host was ready, so a window may hold a dead port. */
  | { type: 'ready'; restarted: boolean }
  | { type: 'unresponsive' }
  | { type: 'responsive' }
  /** The host ended outside a stop. `lost`: the sessions that were live in it. */
  | { type: 'crashed'; lost: string[]; restartsLeft: number }
  | { type: 'failed' }
  /** A session ended: once per id, and only for one that was live. */
  | { type: 'exit'; id: string; exitCode: number }

export type StarterState = 'idle' | 'starting' | 'ready' | 'unresponsive' | 'failed' | 'stopped'
export type StopResult = 'stopped' | 'killed' | 'not running'

export type PtyHostStarter = {
  /** Forks the first host. Once; never after a stop. */
  start(): void
  /** Sends `shutdown`, kills after 3 s, and never restarts. */
  stop(): Promise<StopResult>
  state(): StarterState
  onEvent(fn: (e: StarterEvent) => void): () => void
  /** Waits for a ready host, across restarts. After `failed` or a stop: `terminals unavailable`. */
  startSession(spec: StartSpec): Promise<{ pid: number }>
  snapshot(id: string): Promise<string | null>
  list(): Promise<SessionInfo[]>
  /** Resolves once sent; the `exit` follows. */
  kill(id: string): Promise<void>
  /** Removes the session from a ready host, with no `exit`. With no ready host, nothing: no host holds it. */
  dispose(id: string): void
  /** Hands a window's port to the ready host. False when no host is ready. */
  connect(port: unknown): boolean
  /** The ids between `started` and `exit`, in start order. */
  live(): string[]
  /** Asks a ready host to save every screen file. Resolves at `flushed`, after FLUSH_WAIT_MS, or when no host can answer. Never rejects. */
  flush(): Promise<void>
  /** The ids main holds: live, or with a start sent and no answer yet (waiting for their pid). */
  held(): string[]
  pid(): number | undefined
}

const UNAVAILABLE = 'terminals unavailable'
const EXITED = 'terminal host exited'
const LOG = 'openaflow desktop: terminal host'

type Waiter<T> = { resolve(value: T): void; reject(err: Error): void }

const isRecord = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null
/** A session that waits for its pid is listed with pid 0. */
const isSession = (s: unknown): s is SessionInfo =>
  isRecord(s) && typeof s.id === 'string' && typeof s.pid === 'number' && typeof s.live === 'boolean' && typeof s.startedAt === 'number'

/** One forked host and what waits on its answers. */
type Run = {
  proc: HostProcess
  ready: boolean
  starts: Map<string, Waiter<{ pid: number }>[]>
  snapshots: Map<string, Waiter<string | null>[]>
  lists: Waiter<SessionInfo[]>[]
}

export function createPtyHostStarter(o: { fork(): HostProcess; log(line: string): void }): PtyHostStarter {
  const listeners = new Set<(e: StarterEvent) => void>()
  let state: StarterState = 'idle'
  let run: Run | undefined
  let restartsLeft = MAX_RESTARTS
  let everReady = false
  const live: string[] = []
  /** Starts asked for and not answered yet, by id: the count of calls. */
  const starting = new Map<string, number>()
  /** Flushes that wait for `flushed`. Each ends at the answer, its own time limit, a crash, or the stop. */
  const flushes = new Set<() => void>()
  const endFlushes = () => {
    for (const done of [...flushes]) done()
  }
  /** Requests that wait for a ready host. Each posts and registers its answer on the run it gets. */
  let waiting: { send(r: Run): void; reject(err: Error): void }[] = []
  let stopping: Promise<StopResult> | undefined
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let beatLogTimer: ReturnType<typeof setTimeout> | undefined
  let unresponsiveTimer: ReturnType<typeof setTimeout> | undefined

  const emit = (e: StarterEvent) => {
    for (const fn of [...listeners]) fn(e)
  }
  const clearTimers = () => {
    clearTimeout(readyTimer)
    clearTimeout(beatLogTimer)
    clearTimeout(unresponsiveTimer)
  }
  const kill = (p: HostProcess) => {
    try {
      p.kill()
    } catch {
      // Already gone.
    }
  }
  const post = (r: Run, m: unknown, transfer?: unknown[]) => {
    try {
      r.proc.postMessage(m, transfer)
    } catch {
      // A closed channel: the exit follows.
    }
  }

  /** Rejects what the run's host was asked and will never answer. */
  const dropAnswers = (r: Run, error: string) => {
    for (const map of [r.starts, r.snapshots] as Map<string, Waiter<never>[]>[]) {
      for (const queue of map.values()) for (const w of queue) w.reject(new Error(error))
      map.clear()
    }
    for (const w of r.lists.splice(0)) w.reject(new Error(error))
  }
  /** Takes an id out of the live set; true if it was there. */
  const leave = (id: string) => {
    const at = live.indexOf(id)
    if (at < 0) return false
    live.splice(at, 1)
    return true
  }
  const dropWaiting = () => {
    for (const w of waiting.splice(0)) w.reject(new Error(UNAVAILABLE))
  }

  const armBeat = () => {
    clearTimeout(beatLogTimer)
    clearTimeout(unresponsiveTimer)
    beatLogTimer = setTimeout(() => o.log(`${LOG} sent no beat for ${BEAT_LOG_MS / 1000} s`), BEAT_LOG_MS)
    unresponsiveTimer = setTimeout(() => {
      state = 'unresponsive'
      emit({ type: 'unresponsive' })
    }, UNRESPONSIVE_MS)
  }

  /** The current host is gone outside a stop: a restart if one is left, else `failed`. */
  const crash = () => {
    const r = run
    clearTimers()
    run = undefined
    if (r) dropAnswers(r, EXITED)
    endFlushes()
    const lost = live.splice(0)
    o.log(`${LOG} lost sessions: ${lost.length === 0 ? 'none' : lost.join(', ')}`)
    if (restartsLeft === 0) {
      emit({ type: 'crashed', lost, restartsLeft: 0 })
      state = 'failed'
      dropWaiting()
      o.log(`${LOG} failed for good: terminals are unavailable until the app restarts`)
      emit({ type: 'failed' })
      return
    }
    restartsLeft--
    o.log(`${LOG} restarting (${restartsLeft} ${restartsLeft === 1 ? 'restart' : 'restarts'} left)`)
    emit({ type: 'crashed', lost, restartsLeft })
    launch()
  }

  const onMessage = (r: Run, m: unknown) => {
    const line = hostLogLine(m)
    if (line !== undefined) o.log(line)
    // During a stop only the exit counts: a beat or a late ready must not report a host that is going away.
    if (run !== r || stopping || !isRecord(m)) return
    if (m.type === 'ready' && !r.ready) {
      r.ready = true
      clearTimeout(readyTimer)
      state = 'ready'
      armBeat()
      const restarted = everReady
      everReady = true
      emit({ type: 'ready', restarted })
      for (const w of waiting.splice(0)) w.send(r)
      return
    }
    if (!r.ready) return
    if (m.type === 'beat') {
      armBeat()
      if (state === 'unresponsive') {
        state = 'ready'
        emit({ type: 'responsive' })
      }
    } else if (m.type === 'started' && typeof m.id === 'string' && typeof m.pid === 'number') {
      if (!live.includes(m.id)) live.push(m.id)
      take(r.starts, m.id)?.resolve({ pid: m.pid })
    } else if (m.type === 'start-failed' && typeof m.id === 'string') {
      take(r.starts, m.id)?.reject(new Error(typeof m.error === 'string' ? m.error : 'start failed'))
    } else if (m.type === 'exit' && typeof m.id === 'string' && typeof m.exitCode === 'number') {
      // Only an id that leaves the live set reports, so each exit reaches the listeners once.
      if (leave(m.id)) emit({ type: 'exit', id: m.id, exitCode: m.exitCode })
    } else if (m.type === 'flushed') {
      endFlushes()
    } else if (m.type === 'snapshot' && typeof m.id === 'string' && (m.text === null || typeof m.text === 'string')) {
      take(r.snapshots, m.id)?.resolve(m.text)
    } else if (m.type === 'list' && Array.isArray(m.sessions) && m.sessions.every(isSession)) {
      r.lists.shift()?.resolve((m as Extract<HostToMain, { type: 'list' }>).sessions)
    }
  }

  function launch() {
    state = 'starting'
    let proc: HostProcess
    try {
      proc = o.fork()
    } catch (err) {
      o.log(`${LOG} could not start: ${err instanceof Error ? err.message : String(err)}`)
      crash()
      return
    }
    const r: Run = { proc, ready: false, starts: new Map(), snapshots: new Map(), lists: [] }
    run = r
    proc.onMessage((m) => onMessage(r, m))
    proc.onExit((code) => {
      o.log(`${LOG} exited with code ${code}`)
      if (run !== r) return
      if (stopping) onStopExit?.()
      else crash()
    })
    readyTimer = setTimeout(() => {
      o.log(`${LOG} sent no ready in ${READY_LIMIT_MS / 1000} s, so it is killed`)
      kill(proc)
      crash()
    }, READY_LIMIT_MS)
  }

  let onStopExit: (() => void) | undefined
  const runStop = (r: Run): Promise<StopResult> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        run = undefined
        kill(r.proc)
        resolve('killed')
      }, STOP_KILL_MS)
      onStopExit = () => {
        clearTimeout(timer)
        run = undefined
        resolve('stopped')
      }
      post(r, { type: 'shutdown' })
    })

  /** Sends now on a ready host, else when one is ready. */
  const request = <T,>(send: (r: Run, w: Waiter<T>) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (state === 'failed' || state === 'stopped') return reject(new Error(UNAVAILABLE))
      const w = { resolve, reject }
      if (run?.ready) send(run, w)
      else waiting.push({ send: (r) => send(r, w), reject })
    })
  const queued = <T,>(map: Map<string, Waiter<T>[]>, id: string, w: Waiter<T>) => map.set(id, [...(map.get(id) ?? []), w])

  return {
    start() {
      if (state !== 'idle') return
      launch()
    },
    stop() {
      if (stopping) return stopping
      const r = run
      clearTimers()
      state = 'stopped'
      dropWaiting()
      if (r) dropAnswers(r, UNAVAILABLE)
      endFlushes()
      live.splice(0)
      stopping = r ? runStop(r) : Promise.resolve('not running')
      return stopping
    },
    state: () => state,
    onEvent(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    startSession(spec) {
      const { id } = spec
      starting.set(id, (starting.get(id) ?? 0) + 1)
      const answered = () => {
        const n = (starting.get(id) ?? 1) - 1
        if (n > 0) starting.set(id, n)
        else starting.delete(id)
      }
      const p = request<{ pid: number }>((r, w) => {
        queued(r.starts, id, w)
        post(r, { type: 'start', spec })
      })
      p.then(answered, answered)
      return p
    },
    snapshot: (id) =>
      request((r, w) => {
        queued(r.snapshots, id, w)
        post(r, { type: 'snapshot', id })
      }),
    list: () =>
      request((r, w) => {
        r.lists.push(w)
        post(r, { type: 'list' })
      }),
    kill: (id) =>
      request<void>((r, w) => {
        post(r, { type: 'kill', id })
        w.resolve()
      }),
    dispose(id) {
      if (!run?.ready || stopping) return
      // The host kills a live session on dispose and sends no exit, so it leaves the live set here.
      leave(id)
      post(run, { type: 'dispose', id })
    },
    connect(port) {
      if (!run?.ready || stopping) return false
      post(run, { type: 'connect' }, [port])
      return true
    },
    flush() {
      const r = run
      if (!r?.ready || stopping) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          flushes.delete(done)
          resolve()
        }
        const timer = setTimeout(done, FLUSH_WAIT_MS)
        flushes.add(done)
        post(r, { type: 'flush' })
      })
    },
    held: () => [...new Set([...live, ...starting.keys()])],
    live: () => [...live],
    pid: () => run?.proc.pid,
  }
}

function take<T>(map: Map<string, Waiter<T>[]>, id: string): Waiter<T> | undefined {
  const queue = map.get(id)
  const first = queue?.shift()
  if (queue?.length === 0) map.delete(id)
  return first
}
