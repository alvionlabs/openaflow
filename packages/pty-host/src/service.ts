// The pty host's state: one pty and one headless terminal per session. host-entry.ts wires it to Electron's
// parentPort. The rules are in pod-docs/sprints/host-core.md (§4).

import { isAbsolute } from 'node:path'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { PROTOCOL_VERSION, specError, type HostToMain, type StartSpec } from './protocol.ts'

export type PtySpawnOptions = { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
export type PtyProcess = {
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
}

type Session = {
  id: string
  pty: PtyProcess
  term: Terminal
  /** For the replay a window gets on attach (a later slice). */
  serialize: SerializeAddon
  startedAt: number
  exited: boolean
}

const SHUTDOWN_WAIT_MS = 3_000

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The screen and the scrollback as plain lines: wrapped rows joined, each line right-trimmed, no blank lines at the end. */
export function plainText(term: Terminal): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (line === undefined) continue
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] = lines.at(-1)!.padEnd(term.cols) + text
    else lines.push(text)
  }
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  return lines.map((l) => l.trimEnd()).join('\n')
}

export function startPtyHost(deps: HostDeps): { handle(message: unknown): void } {
  let pty: PtyModule
  try {
    pty = deps.loadPty()
  } catch (err) {
    deps.send({ type: 'load-failed', error: message(err) })
    deps.exit(1)
    return { handle() {} }
  }
  deps.send({ type: 'ready', version: PROTOCOL_VERSION })

  const sessions = new Map<string, Session>()
  const exitWaiters = new Set<() => void>()
  let shuttingDown = false

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
    const term = new Terminal({ cols: s.cols, rows: s.rows, scrollback: deps.scrollback, allowProposedApi: true })
    const serialize = new SerializeAddon()
    term.loadAddon(serialize)
    const session: Session = { id, pty: proc, term, serialize, startedAt: Date.now(), exited: false }
    sessions.set(id, session)
    proc.onData((data) => term.write(data))
    proc.onExit(({ exitCode, signal }) => {
      if (session.exited) return
      session.exited = true
      deps.send(signal ? { type: 'exit', id, exitCode, signal } : { type: 'exit', id, exitCode })
      for (const wake of exitWaiters) wake()
    })
    deps.send({ type: 'started', id, pid: proc.pid })
  }

  function snapshot(id: string): void {
    const session = sessions.get(id)
    if (session === undefined) return deps.send({ type: 'snapshot', id, text: null })
    // Writes are parsed in order, so this callback runs after every chunk written before it.
    session.term.write('', () => deps.send({ type: 'snapshot', id, text: sessions.get(id) === session ? plainText(session.term) : null }))
  }

  function kill(session: Session): void {
    try {
      session.pty.kill()
    } catch {
      // Already closed: its exit comes, or came, on its own.
    }
  }

  function dispose(id: string): void {
    const session = sessions.get(id)
    if (session === undefined) return
    sessions.delete(id)
    if (!session.exited) kill(session)
    session.term.dispose()
  }

  function shutdown(): void {
    if (shuttingDown) return
    shuttingDown = true
    const live = () => [...sessions.values()].filter((s) => !s.exited)
    for (const session of live()) kill(session)
    let done = false
    const finish = () => {
      if (done) return
      done = true
      exitWaiters.clear()
      clearTimeout(timer)
      deps.exit(0)
    }
    const timer = setTimeout(finish, deps.shutdownWaitMs ?? SHUTDOWN_WAIT_MS)
    const check = () => {
      if (live().length === 0) finish()
    }
    exitWaiters.add(check)
    queueMicrotask(check)
  }

  return {
    handle(raw) {
      if (shuttingDown || typeof raw !== 'object' || raw === null) return
      const m = raw as { type?: unknown; id?: unknown; spec?: unknown }
      try {
        if (m.type === 'start') start(m.spec)
        else if (m.type === 'snapshot' && typeof m.id === 'string') snapshot(m.id)
        else if (m.type === 'dispose' && typeof m.id === 'string') dispose(m.id)
        else if (m.type === 'shutdown') shutdown()
      } catch (err) {
        // The host never throws on a message. A later slice answers a window with `error`.
        console.error(`openaflow pty host: ${String(m.type)} failed: ${message(err)}`)
      }
    },
  }
}
