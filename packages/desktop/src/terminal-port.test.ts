import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { BridgeCaller } from './folder-bridge.ts'
import type { StarterEvent, StarterState } from './pty-host-starter.ts'
import { createPortRequests, createTerminalLink, PORT_WAIT_MS, type PortReply, type TerminalHostState } from './terminal-port.ts'
import { originOf } from './window-rules.ts'

type Win = { id: number }
type Port = { name: string }
const WIN: Win = { id: 1 }
const ORIGIN = originOf(3130)
const PAGE = `${ORIGIN}/#/repo/plan`

function fakeStarter(initial: StarterState) {
  const listeners = new Set<(e: StarterEvent) => void>()
  const s = {
    current: initial,
    connected: [] as unknown[],
    state: () => s.current,
    onEvent(fn: (e: StarterEvent) => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    connect(port: unknown) {
      if (s.current !== 'ready' && s.current !== 'unresponsive') return false
      s.connected.push(port)
      return true
    },
    emit(e: StarterEvent) {
      if (e.type === 'ready' || e.type === 'responsive') s.current = 'ready'
      if (e.type === 'unresponsive') s.current = 'unresponsive'
      if (e.type === 'crashed') s.current = 'starting'
      if (e.type === 'failed') s.current = 'failed'
      for (const fn of [...listeners]) fn(e)
    },
  }
  return s
}

function setup(o: { state?: StarterState; origin?: string | undefined; win?: Win | undefined } = {}) {
  const starter = fakeStarter(o.state ?? 'ready')
  const env = { origin: 'origin' in o ? o.origin : ORIGIN, win: 'win' in o ? o.win : WIN }
  let n = 0
  const channel = vi.fn(() => {
    n++
    return { host: { name: `host-${n}` }, page: { name: `page-${n}` } }
  })
  const broadcast = vi.fn<(state: TerminalHostState) => void>()
  const link = createTerminalLink<Win, Port>({ starter, origin: () => env.origin, appWindow: () => env.win, channel, broadcast })
  const give = vi.fn<(port: Port) => void>()
  return { starter, env, channel, broadcast, link, give }
}
const caller = (o: Partial<BridgeCaller<Win>> = {}): BridgeCaller<Win> => ({ window: WIN, isMainFrame: true, url: PAGE, ...o })
const track = (p: Promise<PortReply>) => {
  const out: { reply?: PortReply } = {}
  void p.then((reply) => (out.reply = reply))
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the terminal link', () => {
  test('sender rule', async () => {
    const ok = setup()
    expect(await ok.link.request(caller(), ok.give)).toEqual({ ok: true })
    expect(ok.give).toHaveBeenCalledWith({ name: 'page-1' })
    expect(ok.starter.connected).toEqual([{ name: 'host-1' }])
    // The bare root counts too.
    expect(await ok.link.request(caller({ url: `${ORIGIN}/` }), ok.give)).toEqual({ ok: true })

    // The folder bridge's rule, case by case.
    const refused: Array<[string, BridgeCaller<Win>, { origin?: string | undefined; win?: Win | undefined }?]> = [
      ['another port', caller({ url: `${originOf(3131)}/` })],
      ['localhost for 127.0.0.1', caller({ url: 'http://localhost:3130/' })],
      ['https on the same port', caller({ url: 'https://127.0.0.1:3130/' })],
      ['file:', caller({ url: 'file:///C:/x/index.html' })],
      ['about:blank', caller({ url: 'about:blank' })],
      ['an empty url', caller({ url: '' })],
      ['not a url', caller({ url: 'not a url' })],
      ['a subframe', caller({ isMainFrame: false })],
      ['no window', caller({ window: undefined })],
      ['another window', caller({ window: { id: 2 } })],
      ['no origin yet', caller(), { origin: undefined }],
      ['the app window is closed', caller(), { win: undefined }],
    ]
    for (const [name, c, o] of refused) {
      const s = setup(o)
      expect(await s.link.request(c, s.give), name).toEqual({ error: 'forbidden' })
      expect(s.give, name).not.toHaveBeenCalled()
      expect(s.channel, name).not.toHaveBeenCalled()
      expect(s.starter.connected, name).toEqual([])
    }
    // A refused caller is refused at once, even when the host is not ready.
    const early = setup({ state: 'starting' })
    expect(await early.link.request(caller({ url: 'about:blank' }), early.give)).toEqual({ error: 'forbidden' })
  })

  test('port request timing', async () => {
    // Before ready: it waits, and the port comes at ready.
    const s = setup({ state: 'starting' })
    const waiting = track(s.link.request(caller(), s.give))
    await vi.advanceTimersByTimeAsync(PORT_WAIT_MS - 1)
    expect(waiting.reply).toBeUndefined()
    expect(s.channel).not.toHaveBeenCalled()
    s.starter.emit({ type: 'ready', restarted: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting.reply).toEqual({ ok: true })
    expect(s.give).toHaveBeenCalledOnce()
    // The timer is gone: nothing answers twice.
    await vi.advanceTimersByTimeAsync(PORT_WAIT_MS)
    expect(s.give).toHaveBeenCalledOnce()

    // No ready in 20 s.
    const t = setup({ state: 'idle' })
    const late = track(t.link.request(caller(), t.give))
    await vi.advanceTimersByTimeAsync(PORT_WAIT_MS - 1)
    expect(late.reply).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(late.reply).toEqual({ error: 'terminals unavailable' })
    // A ready after the time out gives that request nothing.
    t.starter.emit({ type: 'ready', restarted: false })
    expect(t.give).not.toHaveBeenCalled()

    // After failed: at once.
    const f = setup({ state: 'failed' })
    expect(await f.link.request(caller(), f.give)).toEqual({ error: 'terminals unavailable' })
    const stopped = setup({ state: 'stopped' })
    expect(await stopped.link.request(caller(), stopped.give)).toEqual({ error: 'terminals unavailable' })

    // Failed during the wait answers at once.
    const g = setup({ state: 'starting' })
    const pending = track(g.link.request(caller(), g.give))
    g.starter.emit({ type: 'crashed', lost: [], restartsLeft: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(pending.reply).toBeUndefined()
    g.starter.emit({ type: 'failed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(pending.reply).toEqual({ error: 'terminals unavailable' })

    // A waiting request survives a crash and gets the restarted host's port.
    const r = setup({ state: 'starting' })
    const across = track(r.link.request(caller(), r.give))
    r.starter.emit({ type: 'crashed', lost: [], restartsLeft: 4 })
    r.starter.emit({ type: 'ready', restarted: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(across.reply).toEqual({ ok: true })

    // The sender is checked again after the wait: the window went to another origin meanwhile.
    const n = setup({ state: 'starting' })
    const moved = track(n.link.request(caller(), n.give))
    n.env.origin = originOf(3140)
    n.starter.emit({ type: 'ready', restarted: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(moved.reply).toEqual({ error: 'forbidden' })
    expect(n.give).not.toHaveBeenCalled()

    // An unresponsive host still gets the port: it may only be busy.
    const u = setup({ state: 'unresponsive' })
    expect(await u.link.request(caller(), u.give)).toEqual({ ok: true })
  })

  test('a restart tells every window', () => {
    const s = setup({ state: 'starting' })
    const events: StarterEvent[] = [
      { type: 'ready', restarted: false },
      { type: 'unresponsive' },
      { type: 'responsive' },
      { type: 'crashed', lost: ['a'], restartsLeft: 4 },
      { type: 'ready', restarted: true },
      { type: 'crashed', lost: [], restartsLeft: 0 },
      { type: 'failed' },
    ]
    for (const e of events) s.starter.emit(e)
    // §5 has four states: a host that beats again reads as ready, and a crash says nothing until the restart is ready.
    expect(s.broadcast.mock.calls.map(([state]) => state)).toEqual(['ready', 'unresponsive', 'ready', 'restarted', 'failed'])
  })
})

describe('the preload side', () => {
  const setupPreload = (reply: () => Promise<unknown>) => {
    const delivered: Array<[Port, number]> = []
    let deliver!: () => void
    const requests = createPortRequests<Port>({
      invoke: vi.fn(reply),
      deliver: (port, id) => {
        delivered.push([port, id])
        return new Promise<void>((resolve) => (deliver = resolve))
      },
    })
    return { requests, delivered, done: () => deliver() }
  }

  test('connect resolves only after the page has the port', async () => {
    const s = setupPreload(async () => ({ ok: true }))
    let resolved = false
    const p = s.requests.connect().then(() => (resolved = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(false)
    s.requests.receive(1, { name: 'p' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.delivered).toEqual([[{ name: 'p' }, 1]])
    expect(resolved).toBe(false)
    s.done()
    await p
    expect(resolved).toBe(true)
  })

  test('a port that comes before the reply, and a port for no request', async () => {
    let answer!: (v: unknown) => void
    const s = setupPreload(() => new Promise((r) => (answer = r)))
    const p = s.requests.connect()
    s.requests.receive(1, { name: 'early' })
    s.requests.receive(9, { name: 'stray' })
    s.requests.receive('1', { name: 'stray' })
    s.requests.receive(1, undefined)
    await vi.advanceTimersByTimeAsync(0)
    s.done()
    answer({ ok: true })
    await p
    expect(s.delivered).toEqual([[{ name: 'early' }, 1]])
  })

  test('errors keep their word', async () => {
    await expect(setupPreload(async () => ({ error: 'forbidden' })).requests.connect()).rejects.toThrow(/^forbidden$/)
    await expect(setupPreload(async () => ({ error: 'terminals unavailable' })).requests.connect()).rejects.toThrow(/^terminals unavailable$/)
    for (const odd of [undefined, null, 'ok', {}, { ok: false }, { error: 'other' }]) {
      await expect(setupPreload(async () => odd).requests.connect(), JSON.stringify(odd)).rejects.toThrow(/^terminals unavailable$/)
    }
    // No handler, a closed window: Electron's own text never reaches the page.
    await expect(setupPreload(() => Promise.reject(new Error('No handler registered'))).requests.connect()).rejects.toThrow(/^terminals unavailable$/)
  })
})
