import { describe, expect, it, vi } from 'vitest'
import { WAITING_AFTER_MS, type HostedSession } from '@openaflow/model'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DESKTOP_TERMINAL } from './next-step.ts'
import { runChip } from './view.ts'
import type { TerminalBridge } from '../../desktop-bridge.ts'
import { createTerminalLink } from '../../terminal-link.ts'
import { StopBarPanel, TerminalNote, TerminalTab } from './TerminalTab.tsx'
import { SavedScreen } from './TerminalView.tsx'
import { browserView, canAttach, CANT_RESUME, clock, ENDED_NO_TIME, focusMove, screenHandlers, screenUnder, wantSaved, focusRun, keepFocusAsk, RESUME_BLOCKED, RESUME_LINE, SIDELOAD_LINE, stopBar, terminalOptions, DEFAULT_SCROLLBACK, tabDot, terminalBody, UNAVAILABLE } from './terminal-tab.ts'

// Local times, so the HH:MM checks hold in any time zone.
const START = new Date(2026, 10, 15, 13, 40).getTime()
const END = new Date(2026, 10, 15, 14, 2).getTime()
const NOW = START + 60_000

const session = (over: Partial<HostedSession> = {}): HostedSession => ({
  marker: '7f3c9a12-0000-4000-8000-000000000001',
  sessionId: 'sess-1',
  liveSession: 'sess-1',
  sessions: ['sess-1'],
  skill: 'plan',
  startedAt: START,
  state: 'live',
  hooked: true,
  prompted: true,
  ...over,
})
const STARTING = session({ state: 'starting', hooked: false })
const LIVE = session()
// Live with no SessionStart line 10 s after the start: Claude waits for you.
const WAITING = session({ hooked: false })
const ENDED = session({ state: 'ended', exitCode: 0, endedAt: END })
const ENDED_CODE = session({ state: 'ended', exitCode: 3, endedAt: END })
const RESTARTED = session({ state: 'stopped', stopReason: 'terminals restarted', endedAt: END })
// S1 sets no endedAt on `stopped · app closed` or on reconcile's `ended`.
const APP_CLOSED = session({ state: 'stopped', stopReason: 'app closed' })
const ENDED_UNTIMED = session({ state: 'ended' })

// The desktop app's bridge; the view's effects never run in a static render, so it is never called.
const BRIDGE: TerminalBridge = { connect: async () => {}, onHostState: () => () => {} }
const tab = (s: HostedSession, bridge: TerminalBridge | undefined = undefined) =>
  renderToStaticMarkup(createElement(TerminalTab, { repoId: 'notes', repoPath: '/notes', session: s, now: NOW, bridge }))
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''))
/** The buttons with `disabled`, in order. */
const disabled = (html: string) => [...html.matchAll(/<button([^>]*)>/g)].map((m) => /\sdisabled=""/.test(m[1]!))
/** React escapes the apostrophe in text. */
const text = (s: string) => s.replaceAll("'", '&#x27;')

describe('terminal tab', () => {
  it('clock', () => {
    expect(clock(END)).toBe('14:02')
    expect(clock(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05')
    expect(clock(new Date(2026, 0, 1, 0, 0).getTime())).toBe('00:00')
  })

  it('tab dot', () => {
    // The run dot while the shown session is starting or live.
    expect(tabDot(STARTING, NOW)).toBe('s-run')
    expect(tabDot(LIVE, NOW)).toBe('s-run')
    // Waiting for you: the needs-you dot, the class the sidebar's `needs-you` row uses (`runChip`).
    expect(tabDot(WAITING, START + WAITING_AFTER_MS)).toBe(runChip('needs-you').cls)
    expect(tabDot(WAITING, START + WAITING_AFTER_MS)).toBe('s-you')
    // Just before the waiting time, it is still live: the run dot.
    expect(tabDot(WAITING, START + WAITING_AFTER_MS - 1)).toBe('s-run')
    // None once it ended or stopped, for any reason.
    for (const s of [ENDED, ENDED_CODE, RESTARTED, APP_CLOSED, ENDED_UNTIMED]) expect(tabDot(s, NOW)).toBeUndefined()
    // None with no session.
    expect(tabDot(undefined, NOW)).toBeUndefined()
  })

  it('stop bar', () => {
    // Starting, live, and waiting give the terminal.
    for (const s of [STARTING, LIVE, WAITING]) expect(terminalBody(s, START + WAITING_AFTER_MS, true).kind).toBe('terminal')
    // Ended and stopped give the stop bar: the session's idle dot, its word, when it ended.
    expect(terminalBody(ENDED, NOW, true)).toEqual({ kind: 'stopped', bar: { dot: 's-idle', word: 'Ended · Claude exited', line: 'The terminal ended at 14:02.', resume: false } })
    expect(stopBar(ENDED_CODE, NOW, true)).toEqual({ dot: 's-idle', word: 'Ended · Claude exited with code 3', line: 'The terminal ended at 14:02.', resume: false })
    expect(stopBar(RESTARTED, NOW, true)).toEqual({ dot: 's-idle', word: 'Stopped · terminals restarted', line: 'The terminal ended at 14:02.', resume: false })
    // No end time: the line says it ended, with no time.
    expect(stopBar(APP_CLOSED, NOW, true)).toEqual({ dot: 's-idle', word: 'Stopped · app closed', line: ENDED_NO_TIME, resume: false })
    expect(stopBar(ENDED_UNTIMED, NOW, true).line).toBe(ENDED_NO_TIME)

    // Drawn: the bar has Dismiss and nothing else (no Resume in this sprint), over the faded last screen.
    for (const s of [ENDED, ENDED_CODE, RESTARTED, APP_CLOSED]) {
      const html = tab(s)
      expect(buttons(html)).toEqual(['Dismiss'])
      expect(html).not.toContain('Resume')
      expect(html).toContain('class="stop-bar"')
      expect(html).toContain('class="status s-idle"')
      expect(html).toContain(stopBar(s, NOW, false).word)
      expect(html).toContain(stopBar(s, NOW, false).line)
      expect(html).toMatch(/class="term[^"]*\bfaded\b/)
    }
    // A live session draws the terminal: no stop bar, no button, input on.
    for (const s of [LIVE, WAITING]) {
      const html = tab(s)
      expect(html).not.toContain('stop-bar')
      expect(buttons(html)).toEqual([])
      expect(html).toMatch(/class="term"/)
      expect(html).not.toContain('faded')
    }
    // With no link (it can't connect), a live session says the terminal is not available only once the link says so.
    expect(tab(LIVE)).not.toContain(UNAVAILABLE)

    // resume `ok`: today's dot and word, the end line and the Resume line, then Resume (primary) and Dismiss.
    for (const s of [ENDED, ENDED_CODE, RESTARTED, APP_CLOSED].map((x) => ({ ...x, resume: 'ok' as const }))) {
      const today = stopBar({ ...s, resume: undefined }, NOW, true)
      const bar = stopBar(s, NOW, true)
      expect(bar).toEqual({ dot: 's-idle', word: today.word, line: `${today.line} ${RESUME_LINE}`, resume: true })
      const html = tab(s, BRIDGE)
      expect(buttons(html)).toEqual(['Resume', 'Dismiss'])
      expect(html).toMatch(/<button class="btn primary"[^>]*>Resume<\/button>/)
      expect(html).toMatch(/<button class="btn"[^>]*>Dismiss<\/button>/)
      expect(html).toContain('class="status s-idle"')
      expect(html).toContain(text(bar.line))
    }
    expect(RESUME_LINE).toBe('Resume starts the same Claude session again.')
    expect(stopBar({ ...APP_CLOSED, resume: 'ok' }, NOW, true).line).toBe('The terminal has ended. Resume starts the same Claude session again.')

    // Each can't resume reason: the blocked dot, the word Can't resume, the reason's line, and Dismiss only.
    expect(RESUME_BLOCKED).toEqual({ 'no folder': 'The repo folder is gone.', 'no conversation': 'The session file is gone.', 'in use': 'Another terminal holds this session.' })
    for (const reason of ['no folder', 'no conversation', 'in use'] as const) {
      for (const s of [ENDED, APP_CLOSED].map((x) => ({ ...x, resume: reason }))) {
        expect(stopBar(s, NOW, true)).toEqual({ dot: 's-bad', word: CANT_RESUME, line: RESUME_BLOCKED[reason], resume: false })
        const html = tab(s, BRIDGE)
        expect(buttons(html)).toEqual(['Dismiss'])
        expect(html).toContain('class="status s-bad"')
        expect(html).toContain(text("Can't resume"))
        expect(html).toContain(RESUME_BLOCKED[reason])
        expect(html).not.toContain(stopBar({ ...s, resume: undefined }, NOW, true).word)
      }
    }
    // A word this page doesn't know (a newer server): today's bar, Dismiss only.
    expect(stopBar({ ...ENDED, resume: 'later' as never }, NOW, true)).toEqual(stopBar(ENDED, NOW, true))
    // No resume field (a server before Resume): today's bar, Dismiss only.
    for (const s of [ENDED, APP_CLOSED]) {
      expect(stopBar(s, NOW, true)).toEqual({ ...stopBar(s, NOW, false), resume: false })
      expect(buttons(tab(s, BRIDGE))).toEqual(['Dismiss'])
      expect(tab(s, BRIDGE)).not.toContain(RESUME_LINE)
    }

    // While Resume runs: Resuming…, both buttons off. While Dismiss runs: both off too. The error box under the bar.
    const bar = stopBar({ ...ENDED, resume: 'ok' }, NOW, true)
    const panel = (o: { busy?: 'resume' | 'dismiss'; error?: string }) =>
      renderToStaticMarkup(createElement(StopBarPanel, { bar, ...o, onResume: () => {}, onDismiss: () => {} }))
    expect(buttons(panel({}))).toEqual(['Resume', 'Dismiss'])
    expect(disabled(panel({}))).toEqual([false, false])
    expect(buttons(panel({ busy: 'resume' }))).toEqual(['Resuming…', 'Dismiss'])
    expect(disabled(panel({ busy: 'resume' }))).toEqual([true, true])
    expect(panel({ busy: 'resume' })).toContain('aria-busy="true"')
    expect(buttons(panel({ busy: 'dismiss' }))).toEqual(['Resume', 'Dismiss'])
    expect(disabled(panel({ busy: 'dismiss' }))).toEqual([true, true])
    const failed = panel({ error: 'Ten sessions are open. End one, then try again' })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Ten sessions are open. End one, then try again')
    expect(failed.indexOf('stop-bar')).toBeLessThan(failed.indexOf('role="alert"'))
    expect(disabled(failed)).toEqual([false, false])
  })

  it('focus request', () => {
    // Open terminal: the page names the shown run, or no hash at all (the first run, shown by default).
    expect(focusRun('#/notes', '#/notes')).toBe('#/notes')
    expect(focusRun('', '#/notes/plan-a')).toBe('#/notes/plan-a')
    expect(focusRun('#/no%20such', '#/notes')).toBe('#/no%20such')
    // The ⋯ New session moves the page to the repo row in the same tick, before the screen shows it: the request is for it.
    expect(focusRun('#/notes', '#/other/plan-a')).toBe('#/notes')
    // A board, agent or encoded hash names its run's pipeline, as the screen's run key does.
    expect(focusRun('#/notes/plan-a/board/T1', '#/x')).toBe('#/notes/plan-a')
    expect(focusRun('#/notes/task-x/agent/a1', '#/x')).toBe('#/notes/task-x')
    expect(focusRun('#/my%20notes/plan-a', '#/x')).toBe('#/my%20notes/plan-a')
    // Junk names no run: the shown one.
    expect(focusRun('#junk', '#/notes')).toBe('#/notes')

    // A request stays while its run shows, and while none is asked; another run showing drops it.
    expect(keepFocusAsk('#/notes', '#/notes')).toBe(true)
    expect(keepFocusAsk(undefined, '#/notes')).toBe(true)
    expect(keepFocusAsk('#/notes', '#/other/plan-a')).toBe(false)

    // The view takes focus once attached; waits while it attaches; drops the request on a screen that can't take keys.
    expect(focusMove({ attached: true, ended: false, lost: false })).toBe('take')
    expect(focusMove({ attached: false, ended: false, lost: false })).toBe('wait')
    for (const attached of [true, false]) {
      expect(focusMove({ attached, ended: true, lost: false })).toBe('drop')
      expect(focusMove({ attached, ended: false, lost: true })).toBe('drop')
      expect(focusMove({ attached, ended: true, lost: true })).toBe('drop')
    }
  })

  it('browser rule', () => {
    // The browser build: the dot, the word, one line, and the desktop note. No button.
    expect(browserView(LIVE, NOW)).toEqual({ dot: 's-run', word: 'Live', line: 'The terminal started at 13:40.', note: DESKTOP_TERMINAL })
    expect(browserView(STARTING, NOW)).toEqual({ dot: 's-run', word: 'Starting', line: 'The terminal started at 13:40.', note: DESKTOP_TERMINAL })
    expect(browserView(WAITING, START + WAITING_AFTER_MS)).toEqual({ dot: 's-you', word: 'Waiting for you', line: 'The terminal started at 13:40.', note: DESKTOP_TERMINAL })
    expect(browserView(ENDED, NOW)).toEqual({ dot: 's-idle', word: 'Ended · Claude exited', line: 'The terminal ended at 14:02.', note: DESKTOP_TERMINAL })
    expect(browserView(APP_CLOSED, NOW)).toEqual({ dot: 's-idle', word: 'Stopped · app closed', line: ENDED_NO_TIME, note: DESKTOP_TERMINAL })

    for (const s of [LIVE, ENDED, APP_CLOSED]) {
      const html = renderToStaticMarkup(createElement(TerminalNote, { session: s, now: NOW }))
      const v = browserView(s, NOW)
      expect(html).toContain(`class="status ${v.dot}"`)
      expect(html).toContain(v.word)
      expect(html).toContain(v.line)
      expect(html).toContain(DESKTOP_TERMINAL)
      expect(html).not.toContain('<button')
      expect(html).not.toContain('Dismiss')
      expect(html).not.toContain('Resume')
    }

    // Never Resume in the browser: not in the note, not in its line, whatever the record's resume says.
    for (const s of [ENDED, APP_CLOSED, RESTARTED]) {
      for (const resume of ['ok', 'no folder', 'no conversation', 'in use'] as const) {
        const v = browserView({ ...s, resume }, NOW)
        expect(v).toEqual(browserView(s, NOW))
        expect(JSON.stringify(v)).not.toContain('Resume')
        expect(renderToStaticMarkup(createElement(TerminalNote, { session: { ...s, resume }, now: NOW }))).not.toContain('Resume')
      }
      // The tab with no bridge (it never draws there, but if it did): no Resume, no Resume line.
      const html = tab({ ...s, resume: 'ok' })
      expect(buttons(html)).toEqual(['Dismiss'])
      expect(html).not.toContain('Resume')
      expect(stopBar({ ...s, resume: 'ok' }, NOW, false).resume).toBe(false)
    }
  })

  it('screen under the bar', () => {
    // The host holds it: its replay, in xterm, faded. Else the saved screen, faded. Else the bar alone.
    expect(screenUnder({ ended: true, lost: undefined, saved: 'old text' })).toEqual({ show: 'terminal' })
    expect(screenUnder({ ended: true, lost: undefined, saved: undefined })).toEqual({ show: 'terminal' })
    for (const lost of ['gone', 'unavailable'] as const) {
      expect(screenUnder({ ended: true, lost, saved: 'old text' })).toEqual({ show: 'saved' })
      // An empty file is a screen too.
      expect(screenUnder({ ended: true, lost, saved: '' })).toEqual({ show: 'saved' })
      expect(screenUnder({ ended: true, lost, saved: undefined })).toEqual({ show: 'none' })
    }
    // A live session the host lacks: the unavailable line, never a saved screen.
    expect(screenUnder({ ended: false, lost: 'gone', saved: 'old text' })).toEqual({ show: 'none', line: UNAVAILABLE })
    expect(screenUnder({ ended: false, lost: undefined, saved: undefined })).toEqual({ show: 'terminal' })
    // The saved screen is asked for only once the host lacks an ended session.
    expect(wantSaved({ ended: true, lost: 'gone' })).toBe(true)
    expect(wantSaved({ ended: true, lost: 'unavailable' })).toBe(true)
    expect(wantSaved({ ended: true, lost: undefined })).toBe(false)
    expect(wantSaved({ ended: false, lost: 'gone' })).toBe(false)

    // Drawn: the text as text (never HTML), faded, hidden from screen readers like the faded terminal.
    const html = renderToStaticMarkup(createElement(SavedScreen, { text: 'line 1\n<b>2</b> & more' }))
    expect(html).toMatch(/class="term faded saved"/)
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('<pre class="term-saved">line 1\n&lt;b&gt;2&lt;/b&gt; &amp; more</pre>')
  })

  it('host paths', async () => {
    // The page's link to a fake host: each connect gives a new port, as the preload does.
    type Sent = { type: string; id?: string }
    const target = new EventTarget()
    const win = target as unknown as Window
    const ports: { sent: Sent[]; onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: Sent): void }[] = []
    let hostState: ((s: 'ready' | 'unresponsive' | 'restarted' | 'failed') => void) | undefined
    const bridge: TerminalBridge = {
      connect: vi.fn(async () => {
        const port = { sent: [] as Sent[], onmessage: null as ((e: { data: unknown }) => void) | null, postMessage(m: Sent) { this.sent.push(m) } }
        ports.push(port)
        const e = new Event('message') as Event & { data: unknown; source: unknown; ports: unknown[] }
        e.data = { type: 'openaflow:terminal-port' }
        e.source = win
        e.ports = [port]
        target.dispatchEvent(e)
      }),
      onHostState: (fn) => ((hostState = fn), () => {}),
    }
    const link = createTerminalLink(bridge, win)
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    // The view, as TerminalView runs it: attach when `canAttach`, with `screenHandlers`; draw what `screenUnder` says.
    const drawn: string[] = []
    let lost: 'gone' | 'unavailable' | undefined
    const term = { reset: () => drawn.splice(0), write: (d: string) => void drawn.push(d) }
    const handlers = screenHandlers(term, (l) => (lost = l))
    let opened = false
    const render = async (s: HostedSession) => {
      if (!opened && canAttach(s, NOW)) {
        opened = true
        await link.open(s.marker, { cols: 80, rows: 24 }, handlers)
      }
      await flush()
      return screenUnder({ ended: terminalBody(s, NOW, true).kind === 'stopped', lost, saved: undefined })
    }

    // Starting: no attach (not even a connect), while the host may not hold it yet.
    expect(canAttach(STARTING, NOW)).toBe(false)
    expect(await render(STARTING)).toEqual({ show: 'terminal' })
    expect(bridge.connect).not.toHaveBeenCalled()
    // Live: resize, then attach; the replay draws.
    expect(canAttach(LIVE, NOW)).toBe(true)
    expect(canAttach(WAITING, START + WAITING_AFTER_MS)).toBe(true)
    await render(LIVE)
    expect(ports[0]!.sent.map((m) => m.type)).toEqual(['resize', 'attach'])
    ports[0]!.onmessage!({ data: { type: 'replay', id: LIVE.marker, data: 'screen 1' } })
    expect(drawn).toEqual(['screen 1'])

    // The host failed for good: the unavailable line in place of the terminal.
    hostState!('failed')
    expect(lost).toBe('unavailable')
    expect(await render(LIVE)).toEqual({ show: 'none', line: UNAVAILABLE })

    // The host restarted: the page connects again and attaches again; the replay brings the terminal back.
    hostState!('restarted')
    await flush()
    expect(ports).toHaveLength(2)
    expect(ports[1]!.sent.map((m) => m.type)).toEqual(['resize', 'attach'])
    ports[1]!.onmessage!({ data: { type: 'replay', id: LIVE.marker, data: 'screen 2' } })
    expect(lost).toBeUndefined()
    expect(drawn).toEqual(['screen 2'])
    expect(await render(LIVE)).toEqual({ show: 'terminal' })
    // Live data after it, acked once written.
    ports[1]!.onmessage!({ data: { type: 'data', id: LIVE.marker, data: 'more' } })
    expect(drawn).toEqual(['screen 2', 'more'])

    // A restart the host lost the session in: gone, and a live session reads unavailable.
    hostState!('restarted')
    await flush()
    ports[2]!.onmessage!({ data: { type: 'error', id: LIVE.marker, error: 'no session' } })
    expect(lost).toBe('gone')
    expect(await render(LIVE)).toEqual({ show: 'none', line: UNAVAILABLE })
  })

  it('view scrollback', () => {
    const look = { theme: {}, fontFamily: 'f', fontSize: 13 } as never
    const opts = (scrollback: number | undefined, ended = false) => terminalOptions({ look, scrollback, ended })
    // The session's value, else 5,000 (xterm's own default is 1,000).
    expect(opts(200).scrollback).toBe(200)
    expect(opts(100_000).scrollback).toBe(100_000)
    expect(opts(undefined).scrollback).toBe(5_000)
    expect(DEFAULT_SCROLLBACK).toBe(5_000)
    // The rest of today's options stay.
    expect(opts(undefined, true)).toMatchObject({ minimumContrastRatio: 4.5, cursorBlink: true, disableStdin: true, fontFamily: 'f' })
    expect(opts(undefined, false).disableStdin).toBe(false)
  })
})

describe('sideload stop line', () => {
  const BLOCKED = session({ state: 'ended', exitCode: 1, endedAt: END, hooked: false, prompted: false, blocked: 'sideload', resume: 'ok' })
  const LINE = "Claude couldn't start. Your organization's disableSideloadFlags setting blocks the plugins OpenAFlow loads."

  it('names disableSideloadFlags, offers no Resume, keeps Dismiss', () => {
    expect(SIDELOAD_LINE).toBe(LINE)
    const bar = stopBar(BLOCKED, NOW, true)
    expect(bar.line).toBe(LINE)
    expect(bar.resume).toBe(false)
    const html = tab(BLOCKED, BRIDGE)
    expect(buttons(html)).toEqual(['Dismiss'])
    expect(html).toMatch(/<code class="stop-code">disableSideloadFlags<\/code>/)
    expect(html.replace(/<[^>]+>/g, '')).toContain(text(LINE))
    expect(html).not.toContain(RESUME_LINE)
    // Even with a resume reason, the sideload line wins and no Resume shows.
    expect(buttons(tab({ ...BLOCKED, resume: 'in use' }, BRIDGE))).toEqual(['Dismiss'])
  })

  it('shows the same line for a stopped session', () => {
    expect(stopBar({ ...BLOCKED, state: 'stopped' }, NOW, true).line).toBe(LINE)
  })
})

describe('other ends unchanged', () => {
  it('an ended session with no blocked field reads as before', () => {
    for (const s of [ENDED, ENDED_CODE, APP_CLOSED, ENDED_UNTIMED]) {
      expect(stopBar(s, NOW, true)).not.toHaveProperty('code')
      expect(tab(s, BRIDGE)).not.toContain('disableSideloadFlags')
    }
    expect(stopBar({ ...ENDED, resume: 'ok' }, NOW, true).resume).toBe(true)
    expect(buttons(tab({ ...ENDED, resume: 'ok' }, BRIDGE))).toEqual(['Resume', 'Dismiss'])
  })
})
