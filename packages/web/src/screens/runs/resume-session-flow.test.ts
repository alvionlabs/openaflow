import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResumeSessionResult } from '@openaflow/model'
import { NEED_RELOAD, RESTARTED, UNREACHABLE, type ActionReply, type ResumeSessionInput } from '../../actions-client.ts'
import { RELOAD, TRY_AGAIN } from '../../add-repo.ts'
import { START_ERRORS } from './new-session-flow.ts'
import { createResumeFlow, RESUME_FAILED, RESUME_WAIT_MS, resumeBusy, resumeError, type ResumeState } from './resume-session-flow.ts'
import { RESUME_BLOCKED } from './terminal-tab.ts'

const OLD = '7f3c9a12-0000-4000-8000-000000000001'
const NEW = '0b1c2d3e-0000-4000-8000-000000000002'
const OTHER = '99999999-0000-4000-8000-000000000003'
const TARGET = { repoId: 'notes', marker: OLD }

type Reply = ActionReply<ResumeSessionResult>
const ok = (marker = NEW): Reply => ({ ok: true, data: { outcome: 'started', marker, logged: true } })
const fail = (status: number, message: string): Reply => ({ ok: false, status, message })

/** A flow whose post answers when the test says, with every state and every focus ask recorded. */
function setup() {
  const answers: ((r: Reply) => void)[] = []
  const post = vi.fn((_input: ResumeSessionInput) => new Promise<Reply>((res) => answers.push(res)))
  const states: ResumeState[] = []
  const focused: string[] = []
  const flow = createResumeFlow((s) => states.push(s), (marker) => focused.push(marker), { post })
  const reply = async (r: Reply, i = answers.length - 1) => {
    answers[i]!(r)
    await Promise.resolve()
    await Promise.resolve()
  }
  return { flow, post, states, focused, reply }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('resume flow', () => {
  it('resume', async () => {
    // Posts once with the repo and the marker; a second press while it is out sends nothing.
    const t = setup()
    t.flow.seen(OLD)
    t.flow.resume(TARGET)
    t.flow.resume(TARGET)
    expect(t.post).toHaveBeenCalledTimes(1)
    expect(t.post).toHaveBeenCalledWith({ repoId: 'notes', marker: OLD })
    expect(t.flow.state()).toEqual({ kind: 'resuming', marker: OLD })
    // Busy for its own bar only.
    expect(resumeBusy(t.flow.state(), OLD)).toBe(true)
    expect(resumeBusy(t.flow.state(), OTHER)).toBe(false)
    // Started: it stays busy until the tab shows the new marker, then asks for focus in it once.
    await t.reply(ok())
    expect(t.flow.state()).toEqual({ kind: 'waiting', marker: OLD, next: NEW })
    expect(resumeBusy(t.flow.state(), OLD)).toBe(true)
    t.flow.seen(OLD)
    vi.advanceTimersByTime(RESUME_WAIT_MS - 1)
    expect(t.focused).toEqual([])
    t.flow.seen(NEW)
    expect(t.flow.state()).toEqual({ kind: 'idle' })
    expect(t.focused).toEqual([NEW])
    t.flow.seen(NEW)
    vi.advanceTimersByTime(RESUME_WAIT_MS)
    expect(t.focused).toEqual([NEW])

    // The server rebuilds the Board before it answers, so the tab can show the new marker first: focus at the answer.
    const early = setup()
    early.flow.seen(OLD)
    early.flow.resume(TARGET)
    early.flow.seen(NEW)
    expect(early.focused).toEqual([])
    await early.reply(ok())
    expect(early.flow.state()).toEqual({ kind: 'idle' })
    expect(early.focused).toEqual([NEW])

    // The new marker never shows in 10 s: busy ends, no focus, and the page stays.
    const slow = setup()
    slow.flow.resume(TARGET)
    await slow.reply(ok())
    slow.flow.seen(OTHER)
    vi.advanceTimersByTime(RESUME_WAIT_MS - 1)
    expect(slow.flow.state().kind).toBe('waiting')
    vi.advanceTimersByTime(1)
    expect(slow.flow.state()).toEqual({ kind: 'idle' })
    expect(resumeBusy(slow.flow.state(), OLD)).toBe(false)
    // A late Board after the wait moves nothing.
    slow.flow.seen(NEW)
    expect(slow.focused).toEqual([])

    // The tab left (another run shows): an answer after dispose changes nothing and asks for no focus.
    const gone = setup()
    gone.flow.resume(TARGET)
    gone.flow.dispose()
    const seen = gone.states.length
    await gone.reply(ok())
    gone.flow.seen(NEW)
    vi.advanceTimersByTime(RESUME_WAIT_MS)
    expect(gone.states.length).toBe(seen)
    expect(gone.focused).toEqual([])
    // Disposed while waiting: the timer stops too.
    const waiting = setup()
    waiting.flow.resume(TARGET)
    await waiting.reply(ok())
    waiting.flow.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cases: [Reply, string][] = [
      // can't resume: the reason's line, as the bar says it.
      [fail(409, "can't resume: no folder"), RESUME_BLOCKED['no folder']],
      [fail(409, "can't resume: no conversation"), RESUME_BLOCKED['no conversation']],
      [fail(409, "can't resume: in use"), RESUME_BLOCKED['in use']],
      // New session's words (N1).
      [fail(409, 'session starting'), START_ERRORS.get('session starting')!],
      [fail(409, 'too many sessions'), START_ERRORS.get('too many sessions')!],
      // The start failed, the terminals didn't answer, the network or the proxy: try again.
      [fail(502, 'start failed: spawn failed: ENOENT'), RESUME_FAILED],
      [fail(504, 'terminals unavailable'), RESUME_FAILED],
      [fail(0, UNREACHABLE), RESUME_FAILED],
      [fail(502, UNREACHABLE), RESUME_FAILED],
      // The rest of the route's words.
      [fail(400, 'bad request'), START_ERRORS.get('bad request')!],
      [fail(409, 'no terminal host'), START_ERRORS.get('no terminal host')!],
      [fail(409, 'claude not found'), START_ERRORS.get('claude not found')!],
      [fail(404, 'no session'), 'This session is already gone'],
      [fail(409, 'session is live'), 'This session is already running'],
      // A dead or missing token: reload.
      [fail(403, RESTARTED), RELOAD],
      [fail(0, NEED_RELOAD), RELOAD],
      // Words the page doesn't know: try again, and the cause in the console.
      [fail(400, 'bad session id'), TRY_AGAIN],
      [fail(409, "can't resume: moon"), TRY_AGAIN],
      [fail(500, 'HTTP 500'), TRY_AGAIN],
    ]
    for (const [reply, text] of cases) {
      const t = setup()
      t.flow.resume(TARGET)
      await t.reply(reply)
      expect(t.flow.state(), reply.ok ? '' : reply.message).toEqual({ kind: 'idle', error: { marker: OLD, text } })
      expect(t.focused).toEqual([])
      // The error shows under its own bar only.
      expect(resumeError(t.flow.state(), OLD)).toBe(text)
      expect(resumeError(t.flow.state(), NEW)).toBeUndefined()
      expect(resumeBusy(t.flow.state(), OLD)).toBe(false)
      // A retry is allowed: it posts again and clears the error.
      t.flow.resume(TARGET)
      expect(t.post).toHaveBeenCalledTimes(2)
      expect(resumeError(t.flow.state(), OLD)).toBeUndefined()
      await t.reply(ok())
      t.flow.seen(NEW)
      expect(t.focused).toEqual([NEW])
    }
    expect(RESUME_FAILED).toBe("The session didn't resume. Please try again")
    // The exact cause goes to the console for the try-again texts, never for a known word.
    const logged = warn.mock.calls.map((c) => String(c[0]))
    expect(logged).toEqual([
      'openaflow: resume failed (HTTP 502: start failed: spawn failed: ENOENT)',
      'openaflow: resume failed (HTTP 504: terminals unavailable)',
      'openaflow: resume failed (HTTP 400: bad session id)',
      "openaflow: resume failed (HTTP 409: can't resume: moon)",
      'openaflow: resume failed (HTTP 500: HTTP 500)',
    ])
  })
})
