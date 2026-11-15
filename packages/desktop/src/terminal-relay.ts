// The main side of the terminal link with the server: the server's `start`, `list`, and `dispose` go to the pty
// host starter; its answers, each session's `exit`, and each host crash's `lost` go back. Its `stop`, `sweep`, and
// `labels`, and what the starter reports, feed the session roster. No `electron` import: shell-main.ts wires it. The
// rules are in pod-docs/sprints/terminal-tab.md (§2), pod-docs/sprints/session-life.md (§3), and
// pod-docs/feature-details/desktop.md (Server terminal link).

import { isAbsolute } from 'node:path'
import { SESSION_ID, type SessionInfo, type StartSpec } from '@openaflow/pty-host/protocol'
import type { PtyHostStarter } from './pty-host-starter.ts'
import type { ServerHost } from './server-host.ts'
import type { SessionRoster } from './session-roster.ts'

export const TERMINAL_MESSAGE = 'openaflow:terminal'

export type TerminalRelay = {
  /** Ends the relay. */
  stop(): void
  /** From now on, no `exit` or `lost` goes to the server. Answers to its requests still go. */
  silence(): void
}

/** From the server. `req` is a positive integer, unique per server process. */
export type ServerToMain =
  | { type: typeof TERMINAL_MESSAGE; op: 'start'; req: number; spec: StartSpec; stop?: string[] }
  | { type: typeof TERMINAL_MESSAGE; op: 'sweep'; sessions: { id: string; stop?: string[] }[] }
  | { type: typeof TERMINAL_MESSAGE; op: 'labels'; labels: { id: string; label: string }[] }
  | { type: typeof TERMINAL_MESSAGE; op: 'list'; req: number }
  | { type: typeof TERMINAL_MESSAGE; op: 'dispose'; id: string }

/** To the server. Each `start` and `list` gets one answer; `exit` goes once per session; `lost` at each host crash. */
export type MainToServer =
  | { type: typeof TERMINAL_MESSAGE; op: 'started'; req: number; id: string; pid: number }
  | { type: typeof TERMINAL_MESSAGE; op: 'start-failed'; req: number; id: string; error: string }
  | { type: typeof TERMINAL_MESSAGE; op: 'list'; req: number; sessions: SessionInfo[] }
  | { type: typeof TERMINAL_MESSAGE; op: 'list-failed'; req: number; error: string }
  | { type: typeof TERMINAL_MESSAGE; op: 'exit'; id: string; exitCode: number }
  | { type: typeof TERMINAL_MESSAGE; op: 'lost'; ids: string[] }

/** A message without its `type`, for each kind. */
type Body<M> = M extends unknown ? Omit<M, 'type'> : never
type Op = Body<ServerToMain>
type Answer = Body<MainToServer>

const LOG = 'openaflow desktop: terminal link ignored a bad message'
const STOP_LOG = 'openaflow desktop: terminal link dropped a bad stop, so the session starts with none'
export const STOP_MAX_ARGS = 32
export const STOP_MAX_CHARS = 1_024
export const LABELS_MAX = 100
export const LABEL_MAX_CHARS = 120
// C0, DEL, and C1: a label is plain text in a native dialog.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
const isRecord = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null && !Array.isArray(m)
const isReq = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A stop argv as §3 allows it, or why not. The reason never holds the argv: it names the session's unit. */
function stopProblem(stop: unknown): string | undefined {
  if (!Array.isArray(stop)) return 'not a list'
  if (stop.length === 0 || stop.length > STOP_MAX_ARGS) return `${stop.length} strings`
  if (!stop.every((a) => typeof a === 'string' && a.length <= STOP_MAX_CHARS)) return 'not strings of at most 1,024 characters'
  if (!isAbsolute(stop[0] as string)) return 'program not absolute'
  return undefined
}

/** The sweep list, or why it is bad. Every id must be a session id: a sweep ends the processes that carry it. */
function readSweep(sessions: unknown): { id: string; stop?: string[] }[] | string {
  if (!Array.isArray(sessions)) return 'sweep with no session list'
  const out: { id: string; stop?: string[] }[] = []
  for (const s of sessions) {
    if (!isRecord(s) || typeof s.id !== 'string' || !SESSION_ID.test(s.id)) return 'sweep with a bad session id'
    if (s.stop !== undefined && stopProblem(s.stop) !== undefined) return 'sweep with a bad stop'
    out.push({ id: s.id, ...(s.stop !== undefined ? { stop: s.stop as string[] } : {}) })
  }
  return out
}

/** The newest labels, cleaned: at most 100, control characters dropped, each cut to 120 characters. */
function readLabels(labels: unknown): { id: string; label: string }[] | string {
  if (!Array.isArray(labels)) return 'labels with no list'
  if (!labels.every((l) => isRecord(l) && typeof l.id === 'string' && typeof l.label === 'string')) return 'labels with a bad entry'
  return (labels as { id: string; label: string }[])
    .slice(0, LABELS_MAX)
    .map(({ id, label }) => ({ id, label: label.replace(CONTROL, '').slice(0, LABEL_MAX_CHARS) }))
}

/**
 * The op a terminal message asks for, or why it is bad. Only the shape needed to answer is checked here: the host
 * checks the rest of a spec and answers `start-failed` with its word.
 */
function readOp(m: Record<string, unknown>): Op | { bad: string } {
  const { op } = m
  if (op === 'start') {
    if (!isReq(m.req)) return { bad: 'start with no request number' }
    if (!isRecord(m.spec) || typeof m.spec.id !== 'string') return { bad: 'start with no session id' }
    return { op, req: m.req, spec: m.spec as StartSpec, ...(m.stop !== undefined ? { stop: m.stop as string[] } : {}) }
  }
  if (op === 'sweep') {
    const sessions = readSweep(m.sessions)
    return typeof sessions === 'string' ? { bad: sessions } : { op, sessions }
  }
  if (op === 'labels') {
    const labels = readLabels(m.labels)
    return typeof labels === 'string' ? { bad: labels } : { op, labels }
  }
  if (op === 'list') return isReq(m.req) ? { op, req: m.req } : { bad: 'list with no request number' }
  if (op === 'dispose') return typeof m.id === 'string' ? { op, id: m.id } : { bad: 'dispose with no session id' }
  // Only the op's name, cut short: the message itself may carry the user's text.
  return { bad: typeof op === 'string' ? `unknown op ${JSON.stringify(op.slice(0, 40))}` : 'no op' }
}

/** Relays until the returned function is called. */
export function startTerminalRelay(o: {
  server: Pick<ServerHost, 'send' | 'onMessage'>
  starter: Pick<PtyHostStarter, 'startSession' | 'list' | 'dispose' | 'onEvent' | 'state' | 'held'>
  roster: Pick<SessionRoster, 'starting' | 'started' | 'ended' | 'setLabels' | 'lost' | 'sweep'>
  log(line: string): void
}): TerminalRelay {
  let on = true
  /** From a quit's confirm on: no `exit` or `lost` reaches the server, so its next start reads `app closed`. */
  let silent = false
  /** Ids with a start in flight here, and an exit that came before the start's answer went out. */
  const starting = new Map<string, { exitCode: number } | undefined>()

  // Once the starter is stopped (the quit), the server is stopping too, and a refusal would read as a host failure.
  const open = () => on && o.starter.state() !== 'stopped'
  const answer = (to: (m: unknown) => void, m: Answer) => {
    if (open()) to({ type: TERMINAL_MESSAGE, ...m })
  }
  const send = (m: Answer) => answer(o.server.send, m)

  const start = (req: number, spec: StartSpec, stop: unknown, reply: (m: unknown) => void) => {
    const { id } = spec
    const problem = stop === undefined ? undefined : stopProblem(stop)
    if (problem !== undefined) o.log(`${STOP_LOG}: ${problem}`)
    o.roster.starting(id, problem === undefined ? (stop as string[] | undefined) : undefined)
    starting.set(id, undefined)
    const done = (m: Answer, sendHeldExit: boolean) => {
      const held = starting.get(id)
      starting.delete(id)
      answer(reply, m)
      if (sendHeldExit && held && !silent) send({ op: 'exit', id, exitCode: held.exitCode })
    }
    o.starter.startSession(spec).then(
      ({ pid }) => {
        o.roster.started(id, pid)
        // An exit that came before this answer: the roster hears it after the start, as the server does.
        if (starting.get(id)) o.roster.ended(id)
        done({ op: 'started', req, id, pid }, true)
      },
      (err: unknown) => {
        o.roster.ended(id)
        done({ op: 'start-failed', req, id, error: errorText(err) }, false)
      },
    )
  }

  /** The server's sweep, less every id main holds: live, waiting for its pid, or with a start in flight here. */
  const sweep = (sessions: { id: string; stop?: string[] }[]) => {
    const held = new Set([...o.starter.held(), ...starting.keys()])
    const rest = sessions.filter((s) => !held.has(s.id))
    if (rest.length > 0) void o.roster.sweep(rest)
  }

  const offServer = o.server.onMessage((m, reply) => {
    if (!on || !isRecord(m) || m.type !== TERMINAL_MESSAGE) return
    const op = readOp(m)
    if ('bad' in op) return o.log(`${LOG}: ${op.bad}`)
    if (!open()) return
    if (op.op === 'start') start(op.req, op.spec, op.stop, reply)
    else if (op.op === 'sweep') sweep(op.sessions)
    else if (op.op === 'labels') o.roster.setLabels(op.labels)
    else if (op.op === 'list') {
      o.starter.list().then(
        (sessions) => answer(reply, { op: 'list', req: op.req, sessions }),
        (err: unknown) => answer(reply, { op: 'list-failed', req: op.req, error: errorText(err) }),
      )
    } else o.starter.dispose(op.id)
  })

  const offStarter = o.starter.onEvent((e) => {
    if (e.type === 'crashed') {
      void o.roster.lost(e.lost)
      if (!silent) send({ op: 'lost', ids: e.lost })
    } else if (e.type === 'exit') {
      // `started` goes out after its promise settles, so an exit in the same tick waits for it.
      if (starting.has(e.id)) starting.set(e.id, { exitCode: e.exitCode })
      else {
        o.roster.ended(e.id)
        if (!silent) send({ op: 'exit', id: e.id, exitCode: e.exitCode })
      }
    }
  })

  return {
    stop() {
      on = false
      offServer()
      offStarter()
    },
    silence() {
      silent = true
    },
  }
}
