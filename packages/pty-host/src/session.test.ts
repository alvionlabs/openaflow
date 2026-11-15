import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { HostToWindow } from './protocol.ts'
import { createSession, linkPort, plainText, type SessionPty, type WindowPort } from './session.ts'

// A session with a fake pty and the real headless terminal: the parser's order is what these tests are about.

function fakePty() {
  const calls: string[] = []
  const pty: SessionPty & { calls: string[]; written: string[] } = {
    calls,
    written: [],
    write: (data) => void pty.written.push(data),
    resize: (cols, rows) => void calls.push(`resize ${cols}x${rows}`),
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
  }
  return pty
}

/** A stand-in for Electron's MessagePortMain. */
function fakePort() {
  const on: { message: ((e: { data: unknown }) => void)[]; close: (() => void)[] } = { message: [], close: [] }
  const got: HostToWindow[] = []
  const port: WindowPort = {
    on: (event: 'message' | 'close', fn: never) => void on[event].push(fn),
    start: () => {},
    postMessage: (m) => void got.push(m as HostToWindow),
  }
  return { port, got, close: () => on.close.forEach((fn) => fn()), send: (data: unknown) => on.message.forEach((fn) => fn({ data })) }
}

afterEach(() => {
  vi.useRealTimers()
})

function setup(o: { scrollback?: number; cols?: number; rows?: number } = {}) {
  const pty = fakePty()
  const session = createSession({ id: 'run-1', pty, cols: o.cols ?? 80, rows: o.rows ?? 24, scrollback: o.scrollback ?? 1_000 })
  const window = () => {
    const p = fakePort()
    const link = linkPort(p.port, () => {})
    return { ...p, link }
  }
  /** Resolves once the parser has taken every chunk written so far. */
  const settled = () => new Promise<string | null>((r) => session.snapshot(r))
  return { pty, session, window, settled }
}

const dataOf = (got: HostToWindow[]) => got.filter((m) => m.type === 'data').map((m) => (m as { data: string }).data).join('')
const unacked = (got: HostToWindow[]) => dataOf(got).length

/** What a window shows after it writes the replay and data it got into its own terminal. */
async function render(got: HostToWindow[], o: { cols: number; rows: number }) {
  const view = new Terminal({ cols: o.cols, rows: o.rows, scrollback: 10_000, allowProposedApi: true })
  for (const m of got) if (m.type === 'replay' || m.type === 'data') view.write(m.data)
  await new Promise<void>((r) => view.write('', r))
  const text = plainText(view)
  view.dispose()
  return text
}

describe('session', () => {
  test('attach mid-stream gives every line once and in order', async () => {
    const { session, window, settled } = setup()
    const lines = Array.from({ length: 113 }, (_, i) => `line ${i + 1}`)
    for (const line of lines.slice(0, 50)) session.output(`${line}\r\n`)
    const w = window()
    session.attach(w.link)
    // In the same tick as the attach, before the parser has reached it.
    for (const line of lines.slice(50, 60)) session.output(`${line}\r\n`)
    await new Promise((r) => setTimeout(r, 0))
    for (const line of lines.slice(60)) session.output(`${line}\r\n`)
    await settled()

    expect(w.got[0]?.type).toBe('replay')
    expect(w.got.filter((m) => m.type === 'replay')).toHaveLength(1)
    // Each chunk sent after the attach comes live, once, in order.
    expect(dataOf(w.got)).toBe(lines.slice(50).map((l) => `${l}\r\n`).join(''))
    expect(await render(w.got, { cols: 80, rows: 24 })).toBe(lines.join('\n'))
  })

  test('a second attach from the same port replays again and never doubles the data', async () => {
    const { session, window, settled } = setup()
    session.output('one\r\n')
    const w = window()
    // Twice before the first replay is ready: one replay.
    session.attach(w.link)
    session.attach(w.link)
    await settled()
    expect(w.got.map((m) => m.type)).toEqual(['replay'])
    // Again once live: a new replay, and live data goes out once.
    session.attach(w.link)
    session.output('two\r\n')
    await settled()
    expect(w.got.map((m) => m.type)).toEqual(['replay', 'replay', 'data'])
    expect(dataOf(w.got)).toBe('two\r\n')
  })

  test('each port gets data until it detaches or closes', async () => {
    const { session, window, settled } = setup()
    const [a, b, c] = [window(), window(), window()]
    for (const w of [a, b, c]) session.attach(w.link)
    session.output('first\r\n')
    await settled()
    for (const w of [a, b, c]) expect(dataOf(w.got)).toBe('first\r\n')

    session.detach(b.link)
    c.close()
    session.output('second\r\n')
    await settled()
    expect(dataOf(a.got)).toBe('first\r\nsecond\r\n')
    expect(dataOf(b.got)).toBe('first\r\n')
    expect(dataOf(c.got)).toBe('first\r\n')
  })

  test('a detach or close before the replay is ready attaches nothing', async () => {
    const { session, window, settled } = setup()
    const [a, b] = [window(), window()]
    session.output('x\r\n')
    session.attach(a.link)
    session.attach(b.link)
    session.detach(a.link)
    b.close()
    session.output('y\r\n')
    await settled()
    expect(a.got).toEqual([])
    expect(b.got).toEqual([])
  })

  test('exit reaches each port after its data; a later attach gets replay, then exit', async () => {
    const { session, window, settled, pty } = setup()
    const a = window()
    session.attach(a.link)
    session.output('bye\r\n')
    session.ended(3)
    // Input and resize after the exit go nowhere.
    session.input('late')
    expect(session.resize(100, 30)).toBeUndefined()
    await settled()
    expect(a.got.map((m) => m.type)).toEqual(['replay', 'data', 'exit'])
    expect(a.got.at(-1)).toEqual({ type: 'exit', id: 'run-1', exitCode: 3 })
    expect(pty.written).toEqual([])
    expect(pty.calls).toEqual([])

    const b = window()
    session.attach(b.link)
    await settled()
    expect(b.got.map((m) => m.type)).toEqual(['replay', 'exit'])
    expect(await render(b.got, { cols: 80, rows: 24 })).toBe('bye')
  })

  test('input goes to the pty', () => {
    const { session, pty } = setup()
    session.input('ls\r')
    expect(pty.written).toEqual(['ls\r'])
  })

  test('resize bounds', async () => {
    const { session, pty, settled } = setup()
    for (const [cols, rows] of [[1, 24], [501, 24], [80, 0], [80, 201], [80.5, 24], [80, Number.NaN]] as const) {
      expect(session.resize(cols, rows), `${cols}x${rows}`).toBe('bad resize')
    }
    expect(pty.calls).toEqual([])
    expect(session.resize(2, 1)).toBeUndefined()
    expect(session.resize(500, 200)).toBeUndefined()
    expect(pty.calls).toEqual(['resize 2x1', 'resize 500x200'])
    // The buffer resizes too: a line as wide as the new screen stays one line.
    session.output(`${'a'.repeat(500)}\r\n`)
    expect(await settled()).toBe('a'.repeat(500))
  })

  test('a pty that throws on write or resize never throws out of the session', () => {
    const { session, pty } = setup()
    pty.write = () => {
      throw new Error('closed')
    }
    pty.resize = () => {
      throw new Error('closed')
    }
    expect(() => session.input('x')).not.toThrow()
    expect(() => session.resize(100, 30)).not.toThrow()
  })

  describe('flow control', () => {
    test('output pauses past 100,000 unacked characters and resumes under 5,000', async () => {
      const { session, window, settled, pty } = setup()
      const a = window()
      session.attach(a.link)
      await settled()
      session.output('x'.repeat(100_000))
      await settled()
      // Exactly 100,000 is not over.
      expect(pty.calls).toEqual([])
      session.output('y')
      await settled()
      expect(unacked(a.got)).toBe(100_001)
      expect(pty.calls).toEqual(['pause'])
      // More output while paused does not pause again.
      session.output('z')
      await settled()
      expect(pty.calls).toEqual(['pause'])

      session.ack(a.link, 95_002) // 5,000 left: not under.
      expect(pty.calls).toEqual(['pause'])
      session.ack(a.link, 1) // 4,999.
      expect(pty.calls).toEqual(['pause', 'resume'])
      // An ack over the count stays at 0, and a later 100,001 pauses again.
      session.ack(a.link, 1_000_000)
      session.output('w'.repeat(100_001))
      await settled()
      expect(pty.calls).toEqual(['pause', 'resume', 'pause'])
    })

    test('any port over pauses; all must be under to resume; a closed or detached port releases it', async () => {
      const { session, window, settled, pty } = setup()
      const [a, b, c] = [window(), window(), window()]
      for (const w of [a, b, c]) session.attach(w.link)
      session.output('x'.repeat(100_001))
      await settled()
      expect(pty.calls).toEqual(['pause'])
      session.ack(a.link, 100_001)
      expect(pty.calls).toEqual(['pause'])
      b.close()
      expect(pty.calls).toEqual(['pause'])
      session.detach(c.link)
      expect(pty.calls).toEqual(['pause', 'resume'])
    })

    test('the replay does not count', async () => {
      const { session, window, settled, pty } = setup({ scrollback: 5_000 })
      session.output('x'.repeat(150_000))
      await settled()
      const a = window()
      session.attach(a.link)
      await settled()
      expect((a.got[0] as { data: string }).data.length).toBeGreaterThan(100_000)
      expect(pty.calls).toEqual([])
    })

    test('with no port attached output never pauses', async () => {
      const { session, settled, pty } = setup()
      session.output('x'.repeat(200_000))
      await settled()
      expect(pty.calls).toEqual([])
    })

    test('stale port', async () => {
      vi.useFakeTimers()
      const { session, window, pty } = setup()
      const settle = () => vi.advanceTimersByTimeAsync(0)
      const [stale, healthy] = [window(), window()]
      session.attach(stale.link)
      session.attach(healthy.link)
      await settle()
      // Silent for a minute before it goes over: the silence counts from when it went over.
      await vi.advanceTimersByTimeAsync(60_000)
      session.output('x'.repeat(100_001))
      await settle()
      expect(pty.calls).toEqual(['pause'])
      healthy.send({ type: 'ack' })
      session.ack(healthy.link, 100_001)
      expect(pty.calls).toEqual(['pause'])
      // At 29.9 s it still holds the pty; at 30 s it no longer does.
      await vi.advanceTimersByTimeAsync(29_900)
      expect(pty.calls).toEqual(['pause'])
      await vi.advanceTimersByTimeAsync(100)
      expect(pty.calls).toEqual(['pause', 'resume'])
      // It still gets data, and its count no longer pauses the pty.
      healthy.close()
      session.output('y'.repeat(200_000))
      await settle()
      expect(dataOf(stale.got)).toBe('x'.repeat(100_001) + 'y'.repeat(200_000))
      expect(pty.calls).toEqual(['pause', 'resume'])
      // Its next message, of any kind, counts it again from 0: 100,000 more is not over, 1 more is.
      stale.send({ type: 'input', id: 'run-1', data: '' })
      session.output('z'.repeat(100_000))
      await settle()
      expect(pty.calls).toEqual(['pause', 'resume'])
      session.output('z')
      await settle()
      expect(pty.calls).toEqual(['pause', 'resume', 'pause'])
      // A message resets the 30 s, so a port that speaks now and then never goes stale while over.
      await vi.advanceTimersByTimeAsync(20_000)
      stale.send({ type: 'ack' })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(pty.calls).toEqual(['pause', 'resume', 'pause'])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(pty.calls).toEqual(['pause', 'resume', 'pause', 'resume'])
      // After dispose no timer fires.
      stale.send({ type: 'ack' })
      session.output('w'.repeat(100_001))
      await settle()
      expect(pty.calls.at(-1)).toBe('pause')
      session.dispose()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(pty.calls).toHaveLength(5)
    })

    test('a paused session that ends never resumes', async () => {
      const { session, window, settled, pty } = setup()
      const a = window()
      session.attach(a.link)
      session.output('x'.repeat(100_001))
      await settled()
      session.ended(0)
      await settled()
      session.detach(a.link)
      expect(pty.calls).toEqual(['pause'])
    })
  })

  test('after dispose a port gets nothing more', async () => {
    const { session, window } = setup()
    const a = window()
    session.attach(a.link)
    await new Promise((r) => setTimeout(r, 10))
    session.dispose()
    session.output('x')
    session.ended(0)
    await new Promise((r) => setTimeout(r, 10))
    expect(a.got.map((m) => m.type)).toEqual(['replay'])
  })
})
