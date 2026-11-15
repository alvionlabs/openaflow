// The window link's rules: who gets a port to the terminal host, when, and what each window hears about the host.
// The ipcMain glue is terminal-port-main.ts; the page's side is in preload-main.ts. The rules are in
// pod-docs/sprints/host-core.md (§5) and pod-docs/feature-details/desktop.md (Terminal host).

import { senderAllowed, type BridgeCaller } from './folder-bridge.ts'
import type { PtyHostStarter, StarterEvent, StarterState } from './pty-host-starter.ts'

/** Page → main: asks for a port, with the preload's request number. */
export const TERMINAL_CONNECT_CHANNEL = 'openaflow:terminal-connect'
/** Main → preload: the port, with `{ request }`. */
export const TERMINAL_PORT_CHANNEL = 'openaflow:terminal-port'
/** Main → every window: a TerminalHostState. */
export const TERMINAL_STATE_CHANNEL = 'openaflow:terminal-host'
/** The `window` message that carries the port to the page, in `ports[0]`. */
export const PAGE_PORT_MESSAGE = 'openaflow:terminal-port'

/** Page → main: the host's state now, for a banner at page load. */
export const TERMINAL_HOST_STATE_CHANNEL = 'openaflow:terminal-host-state'

export const PORT_WAIT_MS = 20_000
const UNAVAILABLE = 'terminals unavailable'

export type TerminalHostState = 'ready' | 'unresponsive' | 'restarted' | 'failed'
export type PortReply = { ok: true } | { error: 'forbidden' | 'terminals unavailable' }
/** `terminalHostState()`'s answer: no `restarted`, which is an event, not a state. */
export type HostStateWord = 'starting' | 'ready' | 'unresponsive' | 'failed'
export type HostStateReply = { state: HostStateWord } | { error: 'forbidden' }

const HOST_STATES: readonly unknown[] = ['starting', 'ready', 'unresponsive', 'failed'] satisfies HostStateWord[]

/** Before the first ready, and during a restart, `starting`; after `failed` or the quit's stop, `failed`. */
export function hostStateOf(s: StarterState): HostStateWord {
  if (s === 'ready' || s === 'unresponsive') return s
  if (s === 'failed' || s === 'stopped') return 'failed'
  return 'starting'
}

/** The preload's side: the state, or a rejection with `forbidden` for anything else. */
export function readHostState(reply: unknown): HostStateWord {
  const state = typeof reply === 'object' && reply !== null ? (reply as { state?: unknown }).state : undefined
  if (HOST_STATES.includes(state)) return state as HostStateWord
  throw new Error('forbidden')
}

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
  /** The host's state now, for the app window's main frame only. */
  hostState(caller: BridgeCaller<W>): HostStateReply
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
    hostState: (caller) => (allowed(caller) ? { state: hostStateOf(o.starter.state()) } : { error: 'forbidden' }),
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
  deliver(port: P): Promise<void>
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
      void o.deliver(port).then(done)
    },
  }
}

/**
 * The preload's posts of ports to the page, as §5's `{ type: 'openaflow:terminal-port' }` with the port in `ports[0]`.
 * The preload's world sees a posted message before the page's world does, so `watch` sets a one-time listener in the
 * page's world that ends after that message's dispatch, when every page listener has run. One delivery at a time, so
 * each watch sees its own message.
 */
export function createDeliveries<P>(o: {
  watch(): Promise<void>
  post(message: { type: typeof PAGE_PORT_MESSAGE }, port: P): void
}): { deliver(port: P): Promise<void> } {
  let last: Promise<void> = Promise.resolve()
  return {
    deliver(port) {
      const next = last.then(async () => {
        const seen = o.watch()
        o.post({ type: PAGE_PORT_MESSAGE }, port)
        try {
          await seen
        } catch {
          // No page world to watch (a closed or navigated frame): the post is all there is.
        }
      })
      last = next
      return next
    },
  }
}

/** The code `watch` runs in the page's world. A message that never comes ends the watch after 1 s, so nothing hangs. */
export const WATCH_PAGE_PORT = `new Promise((resolve) => {
  const end = () => {
    window.removeEventListener('message', seen)
    clearTimeout(limit)
    setTimeout(resolve, 0)
  }
  const seen = (e) => {
    if (e.data && e.data.type === ${JSON.stringify(PAGE_PORT_MESSAGE)}) end()
  }
  const limit = setTimeout(end, 1000)
  window.addEventListener('message', seen)
})`
