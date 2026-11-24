import { describe, expect, it, vi } from 'vitest'
import { buildRepoModel, type Board, type BoardRepo, type HostedSession, type NewSessionResult } from '@openaflow/model'
import { RELOAD, RESTARTED, NEED_RELOAD, UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import {
  SETUP_ERRORS,
  SETUP_OFFER,
  USE_ERRORS,
  setupOffer,
  versionLine,
  workflowNotice,
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
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewSessionForm, WorkflowContext } from './NewSessionForm.tsx'

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
    expect(textLabel('plan')).toBe('What to build')
    expect(textLabel('idea')).toBe('What to build')
    expect(textLabel('plain')).toBe('Message (optional)')
  })

  it('wrapper errors offer settings', async () => {
    const wrapper = { line: 'Your run wrapper failed:', code: 'exit 3: bad option' }
    const t = setup()
    t.flow.start(input())
    await t.reply(fail(409, 'run wrapper: exit 3: bad option'))
    expect(t.flow.state()).toEqual({ kind: 'idle', error: "The session didn't start", wrapper })
    // The action goes to the literal hash, and only that.
    t.flow.openSettings()
    expect(t.moves).toEqual(['go #settings'])
    // The form draws the title, the line, the code as code, and the action; the failed state is not busy.
    const html = renderToStaticMarkup(createElement(NewSessionForm, { repoId: 'notes', state: t.flow.state(), flow: t.flow }))
    expect(html).toContain("The session didn&#x27;t start")
    expect(html).toContain('Your run wrapper failed:')
    expect(html).toContain('<code class="mono wrapper-error-code">exit 3: bad option</code>')
    expect(html).toContain('Open settings')
    expect(html).toContain('role="alert"')

    // The stop command has its own line; a reason with a colon and spaces stays whole.
    const stop = setup()
    stop.flow.start(input())
    await stop.reply(fail(409, 'stop command: not found: /usr/bin/nope'))
    expect(stop.flow.state()).toEqual({ kind: 'idle', error: "The session didn't start", wrapper: { line: 'Your stop command failed:', code: 'not found: /usr/bin/nope' } })

    // Other errors keep today's words and show no action; a bare prefix with no reason is not a wrapper error.
    for (const message of ['claude not found', 'start failed: boom', 'run wrapper:', 'run wrapper: ', 'stop command:', 'xrun wrapper: exit 1', 'something new']) {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const o = setup()
      o.flow.start(input())
      await o.reply(fail(409, message))
      const state = o.flow.state()
      expect(state, message).not.toHaveProperty('wrapper')
      const out = renderToStaticMarkup(createElement(NewSessionForm, { repoId: 'notes', state, flow: o.flow }))
      expect(out, message).not.toContain('Open settings')
    }
  })

  it('bare skill names', () => {
    // init first, the pod skills, then Plain session after a divider; each shows its bare name, never /pod:.
    const items = skillItems()
    expect(items.map((i) => (i.kind === 'divider' ? '—' : i.value))).toEqual(['init', 'plan', 'ship', 'task', 'research', 'idea', '—', 'plain'])
    expect(items.flatMap((i) => (i.kind === 'option' ? [i.command] : []))).toEqual(['init', 'plan', 'ship', 'task', 'research', 'idea', undefined])
    expect(items[0]).toEqual({ kind: 'option', value: 'init', label: 'Map the project', command: 'init', line: 'Map the codebase and write the smoke recipe.' })
    expect(items[1]).toEqual({ kind: 'option', value: 'plan', label: 'Plan', command: 'plan', line: 'Interview, then write a plan.' })
    expect(items.at(-1)).toEqual({ kind: 'option', value: 'plain', label: 'Plain session', line: 'Claude with no prompt.' })
    expect(JSON.stringify(items)).not.toContain('/pod:')
    // The form draws the bare name of its default pick, plan.
    const t = setup()
    const html = renderToStaticMarkup(createElement(NewSessionForm, { repoId: 'notes', state: t.flow.state(), flow: t.flow }))
    expect(html).toContain('<code class="listbox-command">plan</code>')
    expect(html).not.toContain('/pod:')
    vi.useRealTimers()
  })

  it('version line', () => {
    expect(versionLine(SET_UP(), BUNDLE)).toBe('Workflow: claude-pod 0.11.10')
    // No bundle, or no .openaflow/ (with docs or not): no line.
    expect(versionLine(SET_UP(), undefined)).toBeUndefined()
    expect(versionLine(LEGACY(), BUNDLE)).toBeUndefined()
    expect(versionLine(NO_DOCS(), BUNDLE)).toBeUndefined()
    expect(versionLine(undefined, BUNDLE)).toBeUndefined()
    // A set-up repo with no workflow folder still loads the bundle (§6), so the line shows.
    expect(versionLine(withFiles({ '.openaflow/': '' }), BUNDLE)).toBe('Workflow: claude-pod 0.11.10')
    // The form draws it under the button only for a set-up repo.
    expect(formHtml(SET_UP())).toContain('Workflow: claude-pod 0.11.10')
    expect(formHtml(SET_UP(), null)).not.toContain('Workflow:')
    expect(formHtml(LEGACY())).not.toContain('Workflow:')
    const html = formHtml(SET_UP())
    expect(html.indexOf('New session</button>')).toBeLessThan(html.indexOf('Workflow: claude-pod'))
  })

  it('mismatch notice', () => {
    expect(workflowNotice(SET_UP('0.0.1'), BUNDLE)).toEqual({ text: 'This repo uses claude-pod 0.0.1; the app has 0.11.10', use: 'Use 0.11.10', name: 'claude-pod' })
    // Equal, unset, no bundle, no .openaflow/: none.
    expect(workflowNotice(SET_UP('0.11.10'), BUNDLE)).toBeUndefined()
    expect(workflowNotice(SET_UP(), BUNDLE)).toBeUndefined()
    expect(workflowNotice(SET_UP('0.0.1'), undefined)).toBeUndefined()
    expect(workflowNotice(LEGACY(), BUNDLE)).toBeUndefined()
    expect(workflowNotice(undefined, BUNDLE)).toBeUndefined()
    // Only the first workflow whose source is claude-pod counts; one with no source or another source is skipped.
    expect(workflowNotice(MANY(), BUNDLE)).toEqual({ text: 'This repo uses claude-pod 0.0.2; the app has 0.11.10', use: 'Use 0.11.10', name: 'c-pod' })
    // The first claude-pod workflow is current: no notice, even if a later one differs.
    const first = withFiles({
      '.openaflow/': '',
      '.openaflow/workflows/a/': '',
      '.openaflow/workflows/a/workflow.json': '{"source":"claude-pod","version":"0.11.10"}',
      '.openaflow/workflows/b/': '',
      '.openaflow/workflows/b/workflow.json': '{"source":"claude-pod","version":"0.0.1"}',
    })
    expect(workflowNotice(first, BUNDLE)).toBeUndefined()
    // The form draws the line and Use above the button, and New session stays on: the notice never blocks a start.
    const html = formHtml(SET_UP('0.0.1'))
    expect(html).toContain('This repo uses claude-pod 0.0.1; the app has 0.11.10')
    expect(html).toMatch(/<button class="btn" type="button">Use 0.11.10<\/button>/)
    expect(html.indexOf('Use 0.11.10')).toBeLessThan(html.indexOf('New session</button>'))
    expect(html).toMatch(/<button class="btn primary" type="submit">New session<\/button>/)
    expect(formHtml(SET_UP('0.11.10'))).not.toContain('Use 0.11.10')
  })

  it('use version', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { flow, post, reply, states } = setup()
    // Nothing to use (same version, no bundle, no .openaflow/): no post.
    flow.useVersion(SET_UP('0.11.10'), BUNDLE)
    flow.useVersion(SET_UP('0.0.1'), undefined)
    flow.useVersion(LEGACY(), BUNDLE)
    expect(post).not.toHaveBeenCalled()
    flow.useVersion(SET_UP('0.0.1'), BUNDLE)
    expect(post).toHaveBeenCalledWith('use-workflow-version', { repoId: 'notes', name: 'claude-pod' })
    expect(flow.state()).toEqual({ kind: 'posting', action: 'use' })
    // One post at a time: a second Use, a Set up, or a start while it is out posts nothing.
    flow.useVersion(SET_UP('0.0.1'), BUNDLE)
    flow.setUp(LEGACY())
    flow.start(input())
    expect(post).toHaveBeenCalledTimes(1)
    // Done: free again, with focus back in the text field (the Use button leaves with the next Board).
    await reply({ ok: true, data: { outcome: 'updated', logged: true } } as never)
    expect(flow.state()).toEqual({ kind: 'idle', focusText: true })

    // Each refusal shows its words in the box and keeps the form; a retry posts again.
    const words: [Reply, string][] = [
      [fail(409, 'already current'), "This repo already uses the app's version"],
      [fail(409, 'workflow missing'), 'The app has no workflow to use. Please reinstall it'],
      [fail(404, 'not a workflow'), "This workflow isn't on the board anymore"],
      [fail(409, 'workflow.json unreadable'), "Can't read this repo's workflow.json"],
      [fail(500, 'update failed: EACCES'), 'Update failed. Please try again'],
      [fail(403, RESTARTED), RELOAD],
      [fail(0, NEED_RELOAD), RELOAD],
      [fail(0, UNREACHABLE), 'Something went wrong. Please try again'],
      [fail(500, 'HTTP 500'), 'Something went wrong. Please try again'],
    ]
    for (const [r, text] of words) {
      flow.useVersion(SET_UP('0.0.1'), BUNDLE)
      expect(flow.state().kind).toBe('posting')
      await reply(r)
      expect(flow.state(), r.ok ? '' : r.message).toEqual({ kind: 'idle', error: text })
    }
    expect(post).toHaveBeenCalledTimes(1 + words.length)
    expect(USE_ERRORS.get('already current')).toBe("This repo already uses the app's version")
    // The exact cause of a try-again or a failed write goes to the console.
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([expect.stringContaining('update failed: EACCES'), expect.stringContaining('HTTP 500')]))
    // The form keeps the notice and shows the words under it.
    const html = formHtml(SET_UP('0.0.1'), BUNDLE, flow)
    expect(html).toContain('Use 0.11.10')
    expect(html).toContain('Something went wrong. Please try again')
    // The name is the mismatched workflow's, not the source's: the first claude-pod one.
    const named = setup()
    named.flow.useVersion(MANY(), BUNDLE)
    expect(named.post).toHaveBeenCalledWith('use-workflow-version', { repoId: 'notes', name: 'c-pod' })
    named.flow.dispose()
    // A late answer after the form left changes nothing.
    flow.useVersion(SET_UP('0.0.1'), BUNDLE)
    flow.dispose()
    const before = states.length
    await reply({ ok: true, data: { outcome: 'updated', logged: true } } as never)
    expect(states.length).toBe(before)
    expect(flow.state()).toEqual({ kind: 'idle' })
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('setup offer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Only without .openaflow/, with docs or not; never in a set-up repo.
    expect(setupOffer(LEGACY())).toBe(true)
    expect(setupOffer(NO_DOCS())).toBe(true)
    expect(setupOffer(SET_UP())).toBe(false)
    expect(setupOffer(withFiles({ '.openaflow/': '' }))).toBe(false)
    expect(setupOffer(undefined)).toBe(false)
    expect(SETUP_OFFER).toBe('Create .openaflow/ in this repo?')
    // The form: the line (.openaflow/ in mono) and Set up, and New session stays on.
    for (const r of [LEGACY(), NO_DOCS()]) {
      const html = formHtml(r)
      expect(html).toContain('Create <code class="mono">.openaflow/</code> in this repo?')
      expect(html).toMatch(/<button class="btn" type="button">Set up<\/button>/)
      expect(html).toMatch(/<button class="btn primary" type="submit">New session<\/button>/)
      expect(html).not.toContain('Workflow:')
    }
    expect(formHtml(SET_UP())).not.toContain('Set up</button>')

    // Set up posts setup-workflow with the repo's path; busy while it is out; done puts focus in the text field.
    const { flow, post, reply } = setup()
    // A set-up repo has no offer: no post.
    flow.setUp(SET_UP())
    expect(post).not.toHaveBeenCalled()
    const spaced: BoardRepo = { ...NO_DOCS(), path: '/home/me/notes app' }
    flow.setUp(spaced)
    expect(post).toHaveBeenCalledWith('setup-workflow', { path: '/home/me/notes app' })
    expect(flow.state()).toEqual({ kind: 'posting', action: 'setup' })
    const busy = formHtml(LEGACY(), BUNDLE, flow)
    expect(busy).toContain('Setting up…')
    flow.setUp(spaced)
    expect(post).toHaveBeenCalledTimes(1)
    await reply({ ok: true, data: { outcome: 'created', logged: true } } as never)
    expect(flow.state()).toEqual({ kind: 'idle', focusText: true })
    // While a session starts, Set up posts nothing.
    flow.start(input())
    flow.setUp(LEGACY())
    expect(post).toHaveBeenCalledTimes(2)
    await reply(ok())
    flow.dispose()

    // Refusals: A1's words, so the app reads the same everywhere; a retry works.
    const s = setup()
    const words: [Reply, string][] = [
      [fail(409, 'already set up'), 'This repo already has a .openaflow file or folder'],
      [fail(409, 'workflow missing'), 'The app has no workflow to set up. Please reinstall it'],
      [fail(409, 'setup in progress'), 'Setup is already running. Please wait'],
      [fail(500, 'setup failed: ENOSPC'), 'Setup failed. Please try again'],
      [fail(404, 'not a repo'), 'Something went wrong. Please try again'],
      [fail(0, UNREACHABLE), 'Something went wrong. Please try again'],
      [fail(403, RESTARTED), RELOAD],
    ]
    for (const [r, text] of words) {
      s.flow.setUp(LEGACY())
      await s.reply(r)
      expect(s.flow.state(), r.ok ? '' : r.message).toEqual({ kind: 'idle', error: text })
    }
    expect(SETUP_ERRORS.get('already set up')).toBe('This repo already has a .openaflow file or folder')
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([expect.stringContaining('setup failed: ENOSPC')]))
    // A failed setup keeps the offer, and the stale token gets the modal's Reload in the dialog.
    const html = renderToStaticMarkup(
      createElement(WorkflowContext.Provider, { value: { workflow: BUNDLE, repos: [LEGACY()] } }, createElement(NewSessionForm, { repoId: 'notes', state: s.flow.state(), flow: s.flow, inDialog: true })),
    )
    expect(html).toContain('Set up</button>')
    expect(html).toContain(RELOAD)
    // A new start clears the box.
    s.flow.start(input())
    expect(s.flow.state().kind).toBe('starting')
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('start errors for the workflow', async () => {
    const t = setup()
    t.flow.start(input())
    await t.reply(fail(409, 'workflow missing'))
    expect(t.flow.state()).toEqual({ kind: 'idle', error: "The app doesn't have this repo's workflow. Please reinstall it" })
    vi.useRealTimers()
  })
})

const BUNDLE: Board['workflow'] = { source: 'claude-pod', version: '0.11.10' }
const withFiles = (files: Record<string, string>): BoardRepo => ({ ...repo(), model: buildRepoModel(files) })
/** A set-up repo with one claude-pod workflow, at `version` or with none. */
const SET_UP = (version?: string) =>
  withFiles({
    '.openaflow/': '',
    '.openaflow/workflows/claude-pod/': '',
    '.openaflow/workflows/claude-pod/workflow.json': JSON.stringify(version === undefined ? { source: 'claude-pod' } : { source: 'claude-pod', version }),
    '.openaflow/workflows/claude-pod/state/README.md': '# pod docs\n\npod docs: 2\n',
  })
/** Four workflows: another source, no source, then two claude-pod ones; the first claude-pod one is c-pod. */
const MANY = () =>
  withFiles({
    '.openaflow/': '',
    '.openaflow/workflows/a-other/': '',
    '.openaflow/workflows/a-other/workflow.json': '{"source":"other","version":"9.9.9"}',
    '.openaflow/workflows/b-nosource/': '',
    '.openaflow/workflows/b-nosource/workflow.json': '{"version":"8.8.8"}',
    '.openaflow/workflows/c-pod/': '',
    '.openaflow/workflows/c-pod/workflow.json': '{"source":"claude-pod","version":"0.0.2"}',
    '.openaflow/workflows/d-pod/': '',
    '.openaflow/workflows/d-pod/workflow.json': '{"source":"claude-pod","version":"0.0.3"}',
  })
const LEGACY = () => withFiles({ 'pod-docs/README.md': '# pod docs\n\npod docs: 2\n' })
const NO_DOCS = () => withFiles({})
/** The form for `r`, with the Board's bundle in its context (`null`: no bundle). */
function formHtml(r: BoardRepo, bundle: Board['workflow'] | null = BUNDLE, flow = createNewSessionFlow(() => {}, { post: (() => new Promise(() => {})) as never })): string {
  return renderToStaticMarkup(createElement(WorkflowContext.Provider, { value: { repos: [r], ...(bundle ? { workflow: bundle } : {}) } }, createElement(NewSessionForm, { repoId: r.id, state: flow.state(), flow })))
}
