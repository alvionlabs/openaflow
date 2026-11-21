// The settings page (settings §8, draft §6): it takes the main column beside the sidebar, with Back. Each change
// saves at once. The rules are in settings-view.ts; this file only wires them. Styles are in settings.css.
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ModalAlert } from '../../components/ModalAlert.tsx'
import { loginBridge } from '../../desktop-bridge.ts'
import { Icon } from '../../theme/icons.tsx'
import { readSettings, resetWrapper, saveSettings } from './settings-client.ts'
import { canRetry, createSettingsFlow, pageSections, type FieldName, type FieldState, type SettingsFlow, type SettingsState } from './settings-view.ts'
import '../../components/modal.css'
import './settings.css'

type Ready = Extract<SettingsState, { kind: 'ready' }>
type Handlers = Pick<SettingsFlow, 'retry' | 'type' | 'commit' | 'escape' | 'toggleLogin' | 'resetWrapper'>

/** The page with its own flow on the real requests and the desktop shell's login calls (none in the browser build). */
export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<SettingsState>({ kind: 'loading' })
  const [flow] = useState(() =>
    createSettingsFlow({ load: () => readSettings(), save: (c) => saveSettings(c), reset: () => resetWrapper(), login: loginBridge() }, setState),
  )
  useEffect(() => {
    flow.start()
    return () => flow.stop()
  }, [flow])
  return <SettingsPage state={state} flow={flow} onBack={onBack} />
}

const errorId = (name: string) => `settings-${name}-error`

/** A field's or an action's own error, directly under it: red text with the alert icon, no box (DESIGN.md). */
function InlineError({ name, message }: { name: string; message: string }) {
  return (
    <p id={errorId(name)} className="settings-error" role="alert">
      <Icon name="alert" />
      <span>{message}</span>
    </p>
  )
}

/** Back, the title, then the sections the view has. */
export function SettingsPage({ state, flow, onBack }: { state: SettingsState; flow: Handlers; onBack: () => void }) {
  return (
    <div className="settings">
      <div className="settings-bar">
        <button className="btn ghost" type="button" onClick={onBack}>
          Back
        </button>
        <h1 className="settings-title">Settings</h1>
      </div>
      {state.kind === 'loading' && (
        <p className="muted" role="status">
          Loading settings…
        </p>
      )}
      {state.kind === 'failed' && (
        <div className="settings-failed">
          <ModalAlert message={state.message} />
          {canRetry(state) && (
            <div>
              <button className="btn" type="button" onClick={flow.retry}>
                Try again
              </button>
            </div>
          )}
        </div>
      )}
      {state.kind === 'ready' && <Sections state={state} flow={flow} />}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={title}>
      <h2 className="settings-head">{title}</h2>
      {children}
    </section>
  )
}

function Sections({ state, flow }: { state: Ready; flow: Handlers }) {
  const login = state.login
  const shown = pageSections(state.view, login !== undefined)
  const wrapper = state.view.wrapper
  return (
    <>
      {shown.general && login && (
        <Section title="General">
          <div className="settings-field">
            <button
              className="switch"
              type="button"
              role="switch"
              aria-checked={login.on}
              aria-describedby={login.error ? `settings-login-line ${errorId('login')}` : 'settings-login-line'}
              disabled={login.busy}
              onClick={flow.toggleLogin}
            >
              Open at login
            </button>
            <small id="settings-login-line" className="settings-help">
              Start OpenAFlow in the tray when you sign in.
            </small>
            {login.error && <InlineError name="login" message={login.error} />}
          </div>
        </Section>
      )}
      <Section title="Terminals">
        <div className="settings-field">
          <label className="settings-label" htmlFor="settings-scrollback">
            Scrollback
          </label>
          <div className="settings-row">
            <Field name="scrollback" field={state.fields.scrollback} flow={flow} number />
            <span className="muted settings-unit">lines per terminal</span>
          </div>
          {state.fields.scrollback.error && <InlineError name="scrollback" message={state.fields.scrollback.error} />}
          <small className="settings-help">Kept for the screen you see after a reopen and next to Resume. Applies to new sessions.</small>
        </div>
      </Section>
      {wrapper && shown.wrapper && (
        <Section title="Run wrapper">
          <div className="settings-field">
            <label className="settings-label" htmlFor="settings-runWrapper">
              Wrapper command
            </label>
            <Field name="runWrapper" field={state.fields.runWrapper} flow={flow} />
            {state.fields.runWrapper.error && <InlineError name="runWrapper" message={state.fields.runWrapper.error} />}
            <small className="settings-help">
              Runs before <code>claude</code>, with no shell. Placeholders: <code>{'{runId}'}</code>, <code>{'{unit}'}</code>. Leave it empty for no wrapper.
            </small>
          </div>
          <div className="settings-field">
            <label className="settings-label" htmlFor="settings-stopCommand">
              Stop command
            </label>
            <Field name="stopCommand" field={state.fields.stopCommand} flow={flow} />
            {state.fields.stopCommand.error && <InlineError name="stopCommand" message={state.fields.stopCommand.error} />}
          </div>
          <div className="settings-field">
            <span className="settings-label" id="settings-preview-label">
              Full command for a new session
            </span>
            <div className="settings-preview mono">{wrapper.preview}</div>
            {shown.wrapper.fallback !== undefined && <p className="settings-note muted">{shown.wrapper.fallback}</p>}
            {shown.wrapper.stopNote !== undefined && <p className="settings-note muted">{shown.wrapper.stopNote}</p>}
          </div>
          <div className="settings-field">
            <div>
              <button className="btn" type="button" disabled={!shown.wrapper.reset || state.reset.busy} onClick={flow.resetWrapper}>
                Reset to default
              </button>
              {state.reset.error && <InlineError name="reset" message={state.reset.error} />}
            </div>
          </div>
        </Section>
      )}
    </>
  )
}

/** One text field: it saves on a changed blur or Enter, and Escape puts the saved text back. */
export function Field({ name, field, flow, number = false }: { name: FieldName; field: FieldState; flow: Handlers; number?: boolean }) {
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      flow.commit(name, 'enter')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      flow.escape(name)
    }
  }
  return (
    <input
      id={`settings-${name}`}
      className={number ? 'input mono settings-number' : 'input mono settings-text'}
      type={number ? 'number' : 'text'}
      inputMode={number ? 'numeric' : undefined}
      autoComplete="off"
      spellCheck={false}
      value={field.text}
      readOnly={field.busy}
      aria-invalid={field.invalid ? 'true' : undefined}
      aria-describedby={field.error ? errorId(name) : undefined}
      onChange={(e) => flow.type(name, e.target.value)}
      onBlur={() => flow.commit(name, 'blur')}
      onKeyDown={onKey}
    />
  )
}
