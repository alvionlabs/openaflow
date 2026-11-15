import { describe, expect, test, vi } from 'vitest'
import { createQuitFlow, quitQuestion, type QuitAnswer, type QuitQuestion } from './quit-flow.ts'

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

/** A flow with sessions: each ask waits until the test answers it; each endAll until the test ends it. */
function withSessions(o: { live?: Array<{ label?: string }>; failed?: boolean } = {}) {
  const order: string[] = []
  const state = { live: o.live ?? [{ label: 'alpha-repo · alpha' }], failed: o.failed ?? false }
  const answers: Array<(a: QuitAnswer) => void> = []
  const asked: QuitQuestion[] = []
  const ends: Array<() => void> = []
  const stops: Array<() => void> = []
  const stop = vi.fn(() => {
    order.push('stop')
    return new Promise<Result>((resolve) => stops.push(() => resolve('stopped')))
  })
  const hide = vi.fn(() => void order.push('hide'))
  const quit = vi.fn(() => void order.push('quit'))
  const log = vi.fn()
  const sessions = {
    live: vi.fn(() => state.live),
    ask: vi.fn((q: QuitQuestion) => {
      order.push('ask')
      asked.push(q)
      return new Promise<QuitAnswer>((resolve) => answers.push(resolve))
    }),
    confirmed: vi.fn((count: number) => void order.push(`confirmed ${count}`)),
    silence: vi.fn(() => void order.push('silence')),
    endAll: vi.fn(() => {
      order.push('endAll')
      return new Promise<void>((resolve) =>
        ends.push(() => {
          // The roster marks every session ended.
          state.live = []
          resolve()
        }),
      )
    }),
    serverFailed: () => state.failed,
    log,
  }
  const flow = createQuitFlow({ stops: [stop], hide, quit, sessions })
  const event = () => ({ preventDefault: vi.fn() })
  return {
    flow,
    order,
    state,
    sessions,
    asked,
    stop,
    hide,
    quit,
    log,
    event,
    answer: (a: QuitAnswer) => answers.shift()!(a),
    endAll: () => ends.shift()!(),
    finishStops: () => stops.splice(0).forEach((f) => f()),
  }
}

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
    // No live session: no question, no end, and today's stops at once.
    const none = withSessions({ live: [] })
    const e = none.event()
    none.flow.beforeQuit(e)
    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(none.order).toEqual(['hide', 'stop'])
    none.finishStops()
    await settle()
    expect(none.order).toEqual(['hide', 'stop', 'quit'])
    expect(none.sessions.ask).not.toHaveBeenCalled()
    expect(none.sessions.endAll).not.toHaveBeenCalled()
    expect(none.sessions.confirmed).not.toHaveBeenCalled()
    expect(none.log).not.toHaveBeenCalled()

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

  test('quit with live sessions', async () => {
    // The words: one session, many, a session with no label, and more than ten.
    expect(quitQuestion(['alpha-repo · alpha'])).toEqual({
      message: '1 session is active. Quit ends it.',
      detail: 'alpha-repo · alpha',
      buttons: ['Quit and end sessions', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })
    expect(quitQuestion(['a · one', undefined, 'b · two'])).toMatchObject({
      message: '3 sessions are active. Quit ends them.',
      detail: 'a · one\na session\nb · two',
    })
    const twelve = Array.from({ length: 12 }, (_, i) => `repo · run ${i + 1}`)
    expect(quitQuestion(twelve).detail).toBe([...twelve.slice(0, 10), 'and 2 more'].join('\n'))
    expect(quitQuestion(twelve.slice(0, 11)).detail.split('\n').at(-1)).toBe('and 1 more')
    expect(quitQuestion(twelve.slice(0, 10)).detail.split('\n')).toHaveLength(10)

    const s = withSessions({ live: [{ label: 'alpha-repo · alpha' }, {}] })
    const first = s.event()
    s.flow.beforeQuit(first)
    expect(first.preventDefault).toHaveBeenCalledOnce()
    await settle()
    expect(s.asked).toEqual([quitQuestion(['alpha-repo · alpha', undefined])])
    // A quit while the dialog is open is ignored: held, with no second dialog.
    const during = s.event()
    s.flow.beforeQuit(during)
    expect(during.preventDefault).toHaveBeenCalledOnce()
    await settle()
    expect(s.sessions.ask).toHaveBeenCalledOnce()

    // Cancel: nothing changes. No silence, no overlay, no end, no hide, no stop, no quit.
    s.answer('cancel')
    await settle()
    expect(s.order).toEqual(['ask'])
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: quit asked about 2 sessions: cancel')

    // The next quit asks again.
    const again = s.event()
    s.flow.beforeQuit(again)
    expect(again.preventDefault).toHaveBeenCalledOnce()
    await settle()
    expect(s.sessions.ask).toHaveBeenCalledTimes(2)
    s.answer('cancel')
    await settle()
    expect(s.order).toEqual(['ask', 'ask'])

    // A dialog that fails reads as Cancel: nothing ends without a yes.
    s.sessions.ask.mockImplementationOnce(() => Promise.reject(new Error('no display')))
    s.flow.beforeQuit(s.event())
    await settle()
    expect(s.order).toEqual(['ask', 'ask'])
    expect(s.log).toHaveBeenLastCalledWith('openaflow desktop: quit question failed, so nothing ends: no display')
    // And the quit after it asks again.
    s.flow.beforeQuit(s.event())
    await settle()
    expect(s.sessions.ask).toHaveBeenCalledTimes(4)
  })

  test('confirm ends sessions first', async () => {
    const s = withSessions({ live: [{ label: 'a · one' }, { label: 'b · two' }, {}] })
    s.flow.beforeQuit(s.event())
    await settle()
    s.answer('end')
    await settle()
    // The windows hear the count and the relay goes quiet, then the ends start; nothing hides or stops yet.
    expect(s.order).toEqual(['ask', 'confirmed 3', 'endAll'])
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: quit asked about 3 sessions: end')
    // A quit during the ends is held and asks nothing.
    const during = s.event()
    s.flow.beforeQuit(during)
    expect(during.preventDefault).toHaveBeenCalledOnce()
    await settle()
    expect(s.order).toEqual(['ask', 'confirmed 3', 'endAll'])

    s.endAll()
    await settle()
    expect(s.order).toEqual(['ask', 'confirmed 3', 'endAll', 'hide', 'stop'])
    s.finishStops()
    await settle()
    expect(s.order).toEqual(['ask', 'confirmed 3', 'endAll', 'hide', 'stop', 'quit'])
    // The quit that follows goes through.
    const last = s.event()
    s.flow.beforeQuit(last)
    expect(last.preventDefault).not.toHaveBeenCalled()

    // An endAll that rejects still quits.
    const r = withSessions()
    r.sessions.endAll.mockImplementationOnce(() => {
      r.order.push('endAll')
      return Promise.reject(new Error('broken'))
    })
    r.flow.beforeQuit(r.event())
    await settle()
    r.answer('end')
    await settle()
    r.finishStops()
    await settle()
    expect(r.order).toEqual(['ask', 'confirmed 1', 'endAll', 'hide', 'stop', 'quit'])
  })

  test('server failed', async () => {
    const s = withSessions({ live: [{ label: 'a · one' }, { label: 'b · two' }], failed: true })
    s.flow.beforeQuit(s.event())
    await settle()
    // The error box came first: no dialog, and the sessions end as after a confirm.
    expect(s.sessions.ask).not.toHaveBeenCalled()
    expect(s.order).toEqual(['confirmed 2', 'endAll'])
    s.endAll()
    await settle()
    s.finishStops()
    await settle()
    expect(s.order).toEqual(['confirmed 2', 'endAll', 'hide', 'stop', 'quit'])

    // endSessions after the failure asks nothing either.
    const t = withSessions({ failed: true })
    const ended = t.flow.endSessions()
    await settle()
    expect(t.sessions.ask).not.toHaveBeenCalled()
    t.endAll()
    expect(await ended).toBe(true)
  })

  test('end sessions', async () => {
    // None live: true, no dialog, nothing ends.
    const none = withSessions({ live: [] })
    expect(await none.flow.endSessions()).toBe(true)
    expect(none.order).toEqual([])

    // Cancel: false, and nothing changes.
    const s = withSessions()
    const no = s.flow.endSessions()
    await settle()
    expect(s.asked).toEqual([quitQuestion(['alpha-repo · alpha'])])
    s.answer('cancel')
    expect(await no).toBe(false)
    expect(s.order).toEqual(['ask'])

    // Confirm: the overlay, the ends, then true. A second call while the first waits shares its answer.
    const yes = s.flow.endSessions()
    const twice = s.flow.endSessions()
    await settle()
    expect(s.sessions.ask).toHaveBeenCalledTimes(2)
    // A quit while this dialog is open is ignored too.
    const during = s.event()
    s.flow.beforeQuit(during)
    expect(during.preventDefault).toHaveBeenCalledOnce()
    s.answer('end')
    await settle()
    expect(s.order).toEqual(['ask', 'ask', 'confirmed 1', 'endAll'])
    s.endAll()
    expect(await yes).toBe(true)
    expect(await twice).toBe(true)
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: quit asked about 1 sessions: end')
    // The quit that came during the dialog stays ignored: the caller (Restart now) quits its own way.
    await settle()
    expect(s.order).toEqual(['ask', 'ask', 'confirmed 1', 'endAll'])

    // The quit after it asks nothing and stops at once.
    s.flow.beforeQuit(s.event())
    expect(s.order).toEqual(['ask', 'ask', 'confirmed 1', 'endAll', 'hide', 'stop'])
    s.finishStops()
    await settle()
    expect(s.quit).toHaveBeenCalledOnce()
    expect(s.sessions.ask).toHaveBeenCalledTimes(2)
  })

  test('session end', async () => {
    const s = withSessions()
    s.flow.sessionEnd()
    // No dialog; the relay goes quiet and the ends start; nothing waits for them.
    expect(s.order).toEqual(['silence', 'endAll'])
    const e = s.event()
    s.flow.beforeQuit(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    await settle()
    expect(s.sessions.ask).not.toHaveBeenCalled()
    expect(s.stop).not.toHaveBeenCalled()

    // During an open dialog: the quit goes through, and a late answer does nothing.
    const t = withSessions()
    t.flow.beforeQuit(t.event())
    await settle()
    t.flow.sessionEnd()
    expect(t.order).toEqual(['ask', 'silence', 'endAll'])
    t.answer('end')
    await settle()
    expect(t.order).toEqual(['ask', 'silence', 'endAll'])
    expect(t.quit).not.toHaveBeenCalled()
  })
})

/** The modules that close at a quit (the window flow, the notifier, the updater) hear only a quit that goes through. */
describe('the quit goes through', () => {
  const heard = (s: { flow: { onThrough(fn: () => void): void }; order: string[] }) => s.flow.onThrough(() => void s.order.push('through'))

  test('a quit with no live session: once, before the hide and the stops', async () => {
    const s = withSessions({ live: [] })
    heard(s)
    s.flow.beforeQuit(s.event())
    expect(s.order).toEqual(['through', 'hide', 'stop'])
    s.finishStops()
    await settle()
    expect(s.quit).toHaveBeenCalledOnce()
    // The quit's own second `before-quit` is not a second signal.
    s.flow.beforeQuit(s.event())
    expect(s.order.filter((x) => x === 'through')).toHaveLength(1)

    // No sessions part at all: the same.
    const t = setup(async () => 'stopped')
    const order: string[] = []
    t.flow.onThrough(() => void order.push('through'))
    t.hide.mockImplementation(() => void order.push('hide'))
    t.flow.beforeQuit(t.event())
    expect(order).toEqual(['through', 'hide'])
  })

  test('cancel: never', async () => {
    const s = withSessions()
    heard(s)
    s.flow.beforeQuit(s.event())
    await settle()
    // A quit while the question is open is ignored.
    s.flow.beforeQuit(s.event())
    s.answer('cancel')
    await settle()
    expect(s.order).toEqual(['ask'])

    // A box that fails reads as Cancel.
    s.sessions.ask.mockImplementationOnce(() => Promise.reject(new Error('no display')))
    s.flow.beforeQuit(s.event())
    await settle()
    expect(s.sessions.ask).toHaveBeenCalledTimes(2)
    expect(s.order).toEqual(['ask'])

    // The next quit asks again, and a confirm goes through: once.
    s.flow.beforeQuit(s.event())
    await settle()
    s.answer('end')
    await settle()
    expect(s.order).toEqual(['ask', 'ask', 'through', 'confirmed 1', 'endAll'])
    s.endAll()
    await settle()
    s.finishStops()
    await settle()
    expect(s.quit).toHaveBeenCalledOnce()
    expect(s.order.filter((x) => x === 'through')).toHaveLength(1)
  })

  test('a confirm: at the confirm, before the ends, so no toast or update box opens during them', async () => {
    const s = withSessions()
    heard(s)
    s.flow.beforeQuit(s.event())
    await settle()
    expect(s.order).toEqual(['ask'])
    s.answer('end')
    await settle()
    expect(s.order).toEqual(['ask', 'through', 'confirmed 1', 'endAll'])
    s.endAll()
    await settle()
    expect(s.order).toEqual(['ask', 'through', 'confirmed 1', 'endAll', 'hide', 'stop'])
  })

  test('server failed: no question, and through before the ends', async () => {
    const s = withSessions({ failed: true })
    heard(s)
    s.flow.beforeQuit(s.event())
    await settle()
    expect(s.order).toEqual(['through', 'confirmed 1', 'endAll'])
  })

  test('a Windows shutdown: at once, also during the question, and only once', async () => {
    const s = withSessions()
    heard(s)
    s.flow.sessionEnd()
    expect(s.order).toEqual(['through', 'silence', 'endAll'])
    s.flow.beforeQuit(s.event())
    s.flow.sessionEnd()
    expect(s.order.filter((x) => x === 'through')).toHaveLength(1)

    const t = withSessions()
    heard(t)
    t.flow.beforeQuit(t.event())
    await settle()
    t.flow.sessionEnd()
    t.answer('end')
    await settle()
    expect(t.order).toEqual(['ask', 'through', 'silence', 'endAll'])

    // During the stops: no second signal.
    const u = withSessions({ live: [] })
    heard(u)
    u.flow.beforeQuit(u.event())
    u.flow.sessionEnd()
    expect(u.order.filter((x) => x === 'through')).toHaveLength(1)
  })

  test('Restart now: endSessions alone is not a quit; the quit after it goes through', async () => {
    const s = withSessions()
    heard(s)
    const cancelled = s.flow.endSessions()
    await settle()
    s.answer('cancel')
    expect(await cancelled).toBe(false)
    const ended = s.flow.endSessions()
    await settle()
    s.answer('end')
    await settle()
    s.endAll()
    expect(await ended).toBe(true)
    expect(s.order).toEqual(['ask', 'ask', 'confirmed 1', 'endAll'])

    // The updater's quit: no live session now, so it goes through.
    s.flow.beforeQuit(s.event())
    expect(s.order).toEqual(['ask', 'ask', 'confirmed 1', 'endAll', 'through', 'hide', 'stop'])

    // No live session: true at once, and nothing goes through until the quit.
    const t = withSessions({ live: [] })
    heard(t)
    expect(await t.flow.endSessions()).toBe(true)
    expect(t.order).toEqual([])
  })

  test('a quit during the Restart now question is ignored, so its confirm is not a quit', async () => {
    const s = withSessions()
    heard(s)
    const ended = s.flow.endSessions()
    await settle()
    s.flow.beforeQuit(s.event())
    s.answer('end')
    await settle()
    s.endAll()
    expect(await ended).toBe(true)
    expect(s.order).toEqual(['ask', 'confirmed 1', 'endAll'])
  })

  test('a listener added after the quit went through hears it at once', () => {
    const s = withSessions({ live: [] })
    s.flow.beforeQuit(s.event())
    const late = vi.fn()
    s.flow.onThrough(late)
    expect(late).toHaveBeenCalledOnce()
  })

  test('a listener that throws does not stop the quit or the others', async () => {
    const s = withSessions({ live: [] })
    s.flow.onThrough(() => {
      throw new Error('boom')
    })
    heard(s)
    s.flow.beforeQuit(s.event())
    expect(s.order).toEqual(['through', 'hide', 'stop'])
    expect(s.log).toHaveBeenCalledWith('openaflow desktop: a quit listener failed: boom')
  })
})
