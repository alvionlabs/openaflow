import { describe, expect, it, vi } from 'vitest'
import type { SettingsChange, SettingsView } from '@openaflow/model'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActionReply } from '../../actions-client.ts'
import type { LoginBridge } from '../../desktop-bridge.ts'
import { RELOAD } from '../../add-repo.ts'
import type { SettingsRead } from './settings-client.ts'
import { Field, SettingsPage } from './SettingsScreen.tsx'
import {
  createSettingsFlow,
  LOGIN_FAILED,
  LOGIN_UNREAD,
  pageSections,
  STOP_SKIPPED,
  type SettingsDeps,
  type SettingsFlow,
  type SettingsState,
} from './settings-view.ts'

const WRAP = 'systemd-run --user --scope --quiet --unit=openaflow-run-{runId}.scope'
const STOP = 'systemctl --user stop openaflow-run-{runId}.scope'
const LINUX: SettingsView = {
  scrollback: 5000,
  wrapper: {
    runWrapper: WRAP,
    stopCommand: STOP,
    isDefault: true,
    defaults: { runWrapper: WRAP, stopCommand: STOP },
    preview: `systemd-run --user --scope --quiet "--unit=openaflow-run-<run id>.scope" claude --session-id "<session id>"`,
  },
}
const WINDOWS: SettingsView = { scrollback: 5000 }
const changed = (over: Partial<NonNullable<SettingsView['wrapper']>> = {}, scrollback = 5000): SettingsView => ({
  scrollback,
  wrapper: { ...LINUX.wrapper!, isDefault: false, ...over },
})

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A flow on fakes. `save` answers with `answer(change)` unless a test holds it. */
function setup(over: Partial<SettingsDeps> & { view?: SettingsView; answer?: (c: SettingsChange) => ActionReply<SettingsView> } = {}) {
  const view = over.view ?? LINUX
  let current = view
  const answer =
    over.answer ??
    ((c: SettingsChange): ActionReply<SettingsView> => {
      const w = current.wrapper
      const next: SettingsView = { scrollback: c.scrollback ?? current.scrollback }
      if (w) {
        const runWrapper = c.runWrapper === null ? WRAP : (c.runWrapper ?? w.runWrapper)
        const stopCommand = c.stopCommand === null ? STOP : (c.stopCommand ?? w.stopCommand)
        next.wrapper = { ...w, runWrapper, stopCommand, isDefault: runWrapper === WRAP && stopCommand === STOP, preview: `${runWrapper} claude` }
      }
      current = next
      return { ok: true, data: next }
    })
  const save = vi.fn(over.save ?? (async (c: SettingsChange) => answer(c)))
  const reset = vi.fn(over.reset ?? (async () => answer({ runWrapper: null, stopCommand: null })))
  const load = vi.fn(over.load ?? (async (): Promise<SettingsRead> => ({ ok: true, view })))
  const states: SettingsState[] = []
  const reload = vi.fn(over.reload ?? (() => {}))
  const flow = createSettingsFlow({ load, save, reset, reload, ...(over.login ? { login: over.login } : {}) }, (s) => states.push(s))
  return { flow, save, reset, load, reload, states }
}

const ready = (flow: SettingsFlow) => {
  const s = flow.state()
  if (s.kind !== 'ready') throw new Error(`not ready: ${s.kind}`)
  return s
}
async function started(over: Parameters<typeof setup>[0] = {}) {
  const t = setup(over)
  t.flow.start()
  await vi.waitFor(() => expect(t.flow.state().kind).not.toBe('loading'))
  return t
}
const settle = () => new Promise((r) => setTimeout(r, 0))

const noop = () => {}
const handlers = { start: noop, retry: noop, type: noop, commit: noop, escape: noop, toggleLogin: noop, resetWrapper: noop, stop: noop, state: () => ({ kind: 'loading' as const }) }
const html = (state: SettingsState) => renderToStaticMarkup(createElement(SettingsPage, { state, flow: handlers, onBack: noop }))
const text = (h: string) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
const login = (on = false): LoginBridge & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } => ({
  get: vi.fn(async () => on),
  set: vi.fn(async (v: boolean) => v),
})

describe('sections per build and platform', () => {
  it('General only with the login bridge; Run wrapper only with `wrapper`; Terminals always', () => {
    expect(pageSections(LINUX, false)).toEqual({ general: false, wrapper: { reset: false } })
    expect(pageSections(changed(), true)).toEqual({ general: true, wrapper: { reset: true } })
    expect(pageSections(WINDOWS, true)).toEqual({ general: true })
    expect(pageSections(WINDOWS, false)).toEqual({ general: false })
  })

  it('the browser build has no General section', async () => {
    const { flow } = await started()
    const page = html(flow.state())
    expect(page).not.toMatch(/General/)
    expect(page).not.toMatch(/role="switch"/)
    expect(page).toMatch(/<h2[^>]*>Terminals<\/h2>/)
    expect(page).toMatch(/<h2[^>]*>Run wrapper<\/h2>/)
  })

  it('the desktop build shows General first, with the Open at login switch and its line', async () => {
    const { flow } = await started({ login: login(true) })
    const page = html(flow.state())
    expect(page.indexOf('>General<')).toBeGreaterThan(-1)
    expect(page.indexOf('>General<')).toBeLessThan(page.indexOf('>Terminals<'))
    expect(page).toMatch(/<button[^>]*class="switch"[^>]*role="switch"[^>]*aria-checked="true"[^>]*>Open at login<\/button>/)
    expect(text(page)).toMatch(/Start OpenAFlow in the tray when you sign in\./)
  })

  it('Windows (no `wrapper`) has no Run wrapper section, and no wrapper or stop field', async () => {
    const { flow } = await started({ view: WINDOWS })
    const page = html(flow.state())
    expect(page).not.toMatch(/Run wrapper|Wrapper command|Stop command|Reset to default|Full command/)
    expect(page).toMatch(/Scrollback/)
    expect(text(page)).toMatch(/lines per terminal/)
  })

  it('Reset is off when `isDefault`, on otherwise', async () => {
    const off = html((await started()).flow.state())
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Reset to default<\/button>/)
    const on = html((await started({ view: changed({ runWrapper: '' }) })).flow.state())
    expect(on).toMatch(/<button(?![^>]*disabled)[^>]*>Reset to default<\/button>/)
  })

  it('the preview shows as given; the `fallback` and `stopSkipped` lines show only when set', async () => {
    const plain = html((await started()).flow.state())
    expect(plain).toContain('<div class="settings-preview mono">systemd-run --user --scope --quiet &quot;--unit=openaflow-run-&lt;run id&gt;.scope&quot; claude --session-id &quot;&lt;session id&gt;&quot;</div>')
    expect(plain).not.toMatch(/settings-note/)
    expect(text(plain)).not.toContain(STOP_SKIPPED)

    const reason = 'systemd-run --user --scope failed: exit 1: Failed to connect to bus'
    const both = html((await started({ view: changed({ fallback: reason, stopSkipped: true, isDefault: true }) })).flow.state())
    expect(both).toContain(`<p class="settings-note muted">${reason}</p>`)
    expect(both).toContain(`<p class="settings-note muted">${STOP_SKIPPED}</p>`)
    expect(STOP_SKIPPED).toBe('The default stop command runs only with the default run wrapper.')

    const onlySkip = html((await started({ view: changed({ runWrapper: '', stopSkipped: true }) })).flow.state())
    expect([...onlySkip.matchAll(/settings-note/g)]).toHaveLength(1)
  })

  it('loading says so with no error; a failed load shows the alert with Try again, which loads again', async () => {
    expect(html({ kind: 'loading' })).toMatch(/role="status"[^>]*>Loading settings…</)
    expect(html({ kind: 'loading' })).not.toMatch(/role="alert"/)
    const failedLoad = deferred<SettingsRead>()
    const { flow, load } = setup({ load: () => failedLoad.promise })
    flow.start()
    failedLoad.resolve({ ok: false, message: "Couldn't load settings. Please try again" })
    await vi.waitFor(() => expect(flow.state().kind).toBe('failed'))
    const page = html(flow.state())
    expect(page).toMatch(/class="modal-alert" role="alert"[\s\S]*Couldn&#x27;t load settings. Please try again/)
    expect(page).toMatch(/<button[^>]*>Try again<\/button>/)
    load.mockImplementation(async () => ({ ok: true, view: LINUX }))
    flow.retry()
    expect(flow.state().kind).toBe('loading')
    await vi.waitFor(() => expect(flow.state().kind).toBe('ready'))
  })

  it('while the API is down, Try again keeps loading again, and shows the page once it is back', async () => {
    const down: SettingsRead = { ok: false, message: "Couldn't load settings. Please try again" }
    const { flow, load, reload } = setup({ load: async () => down })
    flow.start()
    await vi.waitFor(() => expect(flow.state().kind).toBe('failed'))
    expect(html(flow.state())).toMatch(/<button[^>]*>Try again<\/button>/)
    flow.retry()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(flow.state().kind).toBe('failed'))
    expect(html(flow.state())).toMatch(/<button[^>]*>Try again<\/button>/)
    load.mockImplementation(async () => ({ ok: true, view: LINUX }))
    flow.retry()
    await vi.waitFor(() => expect(flow.state().kind).toBe('ready'))
    expect(reload).not.toHaveBeenCalled()
  })

  it('after an API restart the page says so and offers Reload, which reloads the page and loads nothing', async () => {
    const restarted: SettingsRead = { ok: false, message: RELOAD, reload: true }
    const { flow, load, reload } = setup({ load: async () => restarted })
    flow.start()
    await vi.waitFor(() => expect(flow.state().kind).toBe('failed'))
    const page = html(flow.state())
    expect(text(page)).toContain(RELOAD)
    expect(page).toMatch(/class="modal-alert" role="alert"/)
    expect(page).toMatch(/<button[^>]*>Reload<\/button>/)
    expect(page).not.toContain('Try again')
    flow.retry()
    expect(reload).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledTimes(1)
    expect(flow.state().kind).toBe('failed')
  })

  it('Reload is the Reload button: it calls retry, as Try again does', () => {
    const retry = vi.fn()
    const el = createElement(SettingsPage, { state: { kind: 'failed', message: RELOAD, reload: true }, flow: { ...handlers, retry }, onBack: noop })
    const button = (node: unknown): { props: { onClick: () => void; children: string } } | undefined => {
      const n = node as { type?: unknown; props?: { children?: unknown } }
      if (n?.type === 'button' && (n.props?.children === 'Reload' || n.props?.children === 'Try again')) return n as never
      const kids = n?.props?.children
      for (const k of Array.isArray(kids) ? kids : [kids]) {
        const found = k && typeof k === 'object' ? button(k) : undefined
        if (found) return found
      }
      return undefined
    }
    const rendered = (SettingsPage as unknown as (p: typeof el.props) => unknown)(el.props)
    const b = button(rendered)
    expect(b?.props.children).toBe('Reload')
    b!.props.onClick()
    expect(retry).toHaveBeenCalledOnce()
  })
})

describe('saves at once', () => {
  it('the field hands blur, Enter, and Escape to the flow, and nothing for other keys', () => {
    const flow = { ...handlers, commit: vi.fn(), escape: vi.fn(), type: vi.fn() }
    const el = Field({ name: 'runWrapper', field: { text: 'x', saved: 'y', busy: false }, flow })
    const props = el.props as {
      onBlur: () => void
      onKeyDown: (e: { key: string; preventDefault: () => void }) => void
      onChange: (e: { target: { value: string } }) => void
    }
    props.onBlur()
    expect(flow.commit).toHaveBeenLastCalledWith('runWrapper', 'blur')
    const press = (key: string) => {
      const preventDefault = vi.fn()
      props.onKeyDown({ key, preventDefault })
      return preventDefault
    }
    expect(press('Enter')).toHaveBeenCalled()
    expect(flow.commit).toHaveBeenLastCalledWith('runWrapper', 'enter')
    expect(press('Escape')).toHaveBeenCalled()
    expect(flow.escape).toHaveBeenCalledWith('runWrapper')
    expect(press('a')).not.toHaveBeenCalled()
    expect(flow.commit).toHaveBeenCalledTimes(2)
    expect(flow.escape).toHaveBeenCalledTimes(1)
    props.onChange({ target: { value: 'z' } })
    expect(flow.type).toHaveBeenCalledWith('runWrapper', 'z')
  })

  it('a field posts only on a changed blur or Enter', async () => {
    const { flow, save } = await started()
    // Unchanged: nothing goes out.
    flow.commit('scrollback', 'blur')
    flow.commit('runWrapper', 'enter')
    expect(save).not.toHaveBeenCalled()
    // Typing alone saves nothing.
    flow.type('scrollback', '200')
    expect(save).not.toHaveBeenCalled()
    flow.commit('scrollback', 'blur')
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ scrollback: 200 }))
    await vi.waitFor(() => expect(ready(flow).fields.scrollback).toMatchObject({ text: '200', saved: '200', busy: false }))
    flow.type('runWrapper', '')
    flow.commit('runWrapper', 'enter')
    await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith({ runWrapper: '' }))
    await vi.waitFor(() => expect(ready(flow).view.wrapper?.runWrapper).toBe(''))
    flow.type('stopCommand', '/bin/stop {unit}')
    flow.commit('stopCommand', 'blur')
    await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith({ stopCommand: '/bin/stop {unit}' }))
    await settle()
    expect(save).toHaveBeenCalledTimes(3)
  })

  it('Enter then blur sends one post; a field is busy (read-only) until its answer', async () => {
    const held = deferred<ActionReply<SettingsView>>()
    const { flow, save } = await started({ save: () => held.promise })
    flow.type('scrollback', '300')
    flow.commit('scrollback', 'enter')
    expect(ready(flow).fields.scrollback.busy).toBe(true)
    expect(html(flow.state())).toMatch(/<input[^>]*id="settings-scrollback"[^>]*readOnly=""/)
    flow.commit('scrollback', 'blur')
    flow.type('scrollback', '400')
    expect(ready(flow).fields.scrollback.text).toBe('300')
    held.resolve({ ok: true, data: { ...LINUX, scrollback: 300 } })
    await vi.waitFor(() => expect(ready(flow).fields.scrollback.busy).toBe(false))
    flow.commit('scrollback', 'blur')
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('Escape restores the saved text and clears the error; a blur after it sends nothing', async () => {
    const { flow, save } = await started({ answer: () => ({ ok: false, status: 400, message: 'run wrapper: unclosed quote' }) })
    flow.type('runWrapper', 'a "b')
    flow.escape('runWrapper')
    expect(ready(flow).fields.runWrapper).toMatchObject({ text: WRAP, saved: WRAP })
    flow.commit('runWrapper', 'blur')
    expect(save).not.toHaveBeenCalled()
    // After a refusal, too.
    flow.type('runWrapper', 'a "b')
    flow.commit('runWrapper', 'enter')
    await vi.waitFor(() => expect(ready(flow).fields.runWrapper.error).toBeDefined())
    flow.escape('runWrapper')
    const f = ready(flow).fields.runWrapper
    expect(f.text).toBe(WRAP)
    expect(f.error).toBeUndefined()
    expect(f.invalid).toBeUndefined()
    flow.commit('runWrapper', 'blur')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a 400 word shows under its field with the text kept', async () => {
    const { flow } = await started({ answer: () => ({ ok: false, status: 400, message: 'run wrapper: unclosed quote' }) })
    flow.type('runWrapper', 'a "b')
    flow.commit('runWrapper', 'enter')
    await vi.waitFor(() => expect(ready(flow).fields.runWrapper.busy).toBe(false))
    expect(ready(flow).fields.runWrapper).toMatchObject({ text: 'a "b', saved: WRAP, error: 'run wrapper: unclosed quote', invalid: true })
    const page = html(flow.state())
    const input = /<input[^>]*id="settings-runWrapper"[^>]*>/.exec(page)?.[0] ?? ''
    expect(input).toContain('value="a &quot;b"')
    expect(input).toContain('aria-invalid="true"')
    expect(input).toContain('aria-describedby="settings-runWrapper-error"')
    // Directly under its own field, red with the alert icon; the other fields stay clean.
    expect(page).toMatch(/id="settings-runWrapper"[^>]*>(?:<small[^>]*>[\s\S]*?<\/small>)?<p id="settings-runWrapper-error" class="settings-error" role="alert"><svg[\s\S]*?<\/svg><span>run wrapper: unclosed quote<\/span><\/p>/)
    expect(/<input[^>]*id="settings-stopCommand"[^>]*>/.exec(page)?.[0]).not.toContain('aria-invalid')
    // The view (and its preview) stay as saved.
    expect(ready(flow).view).toEqual(LINUX)
  })

  it('a blur with the text just refused sends nothing; Enter sends it again', async () => {
    const { flow, save } = await started({ answer: () => ({ ok: false, status: 400, message: 'bad scrollback' }) })
    flow.type('scrollback', '99')
    flow.commit('scrollback', 'enter')
    await vi.waitFor(() => expect(ready(flow).fields.scrollback.error).toBe('bad scrollback'))
    flow.commit('scrollback', 'blur')
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
    flow.commit('scrollback', 'enter')
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    // A new text on blur goes out.
    flow.type('scrollback', '98')
    flow.commit('scrollback', 'blur')
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3))
  })

  it('a Scrollback that is no whole number is refused here with the server’s word, and never posted', async () => {
    const { flow, save } = await started()
    for (const typed of ['', '  ', 'abc', '1.5', '1e3', '5 000']) {
      flow.type('scrollback', typed)
      flow.commit('scrollback', 'enter')
      expect(ready(flow).fields.scrollback).toMatchObject({ text: typed, error: 'bad scrollback', invalid: true, busy: false })
    }
    expect(save).not.toHaveBeenCalled()
    // A whole number out of range is the server's to judge; spaces around it are fine.
    flow.type('scrollback', ' 100000 ')
    flow.commit('scrollback', 'enter')
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ scrollback: 100000 }))
  })

  it('other failures show their words under the field, not marked invalid, with the text kept', async () => {
    for (const [status, message] of [
      [500, 'not saved'],
      [403, RELOAD],
      [0, "Can't reach the board."],
    ] as const) {
      const { flow } = await started({ answer: () => ({ ok: false, status, message }) })
      flow.type('stopCommand', '/bin/stop')
      flow.commit('stopCommand', 'blur')
      await vi.waitFor(() => expect(ready(flow).fields.stopCommand.busy).toBe(false))
      expect(ready(flow).fields.stopCommand).toMatchObject({ text: '/bin/stop', error: message })
      expect(ready(flow).fields.stopCommand.invalid).toBeUndefined()
      const input = /<input[^>]*id="settings-stopCommand"[^>]*>/.exec(html(flow.state()))?.[0] ?? ''
      expect(input).not.toContain('aria-invalid')
      expect(input).toContain('aria-describedby="settings-stopCommand-error"')
    }
    // A save that throws reads as unreachable.
    const { flow } = await started({
      save: async () => {
        throw new Error('boom')
      },
    })
    flow.type('scrollback', '200')
    flow.commit('scrollback', 'blur')
    await vi.waitFor(() => expect(ready(flow).fields.scrollback.error).toBe("Can't reach the board."))
  })

  it('a saved answer updates the view and the preview, and keeps unsaved typing in another field', async () => {
    const { flow } = await started()
    flow.type('stopCommand', '/bin/stop half-typed')
    flow.type('runWrapper', '/usr/bin/env')
    flow.commit('runWrapper', 'enter')
    await vi.waitFor(() => expect(ready(flow).fields.runWrapper.busy).toBe(false))
    const s = ready(flow)
    expect(s.view.wrapper?.preview).toBe('/usr/bin/env claude')
    expect(s.fields.runWrapper).toMatchObject({ text: '/usr/bin/env', saved: '/usr/bin/env' })
    expect(s.fields.stopCommand).toMatchObject({ text: '/bin/stop half-typed', saved: STOP })
    expect(text(html(s))).toContain('/usr/bin/env claude')
  })

  it('the server’s saved text replaces what was typed (the default text, trimmed)', async () => {
    const { flow } = await started({ answer: () => ({ ok: true, data: LINUX }) })
    flow.type('runWrapper', `  ${WRAP}  `)
    flow.commit('runWrapper', 'blur')
    await vi.waitFor(() => expect(ready(flow).fields.runWrapper.busy).toBe(false))
    expect(ready(flow).fields.runWrapper).toMatchObject({ text: WRAP, saved: WRAP })
  })

  it('posts go one at a time, in order, and the last answer wins', async () => {
    const holds: Deferred<ActionReply<SettingsView>>[] = []
    const { flow, save } = await started({
      save: () => {
        const d = deferred<ActionReply<SettingsView>>()
        holds.push(d)
        return d.promise
      },
    })
    flow.type('scrollback', '200')
    flow.commit('scrollback', 'blur')
    flow.type('runWrapper', '/usr/bin/env')
    flow.commit('runWrapper', 'blur')
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
    holds[0]!.resolve({ ok: true, data: { ...LINUX, scrollback: 200 } })
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save).toHaveBeenLastCalledWith({ runWrapper: '/usr/bin/env' })
    const last = changed({ runWrapper: '/usr/bin/env', preview: '/usr/bin/env claude' }, 200)
    holds[1]!.resolve({ ok: true, data: last })
    await vi.waitFor(() => expect(ready(flow).view).toEqual(last))
    expect(ready(flow).fields.scrollback.text).toBe('200')
  })

  it('Reset posts at once (after a dirty field’s own save), sets both fields, and clears their errors; it does nothing when default', async () => {
    const { flow, save, reset } = await started()
    flow.resetWrapper()
    expect(reset).not.toHaveBeenCalled()
    flow.type('runWrapper', '/usr/bin/env')
    flow.commit('runWrapper', 'blur')
    await vi.waitFor(() => expect(ready(flow).view.wrapper?.isDefault).toBe(false))
    // A refused stop command, then Reset.
    save.mockImplementationOnce(async () => ({ ok: false, status: 400, message: 'stop command: no program' }))
    flow.type('stopCommand', '""')
    flow.commit('stopCommand', 'blur')
    flow.resetWrapper()
    expect(ready(flow).reset.busy).toBe(true)
    expect(html(flow.state())).toMatch(/<button[^>]*disabled=""[^>]*>Reset to default<\/button>/)
    await vi.waitFor(() => expect(ready(flow).reset.busy).toBe(false))
    expect(reset).toHaveBeenCalledTimes(1)
    const s = ready(flow)
    expect(s.view.wrapper?.isDefault).toBe(true)
    expect(s.fields.runWrapper).toMatchObject({ text: WRAP, saved: WRAP })
    expect(s.fields.stopCommand).toMatchObject({ text: STOP, saved: STOP })
    expect(s.fields.stopCommand.error).toBeUndefined()
  })

  it('a failed Reset shows its words beside the button and keeps the fields', async () => {
    const { flow } = await started({ view: changed({ runWrapper: '' }), reset: async () => ({ ok: false, status: 500, message: 'not saved' }) })
    flow.resetWrapper()
    await vi.waitFor(() => expect(ready(flow).reset.busy).toBe(false))
    expect(ready(flow).reset.error).toBe('not saved')
    expect(ready(flow).fields.runWrapper.text).toBe('')
    expect(html(flow.state())).toMatch(/Reset to default<\/button><p id="settings-reset-error" class="settings-error" role="alert"><svg[\s\S]*?<\/svg><span>not saved<\/span><\/p>/)
  })

  it('after stop (Back), a late answer is dropped', async () => {
    const held = deferred<ActionReply<SettingsView>>()
    const late = deferred<SettingsRead>()
    const { flow, states } = setup({ load: () => late.promise, save: () => held.promise })
    flow.start()
    flow.stop()
    late.resolve({ ok: true, view: LINUX })
    await settle()
    expect(flow.state().kind).toBe('loading')
    expect(states).toEqual([])

    const t = await started({ save: () => held.promise })
    t.flow.type('scrollback', '200')
    t.flow.commit('scrollback', 'blur')
    const seen = t.states.length
    t.flow.stop()
    // An edit then Back: the blur's post still goes out.
    await vi.waitFor(() => expect(t.save).toHaveBeenCalledWith({ scrollback: 200 }))
    held.resolve({ ok: true, data: { ...LINUX, scrollback: 200 } })
    await settle()
    expect(t.states).toHaveLength(seen)
  })
})

describe('mount and unmount', () => {
  it('a start after stop takes answers again, with one load: React’s StrictMode mounts, unmounts, and mounts again', async () => {
    const held = deferred<SettingsRead>()
    const bridge = login(true)
    const { flow, load } = setup({ load: () => held.promise, login: bridge })
    flow.start()
    flow.stop()
    flow.start()
    held.resolve({ ok: true, view: LINUX })
    await vi.waitFor(() => expect(flow.state().kind).toBe('ready'))
    await vi.waitFor(() => expect(ready(flow).login).toEqual({ on: true, busy: false }))
    expect(load).toHaveBeenCalledTimes(1)
    expect(bridge.get).toHaveBeenCalledTimes(1)
  })
})

describe('login switch', () => {
  it('reads the state at start; the switch is off and disabled until it answers', async () => {
    const read = deferred<boolean>()
    const bridge = { get: vi.fn(() => read.promise), set: vi.fn(async (v: boolean) => v) }
    const { flow } = await started({ login: bridge })
    expect(ready(flow).login).toEqual({ on: false, busy: true })
    expect(html(flow.state())).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*disabled=""/)
    read.resolve(true)
    await vi.waitFor(() => expect(ready(flow).login).toEqual({ on: true, busy: false }))
  })

  it('saves on change: the answer that matches the ask shows no error', async () => {
    const bridge = login(false)
    const { flow } = await started({ login: bridge })
    await vi.waitFor(() => expect(ready(flow).login?.busy).toBe(false))
    flow.toggleLogin()
    expect(bridge.set).toHaveBeenCalledWith(true)
    expect(ready(flow).login?.busy).toBe(true)
    // A second press while one is out does nothing.
    flow.toggleLogin()
    expect(bridge.set).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(ready(flow).login).toEqual({ on: true, busy: false }))
  })

  it('an answer that differs from the ask shows "Couldn\'t change Open at login" and the state read', async () => {
    expect(LOGIN_FAILED).toBe("Couldn't change Open at login")
    const bridge = login(false)
    bridge.set.mockImplementation(async () => false)
    const { flow } = await started({ login: bridge })
    await vi.waitFor(() => expect(ready(flow).login?.busy).toBe(false))
    flow.toggleLogin()
    await vi.waitFor(() => expect(ready(flow).login).toEqual({ on: false, busy: false, error: LOGIN_FAILED }))
    const page = html(flow.state())
    expect(page).toMatch(/aria-checked="false"/)
    expect(page).toMatch(/aria-describedby="settings-login-line settings-login-error"/)
    expect(page).toMatch(/<p id="settings-login-error" class="settings-error" role="alert"><svg[\s\S]*?<\/svg><span>Couldn&#x27;t change Open at login<\/span><\/p>/)
    // The next press that works clears it.
    bridge.set.mockImplementation(async (v: boolean) => v)
    flow.toggleLogin()
    await vi.waitFor(() => expect(ready(flow).login).toEqual({ on: true, busy: false }))
  })

  it('a rejection shows the error and the state read after it, or the state before when that read fails too', async () => {
    const bridge = login(true)
    bridge.set.mockImplementation(async () => {
      throw new Error('login item failed')
    })
    const { flow } = await started({ login: bridge })
    await vi.waitFor(() => expect(ready(flow).login?.busy).toBe(false))
    // The write half-happened: the read after says off.
    bridge.get.mockImplementation(async () => false)
    flow.toggleLogin()
    expect(bridge.set).toHaveBeenCalledWith(false)
    await vi.waitFor(() => expect(ready(flow).login).toEqual({ on: false, busy: false, error: LOGIN_FAILED }))
    expect(bridge.get).toHaveBeenCalledTimes(2)
    // The read fails as well: the switch keeps what it showed.
    bridge.get.mockImplementation(async () => {
      throw new Error('login item failed')
    })
    flow.toggleLogin()
    await vi.waitFor(() => expect(ready(flow).login).toEqual({ on: false, busy: false, error: LOGIN_FAILED }))
  })

  it('a first read that fails shows its own line, and the switch can still be pressed', async () => {
    const bridge = login(false)
    bridge.get.mockImplementation(async () => {
      throw new Error('login item failed')
    })
    const { flow } = await started({ login: bridge })
    await vi.waitFor(() => expect(ready(flow).login).toEqual({ on: false, busy: false, error: LOGIN_UNREAD }))
    expect(LOGIN_UNREAD).toBe("Couldn't read Open at login")
    expect(html(flow.state())).toMatch(/<button[^>]*role="switch"(?![^>]*disabled)[^>]*>Open at login<\/button>/)
    flow.toggleLogin()
    await vi.waitFor(() => expect(ready(flow).login).toEqual({ on: true, busy: false }))
  })

  it('the switch answers even while the settings still load or failed to', async () => {
    const never = new Promise<SettingsRead>(() => {})
    const bridge = login(true)
    const { flow } = setup({ load: () => never, login: bridge })
    flow.start()
    await settle()
    expect(flow.state().kind).toBe('loading')
    // Once the settings come, the read is already there.
    const t = setup({ login: bridge })
    t.flow.start()
    await vi.waitFor(() => expect(t.flow.state().kind).toBe('ready'))
    await vi.waitFor(() => expect(ready(t.flow).login).toEqual({ on: true, busy: false }))
  })
})
