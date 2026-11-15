// The main side of the terminal link with the server: the server's `start`, `list`, and `dispose` go to the pty
// host starter; its answers, each session's `exit`, and each host crash's `lost` go back. No `electron` import:
// shell-main.ts wires it. The rules are in pod-docs/sprints/terminal-tab.md (§2) and
// pod-docs/feature-details/desktop.md (Server terminal link).

import type { SessionInfo, StartSpec } from '@openaflow/pty-host/protocol'
import type { PtyHostStarter } from './pty-host-starter.ts'
import type { ServerHost } from './server-host.ts'

export const TERMINAL_MESSAGE = 'openaflow:terminal'

/** From the server. `req` is a positive integer, unique per server process. */
export type ServerToMain =
  | { type: typeof TERMINAL_MESSAGE; op: 'start'; req: number; spec: StartSpec }
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
const isRecord = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null && !Array.isArray(m)
const isReq = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The op a terminal message asks for, or why it is bad. Only the shape needed to answer is checked here: the host
 * checks the rest of a spec and answers `start-failed` with its word.
 */
function readOp(m: Record<string, unknown>): Op | { bad: string } {
  const { op } = m
  if (op === 'start') {
    if (!isReq(m.req)) return { bad: 'start with no request number' }
    if (!isRecord(m.spec) || typeof m.spec.id !== 'string') return { bad: 'start with no session id' }
    return { op, req: m.req, spec: m.spec as StartSpec }
  }
  if (op === 'list') return isReq(m.req) ? { op, req: m.req } : { bad: 'list with no request number' }
  if (op === 'dispose') return typeof m.id === 'string' ? { op, id: m.id } : { bad: 'dispose with no session id' }
  // Only the op's name, cut short: the message itself may carry the user's text.
  return { bad: typeof op === 'string' ? `unknown op ${JSON.stringify(op.slice(0, 40))}` : 'no op' }
}

/** Relays until the returned function is called. */
export function startTerminalRelay(o: {
  server: Pick<ServerHost, 'send' | 'onMessage'>
  starter: Pick<PtyHostStarter, 'startSession' | 'list' | 'dispose' | 'onEvent' | 'state'>
  log(line: string): void
}): () => void {
  let on = true
  /** Ids with a start in flight here, and an exit that came before the start's answer went out. */
  const starting = new Map<string, { exitCode: number } | undefined>()

  // Once the starter is stopped (the quit), the server is stopping too, and a refusal would read as a host failure.
  const open = () => on && o.starter.state() !== 'stopped'
  const answer = (to: (m: unknown) => void, m: Answer) => {
    if (open()) to({ type: TERMINAL_MESSAGE, ...m })
  }
  const send = (m: Answer) => answer(o.server.send, m)

  const start = (req: number, spec: StartSpec, reply: (m: unknown) => void) => {
    const { id } = spec
    starting.set(id, undefined)
    const done = (m: Answer, sendHeldExit: boolean) => {
      const held = starting.get(id)
      starting.delete(id)
      answer(reply, m)
      if (sendHeldExit && held) send({ op: 'exit', id, exitCode: held.exitCode })
    }
    o.starter.startSession(spec).then(
      ({ pid }) => done({ op: 'started', req, id, pid }, true),
      (err: unknown) => done({ op: 'start-failed', req, id, error: errorText(err) }, false),
    )
  }

  const offServer = o.server.onMessage((m, reply) => {
    if (!on || !isRecord(m) || m.type !== TERMINAL_MESSAGE) return
    const op = readOp(m)
    if ('bad' in op) return o.log(`${LOG}: ${op.bad}`)
    if (!open()) return
    if (op.op === 'start') start(op.req, op.spec, reply)
    else if (op.op === 'list') {
      o.starter.list().then(
        (sessions) => answer(reply, { op: 'list', req: op.req, sessions }),
        (err: unknown) => answer(reply, { op: 'list-failed', req: op.req, error: errorText(err) }),
      )
    } else o.starter.dispose(op.id)
  })

  const offStarter = o.starter.onEvent((e) => {
    if (e.type === 'crashed') send({ op: 'lost', ids: e.lost })
    else if (e.type === 'exit') {
      // `started` goes out after its promise settles, so an exit in the same tick waits for it.
      if (starting.has(e.id)) starting.set(e.id, { exitCode: e.exitCode })
      else send({ op: 'exit', id: e.id, exitCode: e.exitCode })
    }
  })

  return () => {
    on = false
    offServer()
    offStarter()
  }
}
