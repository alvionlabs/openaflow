// The settings page with no DOM (settings §8): what it shows for a SettingsView, and how each change saves at once.
// SettingsScreen.tsx only wires it.

import type { SettingsChange, SettingsView } from '@openaflow/model'
import { UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import type { LoginBridge } from '../../desktop-bridge.ts'
import type { SettingsRead } from './settings-client.ts'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'

/** The answer of GET /api/settings and POST /api/actions/settings, or undefined when it isn't one. */
export function parseSettingsView(data: unknown): SettingsView | undefined {
  if (!isObject(data) || typeof data.scrollback !== 'number' || !Number.isInteger(data.scrollback)) return undefined
  if (data.wrapper === undefined) return { scrollback: data.scrollback }
  const w = data.wrapper
  if (!isObject(w) || !isText(w.runWrapper) || !isText(w.stopCommand) || typeof w.isDefault !== 'boolean' || !isText(w.preview)) return undefined
  if (!isObject(w.defaults) || !isText(w.defaults.runWrapper) || !isText(w.defaults.stopCommand)) return undefined
  if (w.fallback !== undefined && !isText(w.fallback)) return undefined
  if (w.stopSkipped !== undefined && w.stopSkipped !== true) return undefined
  return {
    scrollback: data.scrollback,
    wrapper: {
      runWrapper: w.runWrapper,
      stopCommand: w.stopCommand,
      isDefault: w.isDefault,
      defaults: { runWrapper: w.defaults.runWrapper, stopCommand: w.defaults.stopCommand },
      preview: w.preview,
      ...(w.fallback !== undefined ? { fallback: w.fallback } : {}),
      ...(w.stopSkipped ? { stopSkipped: true as const } : {}),
    },
  }
}

export const STOP_SKIPPED = 'The default stop command runs only with the default run wrapper.'
export const LOGIN_FAILED = "Couldn't change Open at login"
export const LOGIN_UNREAD = "Couldn't read Open at login"

export type FieldName = 'scrollback' | 'runWrapper' | 'stopCommand'
export type FieldState = { text: string; saved: string; busy: boolean; error?: string; invalid?: true; refused?: string }
export type LoginState = { on: boolean; busy: boolean; error?: string }
export type SettingsState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string; reload?: true }
  | { kind: 'ready'; view: SettingsView; fields: Record<FieldName, FieldState>; reset: { busy: boolean; error?: string }; login?: LoginState }

export type SettingsDeps = {
  load: () => Promise<SettingsRead>
  /** Loads the page again, for the one state a retry can't help: the API restarted. */
  reload: () => void
  save: (change: SettingsChange) => Promise<ActionReply<SettingsView>>
  reset: () => Promise<ActionReply<SettingsView>>
  login?: LoginBridge | undefined
}

/** The failed page's one button. */
export const retryLabel = (s: Extract<SettingsState, { kind: 'failed' }>) => (s.reload ? 'Reload' : 'Try again')

export type PageSections = { general: boolean; wrapper?: { reset: boolean; fallback?: string; stopNote?: string } }

/** What the page shows for a view: General with the desktop shell's login calls; Run wrapper where the server has one. */
export function pageSections(view: SettingsView, desktop: boolean): PageSections {
  const w = view.wrapper
  if (!w) return { general: desktop }
  return {
    general: desktop,
    wrapper: {
      reset: !w.isDefault,
      ...(w.fallback !== undefined ? { fallback: w.fallback } : {}),
      ...(w.stopSkipped ? { stopNote: STOP_SKIPPED } : {}),
    },
  }
}

/** A field's saved text in a view. */
function savedText(view: SettingsView, field: FieldName): string {
  if (field === 'scrollback') return String(view.scrollback)
  return view.wrapper?.[field] ?? ''
}

const WHOLE = /^-?\d+$/

/** The body a field's text posts, or undefined for a Scrollback that is no whole number (`bad scrollback`, as the server says). */
function changeFor(field: FieldName, text: string): SettingsChange | undefined {
  if (field !== 'scrollback') return { [field]: text }
  const t = text.trim()
  return WHOLE.test(t) ? { scrollback: Number(t) } : undefined
}

const FIELDS: readonly FieldName[] = ['scrollback', 'runWrapper', 'stopCommand']

export type SettingsFlow = ReturnType<typeof createSettingsFlow>

/**
 * The page's rules. Each change saves at once: a field on a blur or Enter when its text differs from the saved
 * text, the switch on each press, Reset on its press. Posts go one at a time, in order; each answer is the whole
 * view, so the last one wins. A field is read-only while its post is out. A refused save keeps the typed text and
 * shows the words under that field (`invalid` only for a 400: the text itself was refused). Escape puts the saved
 * text back and clears the error. A blur doesn't post the text that was just refused again; Enter does. After
 * `stop`, nothing changes and late answers are dropped.
 */
export function createSettingsFlow(deps: SettingsDeps, onChange: (s: SettingsState) => void) {
  let state: SettingsState = { kind: 'loading' }
  // Kept apart from `state`: the switch reads and answers while the settings load or failed to.
  let login: LoginState | undefined
  let stopped = false
  let started = false
  let queue: Promise<unknown> = Promise.resolve()

  const show = (next: SettingsState) => {
    if (stopped) return
    state = next.kind === 'ready' ? withLogin(next) : next
    onChange(state)
  }
  const withLogin = (s: Extract<SettingsState, { kind: 'ready' }>): SettingsState => {
    const { login: _old, ...rest } = s
    return login ? { ...rest, login } : rest
  }
  const setLogin = (next: LoginState) => {
    if (stopped) return
    login = next
    if (state.kind === 'ready') show(state)
  }
  const ready = () => (state.kind === 'ready' ? state : undefined)
  const setField = (field: FieldName, patch: FieldState) => {
    const s = ready()
    if (s) show({ ...s, fields: { ...s.fields, [field]: patch } })
  }

  /** Runs `work` after every post before it. */
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work, work)
  }

  /**
   * A new view from the server. `posted` fields take its text; any other field takes it only when it had no
   * unsaved typing.
   */
  const applyView = (view: SettingsView, posted: readonly FieldName[]) => {
    const s = ready()
    if (!s) return
    const fields = { ...s.fields }
    for (const name of FIELDS) {
      const cur = fields[name]
      const saved = savedText(view, name)
      if (posted.includes(name)) fields[name] = { text: saved, saved, busy: false }
      else fields[name] = { ...cur, saved, text: cur.text === cur.saved ? saved : cur.text }
    }
    show({ ...s, view, fields })
  }

  const load = () => {
    void deps.load().then((read) => {
      if (stopped) return
      if (!read.ok) return show({ kind: 'failed', message: read.message, ...(read.reload ? { reload: true as const } : {}) })
      const fields = Object.fromEntries(FIELDS.map((f) => [f, { text: savedText(read.view, f), saved: savedText(read.view, f), busy: false }])) as Record<FieldName, FieldState>
      show({ kind: 'ready', view: read.view, fields, reset: { busy: false } })
    })
  }

  const readLogin = (bridge: LoginBridge) => {
    login = { on: false, busy: true }
    void bridge.get().then(
      (on) => setLogin({ on, busy: false }),
      () => setLogin({ on: false, busy: false, error: LOGIN_UNREAD }),
    )
  }

  const post = (field: FieldName, change: SettingsChange, text: string) => {
    enqueue(async () => {
      let reply: ActionReply<SettingsView>
      try {
        reply = await deps.save(change)
      } catch {
        reply = { ok: false, status: 0, message: UNREACHABLE }
      }
      if (stopped) return
      if (reply.ok) return applyView(reply.data, [field])
      const s = ready()
      if (!s) return
      setField(field, { ...s.fields[field], text, busy: false, error: reply.message, refused: text, ...(reply.status === 400 ? { invalid: true as const } : {}) })
    })
  }

  return {
    state: (): SettingsState => state,
    /** Loads once. A start after `stop` takes answers again: React's StrictMode mounts, unmounts, and mounts again. */
    start() {
      stopped = false
      if (started) return
      started = true
      if (deps.login) readLogin(deps.login)
      load()
    },
    /** Try again, after a failed load; after an API restart, Reload: a new load would send the same stale token. */
    retry() {
      if (state.kind !== 'failed') return
      if (state.reload) return deps.reload()
      show({ kind: 'loading' })
      load()
    },
    type(field: FieldName, text: string) {
      const s = ready()
      if (!s || s.fields[field].busy) return
      setField(field, { ...s.fields[field], text })
    },
    commit(field: FieldName, how: 'blur' | 'enter') {
      const s = ready()
      if (!s) return
      const f = s.fields[field]
      if (f.busy || f.text === f.saved) return
      if (how === 'blur' && f.refused === f.text) return
      const change = changeFor(field, f.text)
      if (!change) return setField(field, { text: f.text, saved: f.saved, busy: false, error: 'bad scrollback', invalid: true, refused: f.text })
      setField(field, { text: f.text, saved: f.saved, busy: true })
      post(field, change, f.text)
    },
    escape(field: FieldName) {
      const s = ready()
      if (!s || s.fields[field].busy) return
      const { saved } = s.fields[field]
      setField(field, { text: saved, saved, busy: false })
    },
    toggleLogin() {
      const bridge = deps.login
      const was = login
      if (!bridge || !was || was.busy) return
      const ask = !was.on
      setLogin({ on: was.on, busy: true })
      void bridge.set(ask).then(
        (on) => setLogin(on === ask ? { on, busy: false } : { on, busy: false, error: LOGIN_FAILED }),
        () =>
          bridge.get().then(
            (on) => setLogin({ on, busy: false, error: LOGIN_FAILED }),
            () => setLogin({ on: was.on, busy: false, error: LOGIN_FAILED }),
          ),
      )
    },
    /** Reset to default: both run wrapper keys go. Off while the wrapper is the default. */
    resetWrapper() {
      const s = ready()
      if (!s || !s.view.wrapper || s.view.wrapper.isDefault || s.reset.busy) return
      show({ ...s, reset: { busy: true } })
      enqueue(async () => {
        let reply: ActionReply<SettingsView>
        try {
          reply = await deps.reset()
        } catch {
          reply = { ok: false, status: 0, message: UNREACHABLE }
        }
        if (stopped) return
        const now = ready()
        if (!now) return
        if (!reply.ok) return show({ ...now, reset: { busy: false, error: reply.message } })
        show({ ...now, reset: { busy: false } })
        applyView(reply.data, ['runWrapper', 'stopCommand'])
      })
    },
    /** Back, or the page left: nothing more changes. */
    stop() {
      stopped = true
    },
  }
}
