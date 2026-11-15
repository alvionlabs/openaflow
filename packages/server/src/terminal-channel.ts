// The server side of the terminal link with the desktop's main process, over the parent channel parent-link.ts
// gives a server that main started with OPENAFLOW_TERMINALS=1. The server asks `start`, `list`, and `dispose`; main
// answers, and sends each session's `exit` and each host crash's `lost`. The messages are sprint terminal-tab's shared
// contract §2; main's side is packages/desktop/src/terminal-relay.ts. The rules are in
// pod-docs/feature-details/hosted-sessions.md.

import type { ParentChannel } from './parent-link.ts'

export const TERMINAL_MESSAGE = 'openaflow:terminal'

/** `@openaflow/pty-host/protocol`'s shapes, copied: the server doesn't depend on that package. */
export type StartSpec = { id: string; program: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
export type SessionInfo = { id: string; pid: number; live: boolean; startedAt: number }

/** What main tells the server about a session, also with no request waiting. */
export type TerminalEvent =
  | { op: 'started'; id: string; pid: number }
  | { op: 'start-failed'; id: string; error: string }
  | { op: 'exit'; id: string; exitCode: number }
  | { op: 'lost'; ids: string[] }

export type TerminalChannel = {
  /** Resolves on `started`; rejects with main's word on `start-failed`, or `terminals unavailable` after the answer limit. */
  start(spec: StartSpec): Promise<{ pid: number }>
  /** Resolves with the host's sessions; rejects with main's word on `list-failed`, or `no answer` after the answer limit. */
  list(): Promise<SessionInfo[]>
  dispose(id: string): void
  /** Every well-formed `started`, `start-failed`, `exit`, and `lost`, before any request settles. Returns the unsubscribe. */
  onEvent(fn: (e: TerminalEvent) => void): () => void
  /** Stops: pending requests stay unsettled, and nothing more goes out or comes in. */
  close(): void
}

/** How long a `start` or `list` waits for main's answer. */
export const ANSWER_MS = 30_000
export const UNAVAILABLE = 'terminals unavailable'

/** A request main never answered in time. A `start`'s reads `terminals unavailable`, as main's own refusal does. */
export class NoAnswer extends Error {
  override name = 'NoAnswer'
}
const LOG = 'openaflow: terminal channel ignored a bad message'

type Pending = { resolve(v: unknown): void; reject(err: Error): void; timer: NodeJS.Timeout }
type Answer =
  | { op: 'answer'; req: number; ok: true; value: unknown }
  | { op: 'answer'; req: number; ok: false; error: string }

const isRecord = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null && !Array.isArray(m)
const isReq = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0
const isInfo = (s: unknown): s is SessionInfo =>
  isRecord(s) && typeof s.id === 'string' && Number.isSafeInteger(s.pid) && typeof s.live === 'boolean' && typeof s.startedAt === 'number'

/** The event and the answer a message carries, or why it is bad. Never the message itself: it may hold more than ids. */
function readMessage(m: Record<string, unknown>): { event?: TerminalEvent; answer?: Answer } | { bad: string } {
  const { op } = m
  if (op === 'started') {
    if (!isReq(m.req) || typeof m.id !== 'string' || !Number.isSafeInteger(m.pid)) return { bad: 'started with a bad shape' }
    return { event: { op, id: m.id, pid: m.pid as number }, answer: { op: 'answer', req: m.req, ok: true, value: { pid: m.pid } } }
  }
  if (op === 'start-failed') {
    if (!isReq(m.req) || typeof m.id !== 'string' || typeof m.error !== 'string') return { bad: 'start-failed with a bad shape' }
    return { event: { op, id: m.id, error: m.error }, answer: { op: 'answer', req: m.req, ok: false, error: m.error } }
  }
  if (op === 'list') {
    if (!isReq(m.req) || !Array.isArray(m.sessions) || !m.sessions.every(isInfo)) return { bad: 'list with a bad shape' }
    return { answer: { op: 'answer', req: m.req, ok: true, value: m.sessions } }
  }
  if (op === 'list-failed') {
    if (!isReq(m.req) || typeof m.error !== 'string') return { bad: 'list-failed with a bad shape' }
    return { answer: { op: 'answer', req: m.req, ok: false, error: m.error } }
  }
  if (op === 'exit') {
    if (typeof m.id !== 'string' || !Number.isInteger(m.exitCode)) return { bad: 'exit with a bad shape' }
    return { event: { op, id: m.id, exitCode: m.exitCode as number } }
  }
  if (op === 'lost') {
    if (!Array.isArray(m.ids) || !m.ids.every((id) => typeof id === 'string')) return { bad: 'lost with a bad shape' }
    return { event: { op, ids: m.ids as string[] } }
  }
  return { bad: typeof op === 'string' ? `unknown op ${JSON.stringify(op.slice(0, 40))}` : 'no op' }
}

export function createTerminalChannel(o: { link: ParentChannel; log(line: string): void; answerMs?: number }): TerminalChannel {
  const answerMs = o.answerMs ?? ANSWER_MS
  const pending = new Map<number, Pending>()
  const listeners = new Set<(e: TerminalEvent) => void>()
  let nextReq = 1
  let open = true

  o.link.onMessage((m) => {
    if (!open || !isRecord(m) || m.type !== TERMINAL_MESSAGE) return
    const read = readMessage(m)
    if ('bad' in read) return o.log(`${LOG}: ${read.bad}`)
    // The event first: the store is current before the route that waits on the answer goes on.
    if (read.event) for (const fn of [...listeners]) fn(read.event)
    const answer = read.answer
    const p = answer && pending.get(answer.req)
    if (!answer || !p) return
    pending.delete(answer.req)
    clearTimeout(p.timer)
    if (answer.ok) p.resolve(answer.value)
    else p.reject(new Error(answer.error))
  })

  /** Sends a request and waits for its one answer. */
  const ask = <T>(op: 'start' | 'list', body: Record<string, unknown>, timeoutWord: string): Promise<T> => {
    if (!open) return Promise.reject(new Error(UNAVAILABLE))
    const req = nextReq++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(req)
        reject(new NoAnswer(timeoutWord))
      }, answerMs)
      timer.unref()
      pending.set(req, { resolve: resolve as (v: unknown) => void, reject, timer })
      o.link.send({ type: TERMINAL_MESSAGE, op, req, ...body })
    })
  }

  return {
    start: (spec) => ask<{ pid: number }>('start', { spec }, UNAVAILABLE),
    list: () => ask<SessionInfo[]>('list', {}, 'no answer'),
    dispose(id) {
      if (open) o.link.send({ type: TERMINAL_MESSAGE, op: 'dispose', id })
    },
    onEvent(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    close() {
      open = false
      for (const p of pending.values()) clearTimeout(p.timer)
      pending.clear()
      listeners.clear()
    },
  }
}
