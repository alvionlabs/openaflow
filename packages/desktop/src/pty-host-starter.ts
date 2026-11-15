// Runs the pty host process: fork, ready, heartbeat, restarts, stop, and the main side of its messages. No
// `electron` import: pty-host-main.ts is the glue. The rules are in pod-docs/sprints/host-core.md (§4) and
// pod-docs/feature-details/desktop.md (Terminal host).

import type { StartSpec } from '@openaflow/pty-host/protocol'
import { hostLogLine } from './pty-host-launch.ts'

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

export type StarterState = 'idle' | 'starting' | 'ready' | 'unresponsive' | 'failed' | 'stopped'
/** A session that waits for its pid is listed with pid 0. */
export type SessionInfo = { id: string; pid: number; live: boolean; startedAt: number }
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
  /** Hands a window's port to the ready host. False when no host is ready. */
  connect(port: unknown): boolean
  /** The ids between `started` and `exit`, in start order. */
  live(): string[]
  pid(): number | undefined
}

// The messages that protocol.ts doesn't name yet (H1 adds them). Their shapes are §4's.
type ListAnswer = { type: 'list'; sessions: SessionInfo[] }

const UNAVAILABLE = 'terminals unavailable'
const EXITED = 'terminal host exited'
const LOG = 'openaflow desktop: terminal host'

type Waiter<T> = { resolve(value: T): void; reject(err: Error): void }

const isRecord = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null
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
    const lost = live.splice(0)
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
    if (run !== r || !isRecord(m)) return
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
    } else if (m.type === 'exit' && typeof m.id === 'string') {
      const at = live.indexOf(m.id)
      if (at >= 0) live.splice(at, 1)
    } else if (m.type === 'snapshot' && typeof m.id === 'string' && (m.text === null || typeof m.text === 'string')) {
      take(r.snapshots, m.id)?.resolve(m.text)
    } else if (m.type === 'list' && Array.isArray(m.sessions) && m.sessions.every(isSession)) {
      r.lists.shift()?.resolve((m as ListAnswer).sessions)
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
      live.splice(0)
      stopping = r ? runStop(r) : Promise.resolve('not running')
      return stopping
    },
    state: () => state,
    onEvent(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    startSession: (spec) =>
      request((r, w) => {
        queued(r.starts, spec.id, w)
        post(r, { type: 'start', spec })
      }),
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
    connect(port) {
      if (!run?.ready || stopping) return false
      post(run, { type: 'connect' }, [port])
      return true
    },
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
