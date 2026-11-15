// The window link's rules: who gets a port to the terminal host, when, and what each window hears about the host.
// The ipcMain glue is terminal-port-main.ts; the page's side is in preload-main.ts. The rules are in
// pod-docs/sprints/host-core.md (§5) and pod-docs/feature-details/desktop.md (Terminal host).

import { senderAllowed, type BridgeCaller } from './folder-bridge.ts'
import type { PtyHostStarter, StarterEvent } from './pty-host-starter.ts'

/** Page → main: asks for a port, with the preload's request number. */
export const TERMINAL_CONNECT_CHANNEL = 'openaflow:terminal-connect'
/** Main → preload: the port, with `{ request }`. */
export const TERMINAL_PORT_CHANNEL = 'openaflow:terminal-port'
/** Main → every window: a TerminalHostState. */
export const TERMINAL_STATE_CHANNEL = 'openaflow:terminal-host'
/** The `window` message that carries the port to the page, in `ports[0]`. */
export const PAGE_PORT_MESSAGE = 'openaflow:terminal-port'

export const PORT_WAIT_MS = 20_000
const UNAVAILABLE = 'terminals unavailable'

export type TerminalHostState = 'ready' | 'unresponsive' | 'restarted' | 'failed'
export type PortReply = { ok: true } | { error: 'forbidden' | 'terminals unavailable' }

/** What a window hears. A host that beats again is `ready`; a crash says nothing until the restarted host is ready. */
export function windowStateOf(e: StarterEvent): TerminalHostState | undefined {
  if (e.type === 'ready') return e.restarted ? 'restarted' : 'ready'
  if (e.type === 'responsive') return 'ready'
  if (e.type === 'unresponsive' || e.type === 'failed') return e.type
  return undefined
}

export function createTerminalLink<W, P>(o: {
  starter: Pick<PtyHostStarter, 'state' | 'onEvent' | 'connect'>
  /** The server's origin, or undefined before the server is ready. */
  origin(): string | undefined
  /** The app window, or undefined when it is closed. */
  appWindow(): W | undefined
  /** A new channel: one end goes to the host, the other to the page. */
  channel(): { host: P; page: P }
  /** Sends a state to every window. */
  broadcast(state: TerminalHostState): void
}): {
  /** `give` sends the page's end to the caller's frame, before the reply goes back. */
  request(caller: BridgeCaller<W>, give: (port: P) => void): Promise<PortReply>
} {
  o.starter.onEvent((e) => {
    const state = windowStateOf(e)
    if (state !== undefined) o.broadcast(state)
  })

  const allowed = (caller: BridgeCaller<W>) => senderAllowed(caller, o.origin(), o.appWindow())
  const hostReady = () => o.starter.state() === 'ready' || o.starter.state() === 'unresponsive'
  const gone = () => o.starter.state() === 'failed' || o.starter.state() === 'stopped'

  const connect = (caller: BridgeCaller<W>, give: (port: P) => void): PortReply => {
    // The window may have moved on while the request waited.
    if (!allowed(caller)) return { error: 'forbidden' }
    if (!hostReady()) return { error: UNAVAILABLE }
    const { host, page } = o.channel()
    if (!o.starter.connect(host)) return { error: UNAVAILABLE }
    give(page)
    return { ok: true }
  }

  /** Resolves at the next ready, or false at `failed` or after the wait. */
  const waitForReady = () =>
    new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer)
        off()
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), PORT_WAIT_MS)
      const off = o.starter.onEvent((e) => {
        if (e.type === 'ready') finish(true)
        else if (e.type === 'failed') finish(false)
      })
    })

  return {
    async request(caller, give) {
      if (!allowed(caller)) return { error: 'forbidden' }
      if (gone()) return { error: UNAVAILABLE }
      if (!hostReady() && !(await waitForReady())) return { error: UNAVAILABLE }
      return connect(caller, give)
    },
  }
}

/** The preload's side: the reply's word, or `terminals unavailable` for anything else. */
function replyError(reply: unknown): string | undefined {
  if (typeof reply === 'object' && reply !== null) {
    if ('ok' in reply && reply.ok === true) return undefined
    if ('error' in reply && reply.error === 'forbidden') return 'forbidden'
  }
  return UNAVAILABLE
}

/**
 * The preload's side of `connectTerminals()`. Each call has a number; the port that comes back with that number is
 * delivered to the page, and the call resolves only once the page has it and the reply said yes.
 */
export function createPortRequests<P>(o: {
  invoke(id: number): Promise<unknown>
  /** Posts the port to the page; resolves once the page's listeners have run. */
  deliver(port: P, id: number): Promise<void>
}): { connect(): Promise<void>; receive(id: unknown, port: P | undefined): void } {
  let next = 0
  const waiting = new Map<number, () => void>()
  return {
    async connect() {
      const id = ++next
      const delivered = new Promise<void>((resolve) => waiting.set(id, resolve))
      let reply: unknown
      try {
        reply = await o.invoke(id)
      } catch {
        reply = undefined
      }
      const error = replyError(reply)
      if (error !== undefined) {
        waiting.delete(id)
        throw new Error(error)
      }
      await delivered
    },
    receive(id, port) {
      if (typeof id !== 'number' || port === undefined) return
      const done = waiting.get(id)
      if (done === undefined) return
      waiting.delete(id)
      void o.deliver(port, id).then(done)
    },
  }
}
