// One session's terminal side: the headless terminal that keeps its screen, and the window ports attached to it.
// service.ts owns the pty's life (start, pid, exit to main); this file owns what each window sees. The rules are in
// pod-docs/sprints/host-core.md (§4).
//
// Order: the headless terminal parses writes in order and runs each write's callback after it parses that chunk.
// So live data goes to the ports from the write callback, and an attach adds its port from the callback of an empty
// write. A chunk written before the attach is in the replay; a chunk written after it is sent live. Each chunk
// reaches the port once, in order.

import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { FLOW, sizeOk, STALE_PORT_MS, type HostToWindow } from './protocol.ts'

/** The parts of a node-pty process that a session uses. Each may throw once the process has ended. */
export type SessionPty = { write(data: string): void; resize(cols: number, rows: number): void; pause(): void; resume(): void }

/** The shape of Electron's MessagePortMain that the host uses. */
export type WindowPort = {
  on(event: 'message', fn: (e: { data: unknown }) => void): unknown
  on(event: 'close', fn: () => void): unknown
  start(): void
  postMessage(message: unknown): void
}

/** One window's port, as the sessions see it. */
export type WindowLink = {
  post(m: HostToWindow): void
  onClose(fn: () => void): () => void
  /** When the port last sent a message, or was linked. */
  heardAt(): number
  /** Called on each message from the port, before it is handled. */
  onHeard(fn: () => void): () => void
}

export type Session = {
  /** Output from the pty. Output after `ended` is dropped. */
  output(data: string): void
  /** The pty ended. Each attached port gets `exit` after the data before it. */
  ended(exitCode: number): void
  attach(link: WindowLink): void
  detach(link: WindowLink): void
  ack(link: WindowLink, chars: number): void
  /** Ignored after the pty ends. */
  input(data: string): void
  /** `bad resize` outside 2–500 by 1–200. Ignored after the pty ends. */
  resize(cols: number, rows: number): 'bad resize' | undefined
  /** The screen and scrollback as plain lines, after every chunk written so far. */
  snapshot(fn: (text: string | null) => void): void
  dispose(): void
}

/** Wraps a window port. Call it once per port; it starts the port, as Electron's ports need. */
export function linkPort(port: WindowPort, onMessage: (data: unknown) => void): WindowLink {
  const closeFns = new Set<() => void>()
  const heardFns = new Set<() => void>()
  let closed = false
  let heardAt = Date.now()
  port.on('message', (e) => {
    heardAt = Date.now()
    for (const fn of [...heardFns]) fn()
    onMessage(e?.data)
  })
  port.on('close', () => {
    closed = true
    for (const fn of [...closeFns]) fn()
    closeFns.clear()
    heardFns.clear()
  })
  port.start()
  return {
    post(m) {
      if (closed) return
      try {
        port.postMessage(m)
      } catch {
        // A port that closed under us: its close event detaches it.
      }
    },
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }
      closeFns.add(fn)
      return () => closeFns.delete(fn)
    },
    heardAt: () => heardAt,
    onHeard(fn) {
      heardFns.add(fn)
      return () => heardFns.delete(fn)
    },
  }
}

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

const quietly = (fn: () => void) => {
  try {
    fn()
  } catch {
    // The pty has ended: its exit comes, or came, on its own.
  }
}

export function createSession(o: { id: string; pty: SessionPty; cols: number; rows: number; scrollback: number }): Session {
  const { id, pty } = o
  const term = new Terminal({ cols: o.cols, rows: o.rows, scrollback: o.scrollback, allowProposedApi: true })
  const serializer = new SerializeAddon()
  term.loadAddon(serializer)

  /**
   * `overSince`: when its count went over `FLOW.pauseAbove`. `stale`: over, and silent `STALE_PORT_MS` since then
   * and since its last message, so it no longer holds the pty. Its next message counts it again from 0.
   */
  type Attached = { unacked: number; off(): void; overSince?: number; stale: boolean }
  /** Ports that get live data, with the characters they have not acked. */
  const live = new Map<WindowLink, Attached>()
  /** Ports waiting for their replay. A newer attach or a detach replaces or drops the token. */
  const pending = new Map<WindowLink, { off(): void }>()
  let ended = false
  /** Set once the parser reaches the exit: every chunk before it has gone out. */
  let exitCode: number | undefined
  let disposed = false
  let paused = false
  /** While paused: the moment the next port over the limit goes stale. */
  let staleTimer: ReturnType<typeof setTimeout> | undefined

  const staleAt = (link: WindowLink, a: Attached) => Math.max(a.overSince ?? Infinity, link.heardAt()) + STALE_PORT_MS

  const balance = () => {
    clearTimeout(staleTimer)
    staleTimer = undefined
    if (ended || disposed) return
    const now = Date.now()
    for (const [link, a] of live) {
      if (a.unacked <= FLOW.pauseAbove) a.overSince = undefined
      else {
        a.overSince ??= now
        if (now >= staleAt(link, a)) a.stale = true
      }
    }
    const holding = [...live].filter(([, a]) => !a.stale)
    const counts = holding.map(([, a]) => a.unacked)
    if (!paused && counts.some((n) => n > FLOW.pauseAbove)) {
      paused = true
      quietly(() => pty.pause())
    } else if (paused && counts.every((n) => n < FLOW.resumeBelow)) {
      paused = false
      quietly(() => pty.resume())
    }
    if (!paused) return
    const next = Math.min(...holding.filter(([, a]) => a.overSince !== undefined).map(([link, a]) => staleAt(link, a)))
    if (Number.isFinite(next)) staleTimer = setTimeout(balance, Math.max(0, next - now))
  }

  const drop = (link: WindowLink) => {
    pending.get(link)?.off()
    pending.delete(link)
    live.get(link)?.off()
    live.delete(link)
  }

  const detach = (link: WindowLink) => {
    drop(link)
    balance()
  }

  return {
    output(data) {
      if (ended || disposed) return
      term.write(data, () => {
        if (disposed) return
        for (const [link, a] of live) {
          link.post({ type: 'data', id, data })
          a.unacked += data.length
        }
        balance()
      })
    },

    ended(code) {
      if (ended || disposed) return
      ended = true
      clearTimeout(staleTimer)
      term.write('', () => {
        if (disposed) return
        exitCode = code
        for (const link of live.keys()) link.post({ type: 'exit', id, exitCode: code })
        for (const a of live.values()) a.off()
        live.clear()
      })
    },

    attach(link) {
      if (disposed) return
      drop(link)
      const token = { off: link.onClose(() => detach(link)) }
      pending.set(link, token)
      balance()
      term.write('', () => {
        if (disposed || pending.get(link) !== token) return
        pending.delete(link)
        link.post({ type: 'replay', id, data: serializer.serialize() })
        if (exitCode !== undefined) {
          token.off()
          link.post({ type: 'exit', id, exitCode })
          return
        }
        const offHeard = link.onHeard(() => {
          const a = live.get(link)
          if (a === undefined || !a.stale) return
          a.stale = false
          a.unacked = 0
          a.overSince = undefined
          balance()
        })
        live.set(link, {
          unacked: 0,
          stale: false,
          off: () => {
            token.off()
            offHeard()
          },
        })
      })
    },

    detach,

    ack(link, chars) {
      const a = live.get(link)
      if (a === undefined) return
      a.unacked = Math.max(0, a.unacked - chars)
      balance()
    },

    input(data) {
      if (ended || disposed) return
      quietly(() => pty.write(data))
    },

    resize(cols, rows) {
      if (!sizeOk(cols, rows)) return 'bad resize'
      if (ended || disposed) return undefined
      quietly(() => pty.resize(cols, rows))
      term.resize(cols, rows)
      return undefined
    },

    snapshot(fn) {
      if (disposed) return fn(null)
      term.write('', () => fn(disposed ? null : plainText(term)))
    },

    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(staleTimer)
      for (const link of [...pending.keys(), ...live.keys()]) drop(link)
      term.dispose()
    },
  }
}
