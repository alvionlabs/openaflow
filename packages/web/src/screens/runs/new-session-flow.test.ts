import { describe, expect, it, vi } from 'vitest'
import type { BoardRepo, HostedSession, NewSessionResult } from '@openaflow/model'
import { UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import {
  BAD_TEXT,
  MARKER_WAIT_MS,
  NOT_SHOWN,
  PLAIN_DASH,
  START_ERRORS,
  createNewSessionFlow,
  createTypedLines,
  skillItems,
  textLabel,
  type NewSessionInput,
  type NewSessionState,
} from './new-session-flow.ts'

const MARKER = '7f3c9a12-0000-4000-8000-000000000001'

const session = (over: Partial<HostedSession> = {}): HostedSession => ({
  marker: MARKER,
  sessionId: 'sess-1',
  liveSession: 'sess-1',
  sessions: ['sess-1'],
  skill: 'plan',
  startedAt: 0,
  state: 'live',
  hooked: false,
  prompted: false,
  ...over,
})
const repo = (hosted?: HostedSession[], id = 'notes'): BoardRepo =>
  ({ id, name: id, path: `/${id}`, source: 'registered', model: {} as BoardRepo['model'], agents: [], prs: [], claims: [], ...(hosted ? { hosted } : {}) }) as BoardRepo

type Reply = ActionReply<NewSessionResult>
const ok = (over: Partial<NewSessionResult> = {}): Reply => ({ ok: true, data: { outcome: 'started', marker: MARKER, logged: true, ...over } })
const fail = (status: number, message: string): Reply => ({ ok: false, status, message })

/** A flow with a post that answers when the test says, and every move recorded. */
function setup() {
  let answer: (r: Reply) => void = () => {}
  const post = vi.fn((_path: string, _body: object) => new Promise<Reply>((res) => (answer = res)))
  const moves: string[] = []
  const states: NewSessionState[] = []
  const typed = createTypedLines()
  vi.useFakeTimers()
  const flow = createNewSessionFlow((s) => states.push(s), {
    post: post as never,
    go: (hash) => moves.push(`go ${hash}`),
    openTab: () => moves.push('tab terminal'),
    typed,
  })
  const reply = async (r: Reply) => {
    answer(r)
    await vi.advanceTimersByTimeAsync(0)
  }
  return { flow, post, moves, states, typed, reply }
}
const input = (over: Partial<NewSessionInput> = {}): NewSessionInput => ({ repoId: 'notes', skill: 'plan', text: 'add tags to notes', ...over })

describe('new session flow', () => {
  it('start', async () => {
    const { flow, post, moves, reply } = setup()
    expect(flow.state()).toMatchObject({ kind: 'idle' })
    flow.start(input())
    // Busy at once; a second press posts nothing.
    expect(flow.state().kind).toBe('starting')
    flow.start(input({ text: 'again' }))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('new-session', { repoId: 'notes', skill: 'plan', text: 'add tags to notes' })

    // Started: still busy, waiting for the marker on the Board. A Board without it, or another repo's, moves nothing.
    await reply(ok())
    expect(flow.state()).toMatchObject({ kind: 'waiting', marker: MARKER })
    flow.board(repo())
    flow.board(repo([session({ marker: 'other' })]))
    flow.board(repo([session()], 'other-repo'))
    expect(moves).toEqual([])
    expect(flow.state().kind).toBe('waiting')

    // The marker on this repo's Board: to the repo row, then its Terminal tab; the form is free again.
    flow.board(repo([session()]))
    expect(moves).toEqual(['go #/notes', 'tab terminal'])
    expect(flow.state()).toEqual({ kind: 'idle', done: true })
    // The wait's timer is gone: nothing more happens.
    await vi.advanceTimersByTimeAsync(MARKER_WAIT_MS)
    expect(moves).toEqual(['go #/notes', 'tab terminal'])
    vi.useRealTimers()
  })

  it('moves at once when the Board listed the marker before the answer', async () => {
    const { flow, moves, reply } = setup()
    flow.start(input({ repoId: 'a b', skill: 'plain', text: '' }))
    flow.board(repo([session()], 'a b'))
    expect(moves).toEqual([])
    await reply(ok())
    expect(moves).toEqual(['go #/a%20b', 'tab terminal'])
    vi.useRealTimers()
  })

  it('marker never shows', async () => {
    const { flow, moves, states, reply } = setup()
    flow.start(input())
    await reply(ok())
    await vi.advanceTimersByTimeAsync(MARKER_WAIT_MS - 1)
    expect(flow.state().kind).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1)
    // Busy ends, with no move, and a note says the session started.
    expect(flow.state()).toEqual({ kind: 'idle', done: true, note: NOT_SHOWN })
    expect(moves).toEqual([])
    // A late Board with the marker moves nothing.
    flow.board(repo([session()]))
    expect(moves).toEqual([])
    expect(states.map((s) => s.kind)).toEqual(['starting', 'waiting', 'idle'])
    vi.useRealTimers()
  })

  it('dispose drops the answer and the wait', async () => {
    const { flow, moves, reply } = setup()
    flow.start(input())
    flow.dispose()
    await reply(ok())
    flow.board(repo([session()]))
    expect(moves).toEqual([])
    vi.useRealTimers()
  })

  it('errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { flow, post, moves, reply } = setup()

    // bad text: a field error, worded by the skill. Editing the text clears it.
    flow.start(input())
    await reply(fail(400, 'bad text'))
    expect(flow.state()).toEqual({ kind: 'idle', fieldError: BAD_TEXT })
    flow.edit()
    expect(flow.state()).toEqual({ kind: 'idle' })
    flow.start(input({ skill: 'plain', text: '  -p hi' }))
    await reply(fail(400, 'bad text'))
    expect(flow.state()).toEqual({ kind: 'idle', fieldError: PLAIN_DASH })
    expect(BAD_TEXT).toBe('Use plain text on one line, up to 2,000 characters')
    expect(PLAIN_DASH).toBe("A plain session can't start with a dash")

    // 409, 502, 504 and a network failure: the box, never the field. A retry is allowed each time.
    const box: [Reply, string][] = [
      [fail(409, 'session starting'), 'A session is already starting in this repo'],
      [fail(409, 'too many sessions'), 'Ten sessions are open. End one, then try again'],
      [fail(409, 'claude not found'), "Can't find Claude Code on this computer"],
      [fail(409, 'no terminal host'), "The terminals aren't running. Restart the app and try again"],
      [fail(404, 'not a repo'), "This repo isn't on the board anymore"],
      [fail(502, 'start failed: spawn EACCES'), "The session didn't start. Please try again"],
      [fail(504, 'terminals unavailable'), "The terminals didn't answer. Please try again"],
      [fail(0, UNREACHABLE), "Can't reach the board. Please try again"],
      [fail(500, 'HTTP 500'), 'Something went wrong. Please try again'],
    ]
    for (const [r, words] of box) {
      flow.start(input())
      expect(flow.state().kind).toBe('starting')
      await reply(r)
      expect(flow.state(), r.ok ? '' : r.message).toEqual({ kind: 'idle', error: words })
    }
    expect(START_ERRORS.get('session starting')).toBe('A session is already starting in this repo')
    // Every start posted: none was blocked by the last error.
    expect(post).toHaveBeenCalledTimes(2 + box.length)
    // The exact cause of a try-again goes to the console.
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining('start failed: spawn EACCES'), expect.stringContaining('HTTP 500')]),
    )
    expect(moves).toEqual([])
    // A new start clears the box.
    flow.start(input())
    expect(flow.state().kind).toBe('starting')
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('type it yourself', async () => {
    const { flow, typed, reply } = setup()
    flow.start(input())
    await reply(ok({ typeYourself: '/pod:plan add tags to notes' }))
    // Shown on the session's row until the next Board shows it prompted: the raw line, for the card to put in one code span.
    expect(typed.line(session())).toEqual({ line: '/pod:plan add tags to notes' })
    expect(typed.line(session({ state: 'starting' }))).toEqual({ line: '/pod:plan add tags to notes' })
    expect(typed.line(session({ prompted: true }))).toBeUndefined()
    // Gone for good once prompted.
    expect(typed.line(session())).toBeUndefined()
    // A line with a backtick stays whole.
    const ticks = createTypedLines()
    ticks.remember(MARKER, '/pod:task fix `npm ci`')
    expect(ticks.line(session())).toEqual({ line: '/pod:task fix `npm ci`' })
    // An ended or stopped session asks nothing.
    const again = createTypedLines()
    again.remember(MARKER, '/pod:plan x')
    expect(again.line(session({ state: 'ended' }))).toBeUndefined()
    // After a reload the line is gone, but the Board still says to type it: no line, so the card says it in words.
    expect(createTypedLines().line(session({ typeYourself: true }))).toEqual({})
    expect(createTypedLines().line(session({ typeYourself: true, prompted: true }))).toBeUndefined()
    // No typeYourself in the answer: nothing to show.
    const plain = setup()
    plain.flow.start(input())
    await plain.reply(ok())
    expect(plain.typed.line(session())).toBeUndefined()
    vi.useRealTimers()
  })

  it('the form words', () => {
    // Plan first, Plain session after a divider; each option with its label, command and line.
    const items = skillItems()
    expect(items.map((i) => (i.kind === 'divider' ? '—' : i.value))).toEqual(['plan', 'ship', 'task', 'research', 'idea', '—', 'plain'])
    expect(items[0]).toEqual({ kind: 'option', value: 'plan', label: 'Plan', command: '/pod:plan', line: 'Interview, then write a plan.' })
    expect(items.at(-1)).toEqual({ kind: 'option', value: 'plain', label: 'Plain session', line: 'Claude with no prompt.' })
    expect(textLabel('plan')).toBe('What to build')
    expect(textLabel('idea')).toBe('What to build')
    expect(textLabel('plain')).toBe('Message (optional)')
  })
})
