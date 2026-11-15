import { describe, expect, test, vi } from 'vitest'
import { createQuitFlow } from './quit-flow.ts'

type Result = 'stopped' | 'killed' | 'not running'

function setup(stopImpl?: () => Promise<Result>) {
  let finish!: (r: Result) => void
  const stop = vi.fn(stopImpl ?? (() => new Promise<Result>((resolve) => (finish = resolve))))
  const hide = vi.fn()
  const quit = vi.fn()
  const flow = createQuitFlow({ stops: [stop], hide, quit })
  const event = () => ({ preventDefault: vi.fn() })
  return { stop, hide, quit, flow, event, finish: (r: Result) => finish(r) }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('quit', () => {
  test('quit waits for the server', async () => {
    const s = setup()

    const first = s.event()
    s.flow.beforeQuit(first)
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(s.hide).toHaveBeenCalledOnce()
    expect(s.stop).toHaveBeenCalledOnce()
    expect(s.quit).not.toHaveBeenCalled()

    // A repeat during the stop does nothing and never forces a quit.
    const repeat = s.event()
    s.flow.beforeQuit(repeat)
    expect(repeat.preventDefault).toHaveBeenCalledOnce()
    expect(s.stop).toHaveBeenCalledOnce()
    expect(s.hide).toHaveBeenCalledOnce()
    await settle()
    expect(s.quit).not.toHaveBeenCalled()

    s.finish('stopped')
    await settle()
    expect(s.quit).toHaveBeenCalledOnce()

    // The quit that follows goes through.
    const last = s.event()
    s.flow.beforeQuit(last)
    expect(last.preventDefault).not.toHaveBeenCalled()
    expect(s.stop).toHaveBeenCalledOnce()
    expect(s.quit).toHaveBeenCalledOnce()

    // Killed and not running quit too.
    for (const result of ['killed', 'not running'] as const) {
      const other = setup()
      other.flow.beforeQuit(other.event())
      other.finish(result)
      await settle()
      expect(other.quit).toHaveBeenCalledOnce()
    }
  })

  test('a failed stop or a failed hide still quits', async () => {
    const s = setup(() => Promise.reject(new Error('no')))
    s.flow.beforeQuit(s.event())
    await settle()
    expect(s.quit).toHaveBeenCalledOnce()

    const stop = vi.fn(async () => 'stopped' as const)
    const quit = vi.fn()
    const flow = createQuitFlow({
      stops: [stop],
      quit,
      hide: () => {
        throw new Error('window gone')
      },
    })
    flow.beforeQuit({ preventDefault: vi.fn() })
    await settle()
    expect(stop).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })

  test('a quit stops the server and the terminal host together', async () => {
    let endServer!: () => void
    let endHost!: () => void
    const server = vi.fn(() => new Promise<Result>((resolve) => (endServer = () => resolve('stopped'))))
    const host = vi.fn(() => new Promise<Result>((resolve) => (endHost = () => resolve('killed'))))
    const quit = vi.fn()
    const flow = createQuitFlow({ stops: [server, host], hide: vi.fn(), quit })
    flow.beforeQuit({ preventDefault: vi.fn() })
    // Both stops start at once: the host's does not wait for the server's 80 s.
    expect(server).toHaveBeenCalledOnce()
    expect(host).toHaveBeenCalledOnce()
    endHost()
    await settle()
    expect(quit).not.toHaveBeenCalled()
    endServer()
    await settle()
    expect(quit).toHaveBeenCalledOnce()

    // The same the other way round.
    const s = setup()
    let endOther!: () => void
    const other = vi.fn(() => new Promise<Result>((resolve) => (endOther = () => resolve('stopped'))))
    const both = createQuitFlow({ stops: [s.stop, other], hide: vi.fn(), quit: s.quit })
    both.beforeQuit(s.event())
    s.finish('stopped')
    await settle()
    expect(s.quit).not.toHaveBeenCalled()
    endOther()
    await settle()
    expect(s.quit).toHaveBeenCalledOnce()

    // One stop that throws or rejects keeps neither the other stop nor the quit from going on.
    for (const bad of [
      () => {
        throw new Error('sync')
      },
      () => Promise.reject(new Error('async')),
    ]) {
      let endGood!: () => void
      const good = vi.fn(() => new Promise<Result>((resolve) => (endGood = () => resolve('stopped'))))
      const q = vi.fn()
      const f = createQuitFlow({ stops: [bad, good], hide: vi.fn(), quit: q })
      f.beforeQuit({ preventDefault: vi.fn() })
      expect(good).toHaveBeenCalledOnce()
      await settle()
      expect(q).not.toHaveBeenCalled()
      endGood()
      await settle()
      expect(q).toHaveBeenCalledOnce()
    }
  })

  test("a Windows shutdown doesn't wait", async () => {
    const s = setup()
    s.flow.sessionEnd()
    const e = s.event()
    s.flow.beforeQuit(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(s.stop).not.toHaveBeenCalled()
    expect(s.hide).not.toHaveBeenCalled()
    expect(s.quit).not.toHaveBeenCalled()
  })

  test('a session end during a stop lets the quit through', async () => {
    const s = setup()
    s.flow.beforeQuit(s.event())
    s.flow.sessionEnd()
    const e = s.event()
    s.flow.beforeQuit(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(s.stop).toHaveBeenCalledOnce()
  })
})
