// The pty host's state: one pty and one session (headless terminal and attached ports) per id. host-entry.ts wires
// it to Electron's parentPort. session.ts holds what each window sees. The rules are in
// pod-docs/sprints/host-core.md (§4).

import { isAbsolute } from 'node:path'
import { BEAT_MS, FLUSH_WAIT_MS, MAIN_ONLY, PROTOCOL_VERSION, specError, type HostToMain, type SessionInfo, type StartSpec } from './protocol.ts'
import { createScreenSaver, nodeScreenFs, type ScreenFs, type ScreenSaver } from './screen-file.ts'
import { createSession, linkPort, type Session as View, type SessionPty, type WindowLink, type WindowPort } from './session.ts'

export { plainText } from './session.ts'

export type PtySpawnOptions = { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
export type PtyProcess = SessionPty & {
  readonly pid: number
  onData(fn: (data: string) => void): unknown
  onExit(fn: (e: { exitCode: number; signal?: number }) => void): unknown
  kill(signal?: string): void
}
export type PtyModule = { spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess }

export type HostDeps = {
  /** `require('node-pty')`. A throw here is `load-failed`. */
  loadPty(): PtyModule
  send(message: HostToMain): void
  exit(code: number): void
  isDir(path: string): boolean
  /** Lines kept above the screen. */
  scrollback: number
  /** How long shutdown waits for the ptys' exits. Default 3 s. */
  shutdownWaitMs?: number
  /** Where screen files are written. Default: the real file system. */
  screenFs?: ScreenFs
  /** One log line. Default: stderr. */
  log?(line: string): void
}

export type PtyHost = {
  /** A message from main. `ports` are the event's ports: `connect` takes a window's port from `ports[0]`. */
  handle(message: unknown, ports?: readonly unknown[]): void
}

type Session = {
  id: string
  pty: PtyProcess
  view: View
  startedAt: number
  exited: boolean
  /** Whether `started` went out. Until then the session has pid 0, and windows can't see it. */
  announced: boolean
  /** While no pid: ends the wait and frees the id. */
  abandon?(error: string): void
  /** Set once the session started, when its spec has a screen file. */
  screen?: ScreenSaver
}

const SHUTDOWN_WAIT_MS = 3_000
/** On Windows node-pty starts the process after `spawn` returns (its own limit is 5 s), so the pid is 0 for a moment. */
const PID_POLL_MS = 10
const PID_WAIT_MS = 10_000

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const isPort = (p: unknown): p is WindowPort =>
  typeof p === 'object' && p !== null && ['on', 'start', 'postMessage'].every((k) => typeof (p as Record<string, unknown>)[k] === 'function')

export function startPtyHost(deps: HostDeps): PtyHost {
  let pty: PtyModule
  try {
    pty = deps.loadPty()
  } catch (err) {
    deps.send({ type: 'load-failed', error: message(err) })
    deps.exit(1)
    return { handle() {} }
  }
  deps.send({ type: 'ready', version: PROTOCOL_VERSION })

  const screenFs = deps.screenFs ?? nodeScreenFs
  const log = deps.log ?? ((line: string) => console.error(line))
  const sessions = new Map<string, Session>()
  const exitWaiters = new Set<() => void>()
  let shuttingDown = false
  const beat = setInterval(() => deps.send({ type: 'beat' }), BEAT_MS)

  function start(spec: unknown): void {
    const id = typeof spec === 'object' && spec !== null && typeof (spec as { id?: unknown }).id === 'string' ? (spec as { id: string }).id : ''
    const refuse = (error: string) => deps.send({ type: 'start-failed', id, error })
    const error = specError(spec, { isAbsolute, isDir: deps.isDir })
    if (error !== undefined) return refuse(error)
    if (sessions.has(id)) return refuse('id in use')
    const s = spec as StartSpec
    let proc: PtyProcess
    try {
      proc = pty.spawn(s.program, s.args, { name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd: s.cwd, env: s.env })
    } catch (err) {
      return refuse(`spawn failed: ${message(err)}`)
    }
    const view = createSession({ id, pty: proc, cols: s.cols, rows: s.rows, scrollback: s.scrollback ?? deps.scrollback })
    const session: Session = { id, pty: proc, view, startedAt: Date.now(), exited: false, announced: false }
    sessions.set(id, session)

    let poll: ReturnType<typeof setTimeout> | undefined
    const stopWaiting = () => {
      clearTimeout(poll)
      session.abandon = undefined
    }
    /** Sends `started` once the pid is known. */
    const announce = () => {
      if (session.announced || session.abandon === undefined || !(proc.pid > 0)) return session.announced
      stopWaiting()
      session.announced = true
      if (s.screenFile !== undefined) session.screen = createScreenSaver({ id, file: s.screenFile, fs: screenFs, log, snapshot: view.snapshot })
      deps.send({ type: 'started', id, pid: proc.pid })
      return true
    }
    session.abandon = (error) => {
      stopWaiting()
      session.exited = true
      if (sessions.get(id) === session) sessions.delete(id)
      view.dispose()
      deps.send({ type: 'start-failed', id, error: `spawn failed: ${error}` })
      for (const wake of exitWaiters) wake()
    }

    proc.onData((data) => {
      announce()
      if (session.exited) return
      view.output(data)
      session.screen?.changed()
    })
    proc.onExit(({ exitCode, signal }) => {
      if (session.exited) return
      if (!announce()) return session.abandon?.(`the program ended before it started (exit code ${exitCode})`)
      session.exited = true
      view.ended(exitCode)
      // Saved once after the exit. At shutdown the save came before the kill.
      session.screen?.stop()
      if (!shuttingDown) void session.screen?.save()
      deps.send(signal ? { type: 'exit', id, exitCode, signal } : { type: 'exit', id, exitCode })
      for (const wake of exitWaiters) wake()
    })
    if (announce()) return
    const waitEnd = Date.now() + PID_WAIT_MS
    const check = () => {
      if (announce()) return
      if (Date.now() < waitEnd) return void (poll = setTimeout(check, PID_POLL_MS))
      kill(session)
      session.abandon?.(`no process ID after ${PID_WAIT_MS / 1_000} s`)
    }
    poll = setTimeout(check, PID_POLL_MS)
  }

  function snapshot(id: string): void {
    const session = sessions.get(id)
    if (session === undefined) return deps.send({ type: 'snapshot', id, text: null })
    session.view.snapshot((text) => deps.send({ type: 'snapshot', id, text: sessions.get(id) === session ? text : null }))
  }

  function list(): void {
    const infos: SessionInfo[] = [...sessions.values()].map((s) => ({ id: s.id, pid: s.announced ? s.pty.pid : 0, live: !s.exited, startedAt: s.startedAt }))
    deps.send({ type: 'list', sessions: infos })
  }

  function kill(session: Session): void {
    try {
      session.pty.kill()
    } catch {
      // Already closed: its exit comes, or came, on its own.
    }
  }

  /**
   * Kills a pty whose session was given up while it waited for its pid: now, or, when the pty can't take a kill yet,
   * once its pid shows (10 s at most). On Windows node-pty holds the kill until the program's first output.
   */
  function killAbandoned(proc: PtyProcess): void {
    const tryKill = () => {
      try {
        proc.kill()
        return true
      } catch {
        return false
      }
    }
    if (tryKill()) return
    const end = Date.now() + PID_WAIT_MS
    const retry = () => {
      if (proc.pid > 0) return void tryKill()
      if (Date.now() < end) setTimeout(retry, PID_POLL_MS)
    }
    setTimeout(retry, PID_POLL_MS)
  }

  /** The pty's own kill. A session waiting for its pid ends now, as `start-failed`. */
  function killSession(id: string): void {
    const session = sessions.get(id)
    if (session === undefined || session.exited) return
    if (session.abandon === undefined) return kill(session)
    killAbandoned(session.pty)
    session.abandon('killed before it started')
  }

  function dispose(id: string): void {
    const session = sessions.get(id)
    if (session === undefined) return
    if (session.abandon !== undefined) {
      killAbandoned(session.pty)
      return session.abandon('disposed before it started')
    }
    sessions.delete(id)
    session.screen?.dispose()
    // Its exit, when it comes, goes nowhere: the session is gone.
    const live = !session.exited
    session.exited = true
    if (live) kill(session)
    session.view.dispose()
  }

  /** Saves every started session's screen file, then answers `flushed` once: within 2 s, even when a write hangs. */
  function flush(): void {
    let answered = false
    const answer = () => {
      if (answered) return
      answered = true
      clearTimeout(timer)
      deps.send({ type: 'flushed' })
    }
    const timer = setTimeout(answer, FLUSH_WAIT_MS)
    void Promise.all([...sessions.values()].map((s) => s.screen?.save())).then(answer)
  }

  function shutdown(): void {
    if (shuttingDown) return
    shuttingDown = true
    const live = () => [...sessions.values()].filter((s) => !s.exited)
    for (const session of live()) {
      if (session.abandon === undefined) continue
      killAbandoned(session.pty)
      session.abandon('the host is shutting down')
    }
    // Each screen file is saved before its pty is killed, 2 s at most. The 3 s wait below counts from now.
    for (const session of sessions.values()) session.screen?.stop()
    const saves = [...sessions.values()].flatMap((s) => (s.screen === undefined ? [] : [s.screen.save()]))
    /** Set once the saves ended and the ptys got their kill: only then may the host exit. */
    let killedAll = false
    const killAll = () => {
      killedAll = true
      for (const session of live()) kill(session)
      queueMicrotask(check)
    }
    if (saves.length === 0) killAll()
    else {
      let killed = false
      const killOnce = () => {
        if (killed) return
        killed = true
        clearTimeout(saveLimit)
        killAll()
      }
      const saveLimit = setTimeout(killOnce, FLUSH_WAIT_MS)
      void Promise.all(saves).then(killOnce)
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      exitWaiters.clear()
      clearTimeout(timer)
      clearInterval(beat)
      deps.exit(0)
    }
    const timer = setTimeout(finish, deps.shutdownWaitMs ?? SHUTDOWN_WAIT_MS)
    function check() {
      if (killedAll && live().length === 0) finish()
    }
    exitWaiters.add(check)
  }

  /** A session a window may use: listed, with its pid known. */
  const visible = (id: string) => {
    const session = sessions.get(id)
    return session?.announced === true ? session : undefined
  }

  function connect(port: unknown): void {
    if (!isPort(port)) return console.error('openaflow pty host: connect came with no port')
    const link: WindowLink = linkPort(port, (data) => {
      if (shuttingDown) return
      try {
        fromWindow(link, data)
      } catch (err) {
        console.error(`openaflow pty host: a window message failed: ${message(err)}`)
      }
    })
  }

  /** A message on a window's port. A window may only attach, detach, input, resize, and ack. */
  function fromWindow(link: WindowLink, raw: unknown): void {
    const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const id = typeof m.id === 'string' ? m.id : undefined
    const fail = (error: string) => link.post(id === undefined ? { type: 'error', error } : { type: 'error', id, error })
    if (typeof m.type === 'string' && MAIN_ONLY.has(m.type)) return fail('not allowed')
    if (id === undefined) return fail('bad message')
    const session = visible(id)
    switch (m.type) {
      case 'attach':
        return session === undefined ? fail('no session') : session.view.attach(link)
      case 'detach':
        return session?.view.detach(link)
      case 'input':
        if (typeof m.data !== 'string') return fail('bad message')
        return session === undefined ? fail('no session') : session.view.input(m.data)
      case 'resize': {
        if (typeof m.cols !== 'number' || typeof m.rows !== 'number') return fail('bad message')
        if (session === undefined) return fail('no session')
        const error = session.view.resize(m.cols, m.rows)
        return error === undefined ? undefined : fail(error)
      }
      case 'ack':
        if (!Number.isInteger(m.chars) || (m.chars as number) < 0) return fail('bad message')
        return session?.view.ack(link, m.chars as number)
      default:
        return fail('bad message')
    }
  }

  return {
    handle(raw, ports = []) {
      if (typeof raw !== 'object' || raw === null) return
      const m = raw as { type?: unknown; id?: unknown; spec?: unknown }
      // A flush still answers during shutdown, so main never waits on it.
      if (shuttingDown && m.type !== 'flush') return
      try {
        if (m.type === 'start') start(m.spec)
        else if (m.type === 'kill' && typeof m.id === 'string') killSession(m.id)
        else if (m.type === 'dispose' && typeof m.id === 'string') dispose(m.id)
        else if (m.type === 'list') list()
        else if (m.type === 'snapshot' && typeof m.id === 'string') snapshot(m.id)
        else if (m.type === 'connect') connect(ports[0])
        else if (m.type === 'flush') flush()
        else if (m.type === 'shutdown') shutdown()
        else console.error(`openaflow pty host: a message it does not know: ${JSON.stringify(m.type)}`)
      } catch (err) {
        // The host never throws on a message. Main has no error answer; the log has it.
        console.error(`openaflow pty host: ${String(m.type)} failed: ${message(err)}`)
      }
    },
  }
}
