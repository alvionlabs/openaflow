import { describe, expect, it, vi } from 'vitest'
import type { TerminalBridge } from './desktop-bridge.ts'
import { createTerminalLink, type TerminalHandlers } from './terminal-link.ts'

class FakePort {
  sent: Record<string, unknown>[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  postMessage(m: Record<string, unknown>) {
    this.sent.push(m)
  }
  /** The host sends a message to the page. */
  hear(m: Record<string, unknown>) {
    this.onmessage?.({ data: m })
  }
  types() {
    return this.sent.map((m) => m.type)
  }
}

function setup(opts: { reject?: Error } = {}) {
  const target = new EventTarget()
  const win = target as unknown as Window
  const ports: FakePort[] = []
  let hostState: ((s: 'ready' | 'unresponsive' | 'restarted' | 'failed') => void) | undefined
  let rejectWith = opts.reject
  const deliver = (port: FakePort, source: unknown = win) => {
    const e = new Event('message') as Event & { data: unknown; source: unknown; ports: unknown[] }
    e.data = { type: 'openaflow:terminal-port' }
    e.source = source
    e.ports = [port]
    target.dispatchEvent(e)
  }
  const bridge: TerminalBridge = {
    // As the preload does: the port's message comes before the promise resolves.
    connect: vi.fn(async () => {
      if (rejectWith) throw rejectWith
      const p = new FakePort()
      ports.push(p)
      deliver(p)
    }),
    onHostState: (fn) => {
      hostState = fn
      return () => {}
    },
  }
  const link = createTerminalLink(bridge, win)
  return {
    link,
    bridge,
    ports,
    deliver,
    win,
    state: (s: 'ready' | 'unresponsive' | 'restarted' | 'failed') => hostState!(s),
    setReject: (e: Error | undefined) => (rejectWith = e),
  }
}

function handlers(): TerminalHandlers & { log: string[]; done: Array<() => void> } {
  const log: string[] = []
  const done: Array<() => void> = []
  return {
    log,
    done,
    replay: (d) => void log.push(`replay:${d}`),
    data: (d, written) => {
      log.push(`data:${d}`)
      done.push(written)
    },
    exit: (c) => void log.push(`exit:${c}`),
    gone: () => void log.push('gone'),
    unavailable: () => void log.push('unavailable'),
  }
}

const SIZE = { cols: 100, rows: 30 }

describe('resize before attach', () => {
  it('open sends resize, then attach', async () => {
    const t = setup()
    await t.link.open('a', SIZE, handlers())
    expect(t.ports[0]!.sent).toEqual([
      { type: 'resize', id: 'a', cols: 100, rows: 30 },
      { type: 'attach', id: 'a' },
    ])
  })

  it('connects once for several opens', async () => {
    const t = setup()
    await Promise.all([t.link.open('a', SIZE, handlers()), t.link.open('b', SIZE, handlers())])
    expect(t.bridge.connect).toHaveBeenCalledTimes(1)
    expect(t.ports[0]!.types()).toEqual(['resize', 'attach', 'resize', 'attach'])
  })
})

describe('acks', () => {
  it('data is acked with its length after the write; replay never', async () => {
    const t = setup()
    const h = handlers()
    await t.link.open('a', SIZE, h)
    const port = t.ports[0]!
    port.sent.length = 0
    port.hear({ type: 'replay', id: 'a', data: 'old screen' })
    port.hear({ type: 'data', id: 'a', data: 'héllo😀' })
    expect(h.log).toEqual(['replay:old screen', 'data:héllo😀'])
    expect(port.sent).toEqual([]) // not acked before the write ends
    h.done[0]!()
    expect(port.sent).toEqual([{ type: 'ack', id: 'a', chars: 'héllo😀'.length }])
    h.done[0]!() // a second call does not ack twice
    expect(port.sent).toHaveLength(1)
  })

  it('routes by id', async () => {
    const t = setup()
    const a = handlers()
    const b = handlers()
    await t.link.open('a', SIZE, a)
    await t.link.open('b', SIZE, b)
    t.ports[0]!.hear({ type: 'data', id: 'b', data: 'x' })
    expect(a.log).toEqual([])
    expect(b.log).toEqual(['data:x'])
  })
})

describe('port source', () => {
  it('a port message from another source is ignored', async () => {
    const t = setup()
    const evil = new FakePort()
    t.deliver(evil, {})
    await t.link.open('a', SIZE, handlers())
    expect(evil.sent).toEqual([])
    expect(t.ports[0]!.types()).toEqual(['resize', 'attach'])
  })
})

describe('host restart', () => {
  it('restarted connects again and re-opens each open id at its last size', async () => {
    const t = setup()
    await t.link.open('a', SIZE, handlers())
    await t.link.open('b', SIZE, handlers())
    t.link.resize('b', 80, 20)
    t.state('restarted')
    await vi.waitFor(() => expect(t.ports).toHaveLength(2))
    await vi.waitFor(() => expect(t.ports[1]!.sent).toHaveLength(4))
    expect(t.ports[1]!.sent).toEqual([
      { type: 'resize', id: 'a', cols: 100, rows: 30 },
      { type: 'attach', id: 'a' },
      { type: 'resize', id: 'b', cols: 80, rows: 20 },
      { type: 'attach', id: 'b' },
    ])
  })

  it('a session that is gone after the restart calls gone, once, and is not re-opened again', async () => {
    const t = setup()
    const h = handlers()
    await t.link.open('a', SIZE, h)
    t.state('restarted')
    await vi.waitFor(() => expect(t.ports[1]?.types()).toEqual(['resize', 'attach']))
    t.ports[1]!.hear({ type: 'error', id: 'a', error: 'no session' })
    expect(h.log).toEqual(['gone'])
    t.state('restarted')
    await vi.waitFor(() => expect(t.ports).toHaveLength(3))
    await new Promise((r) => setTimeout(r, 10))
    expect(t.ports[2]!.sent).toEqual([])
  })

  it('failed calls unavailable on each open id', async () => {
    const t = setup()
    const h = handlers()
    await t.link.open('a', SIZE, h)
    t.state('failed')
    expect(h.log).toEqual(['unavailable'])
  })

  it('a failed re-connect after a restart calls unavailable', async () => {
    const t = setup()
    const h = handlers()
    await t.link.open('a', SIZE, h)
    t.setReject(new Error('terminals unavailable'))
    t.state('restarted')
    await vi.waitFor(() => expect(h.log).toEqual(['unavailable']))
  })
})

describe('close', () => {
  it('close sends detach and no more data reaches the handlers', async () => {
    const t = setup()
    const h = handlers()
    await t.link.open('a', SIZE, h)
    t.link.close('a')
    expect(t.ports[0]!.sent.at(-1)).toEqual({ type: 'detach', id: 'a' })
    t.ports[0]!.hear({ type: 'data', id: 'a', data: 'late' })
    t.ports[0]!.hear({ type: 'exit', id: 'a', exitCode: 0 })
    expect(h.log).toEqual([])
  })

  it('a closed id is not re-opened after a restart', async () => {
    const t = setup()
    await t.link.open('a', SIZE, handlers())
    t.link.close('a')
    t.state('restarted')
    await vi.waitFor(() => expect(t.ports).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 10))
    expect(t.ports[1]!.sent).toEqual([])
  })

  it('input and resize go to the port, and are dropped for an unopened id', async () => {
    const t = setup()
    await t.link.open('a', SIZE, handlers())
    t.link.input('a', 'ls\r')
    t.link.resize('a', 90, 25)
    t.link.input('zzz', 'x')
    expect(t.ports[0]!.sent.slice(2)).toEqual([
      { type: 'input', id: 'a', data: 'ls\r' },
      { type: 'resize', id: 'a', cols: 90, rows: 25 },
    ])
  })

  it('exit reaches the handler', async () => {
    const t = setup()
    const h = handlers()
    await t.link.open('a', SIZE, h)
    t.ports[0]!.hear({ type: 'exit', id: 'a', exitCode: 3 })
    expect(h.log).toEqual(['exit:3'])
  })
})

describe('connect refused', () => {
  it.each(['terminals unavailable', 'forbidden'])('a rejected connect (%s) calls unavailable', async (msg) => {
    const t = setup({ reject: new Error(msg) })
    const h = handlers()
    await t.link.open('a', SIZE, h)
    expect(h.log).toEqual(['unavailable'])
  })

  it('also for a page that loads after the host failed, on every open', async () => {
    const t = setup({ reject: new Error('terminals unavailable') })
    const h1 = handlers()
    const h2 = handlers()
    await t.link.open('a', SIZE, h1)
    await t.link.open('b', SIZE, h2)
    expect(h1.log).toEqual(['unavailable'])
    expect(h2.log).toEqual(['unavailable'])
  })

  it('a later open connects again after a refusal', async () => {
    const t = setup({ reject: new Error('terminals unavailable') })
    await t.link.open('a', SIZE, handlers())
    t.setReject(undefined)
    const h = handlers()
    await t.link.open('b', SIZE, h)
    expect(h.log).toEqual([])
    expect(t.ports[0]!.types()).toEqual(['resize', 'attach'])
  })
})
