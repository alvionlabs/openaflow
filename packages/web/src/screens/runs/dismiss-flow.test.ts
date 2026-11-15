import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DismissSessionResult } from '@openaflow/model'
import { RESTARTED, UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import { RELOAD, TRY_AGAIN } from '../../add-repo.ts'
import { createDismissFlow, DISMISS_ERRORS, STILL_RUNNING, type DismissState } from './dismiss-flow.ts'

const MARKER = '7f3c9a12-0000-4000-8000-000000000001'
const TARGET = { repoId: 'notes', marker: MARKER }

type Reply = ActionReply<DismissSessionResult>
const ok: Reply = { ok: true, data: { outcome: 'dismissed', logged: true } }
const fail = (status: number, message: string): Reply => ({ ok: false, status, message })

/** A flow whose post answers when the test says, with every state and every end recorded. */
function setup() {
  const answers: ((r: Reply) => void)[] = []
  const post = vi.fn((_path: string, _body: object) => new Promise<Reply>((res) => answers.push(res)))
  const states: DismissState[] = []
  const done: string[] = []
  const flow = createDismissFlow((s) => states.push(s), (how) => done.push(how), post as never)
  const reply = async (r: Reply, i = answers.length - 1) => {
    answers[i]!(r)
    await Promise.resolve()
    await Promise.resolve()
  }
  return { flow, post, states, done, reply }
}

afterEach(() => vi.restoreAllMocks())

describe('dismiss flow', () => {
  it('dismiss', async () => {
    // Posts the route once, with the repo and the marker; a second press while it runs sends nothing.
    const t = setup()
    t.flow.dismiss(TARGET)
    t.flow.dismiss(TARGET)
    expect(t.post).toHaveBeenCalledTimes(1)
    expect(t.post).toHaveBeenCalledWith('dismiss-session', { repoId: 'notes', marker: MARKER })
    expect(t.flow.state()).toEqual({ kind: 'dismissing' })
    await t.reply(ok)
    expect(t.flow.state()).toEqual({ kind: 'idle' })
    expect(t.done).toEqual(['dismissed'])
    expect(t.states.map((s) => s.kind)).toEqual(['dismissing', 'idle'])

    // 409 session is live: the alert box says it still runs, and a retry posts again.
    const live = setup()
    live.flow.dismiss(TARGET)
    await live.reply(fail(409, 'session is live'))
    expect(live.flow.state()).toEqual({ kind: 'idle', error: STILL_RUNNING })
    expect(live.done).toEqual([])
    live.flow.dismiss(TARGET)
    expect(live.post).toHaveBeenCalledTimes(2)
    await live.reply(ok)
    expect(live.done).toEqual(['dismissed'])

    // 404 no session (also a repeat after another window dismissed it): already gone, so it counts as done.
    const gone = setup()
    gone.flow.dismiss(TARGET)
    await gone.reply(fail(404, 'no session'))
    expect(gone.flow.state()).toEqual({ kind: 'idle' })
    expect(gone.done).toEqual(['gone'])
  })

  it('other refusals go in the box; the exact cause goes to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cases: [Reply, string][] = [
      [fail(409, 'no terminal host'), DISMISS_ERRORS.get('no terminal host')!],
      [fail(400, 'bad request'), DISMISS_ERRORS.get('bad request')!],
      [fail(0, UNREACHABLE), DISMISS_ERRORS.get(UNREACHABLE)!],
      [fail(403, RESTARTED), RELOAD],
      [fail(500, 'HTTP 500'), TRY_AGAIN],
      // A 404 from a server with no such route is not "gone".
      [fail(404, 'not found'), TRY_AGAIN],
    ]
    for (const [reply, text] of cases) {
      const t = setup()
      t.flow.dismiss(TARGET)
      await t.reply(reply)
      expect(t.flow.state()).toEqual({ kind: 'idle', error: text })
      expect(t.done).toEqual([])
    }
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(['openaflow: dismiss failed (HTTP 500: HTTP 500)', 'openaflow: dismiss failed (HTTP 404: not found)'])
  })

  it('a press clears the last error; after dispose the state stays, but a dismissal still ends', async () => {
    const t = setup()
    t.flow.dismiss(TARGET)
    await t.reply(fail(409, 'session is live'))
    t.flow.dismiss(TARGET)
    expect(t.flow.state()).toEqual({ kind: 'dismissing' })
    // The server rebuilds the Board before it answers, so the bar can leave first: its answer still ends the dismissal
    // (the screen moves focus), but no state changes.
    const seen = t.states.length
    t.flow.dispose()
    await t.reply(ok)
    expect(t.done).toEqual(['dismissed'])
    expect(t.states.length).toBe(seen)
    // A refusal after dispose shows nowhere.
    const late = setup()
    late.flow.dismiss(TARGET)
    late.flow.dispose()
    await late.reply(fail(409, 'session is live'))
    expect(late.done).toEqual([])
    expect(late.states.map((s) => s.kind)).toEqual(['dismissing'])
    // A press after dispose (React's dev mode disposes once on mount) posts and shows its state again.
    t.flow.dismiss(TARGET)
    expect(t.post).toHaveBeenCalledTimes(3)
    expect(t.states.at(-1)).toEqual({ kind: 'dismissing' })
  })
})
