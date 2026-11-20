// The page's side of the terminal link (host-core §4 and §5). Plain TypeScript: the Terminal tab gives it
// handlers that write to xterm. One port serves every open session.

import type { TerminalBridge } from './desktop-bridge.ts'

export type TerminalHandlers = {
  /** The screen as it was; no ack. */
  replay(data: string): void
  /** Live output. Call `written` when the write has ended: the link then acks the chunk's length. */
  data(data: string, written: () => void): void
  exit(exitCode: number): void
  /** The host has no such session. */
  gone(): void
  /** The host cannot be used (refused, failed for good, or lost on a restart). */
  unavailable(): void
}

type Size = { cols: number; rows: number }
type Open = { size: Size; handlers: TerminalHandlers }
type Port = { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null }

export type TerminalLink = {
  open(id: string, size: Size, handlers: TerminalHandlers): Promise<void>
  input(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /** Sends `detach`; the handlers hear nothing more. */
  close(id: string): void
}

export function createTerminalLink(bridge: TerminalBridge, win: Window = globalThis.window): TerminalLink {
  const opens = new Map<string, Open>()
  let port: Port | undefined
  let connecting: Promise<boolean> | undefined

  // Listening starts now: the port's message comes before `connect()` resolves.
  win.addEventListener('message', (e) => {
    const m = e as MessageEvent
    if (m.source !== win) return
    if ((m.data as { type?: unknown } | null)?.type !== 'openaflow:terminal-port') return
    const next = m.ports?.[0] as unknown as Port | undefined
    if (next === undefined) return
    port = next
    next.onmessage = (ev) => hear(next, ev.data)
  })

  function hear(from: Port, raw: unknown): void {
    if (from !== port || typeof raw !== 'object' || raw === null) return
    const m = raw as { type?: unknown; id?: unknown; data?: unknown; exitCode?: unknown; error?: unknown }
    if (typeof m.id !== 'string') return
    const o = opens.get(m.id)
    if (o === undefined) return
    const id = m.id
    if (m.type === 'replay' && typeof m.data === 'string') o.handlers.replay(m.data)
    else if (m.type === 'data' && typeof m.data === 'string') {
      const chars = m.data.length
      let acked = false
      o.handlers.data(m.data, () => {
        if (acked || port !== from || !opens.has(id)) return
        acked = true
        from.postMessage({ type: 'ack', id, chars })
      })
    } else if (m.type === 'exit' && typeof m.exitCode === 'number') o.handlers.exit(m.exitCode)
    else if (m.type === 'error' && m.error === 'no session') {
      opens.delete(id)
      o.handlers.gone()
    }
  }

  /** True with a port; false after a refusal (every open session hears `unavailable`). */
  function connect(): Promise<boolean> {
    if (port !== undefined) return Promise.resolve(true)
    connecting ??= bridge.connect().then(
      () => port !== undefined,
      () => false,
    )
    const mine = connecting
    void mine.finally(() => {
      if (connecting === mine) connecting = undefined
    })
    return mine
  }

  function send(id: string, o: Open): void {
    port?.postMessage({ type: 'resize', id, cols: o.size.cols, rows: o.size.rows })
    port?.postMessage({ type: 'attach', id })
  }

  function unavailableAll(): void {
    const all = [...opens.values()]
    for (const o of all) o.handlers.unavailable()
  }

  bridge.onHostState((state) => {
    if (state === 'failed') {
      port = undefined
      unavailableAll()
    } else if (state === 'restarted') {
      // The old ports are dead; the page connects again.
      port = undefined
      connecting = undefined
      void connect().then((ok) => {
        if (!ok) return unavailableAll()
        for (const [id, o] of [...opens]) send(id, o)
      })
    }
  })

  return {
    async open(id, size, handlers) {
      const o: Open = { size, handlers }
      opens.set(id, o)
      const ok = await connect()
      if (opens.get(id) !== o) return // closed while connecting
      if (!ok) return handlers.unavailable()
      send(id, o)
    },
    input(id, data) {
      if (opens.has(id)) port?.postMessage({ type: 'input', id, data })
    },
    resize(id, cols, rows) {
      const o = opens.get(id)
      if (o === undefined) return
      o.size = { cols, rows }
      port?.postMessage({ type: 'resize', id, cols, rows })
    },
    close(id) {
      if (!opens.delete(id)) return
      port?.postMessage({ type: 'detach', id })
    },
  }
}
