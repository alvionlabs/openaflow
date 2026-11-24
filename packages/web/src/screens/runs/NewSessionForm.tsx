// The New session form (sprint terminal-tab N1, draft section 2): "Start with" (the skill listbox), the text field, and
// New session. The Next step card's start card and the ⋯ menu's modal both draw it. The rules are in
// new-session-flow.ts; this file only wires them. The workflow's lines (sprint default-workflow §9) read the repo and
// the Board's bundle from WorkflowContext, which RunsScreen provides.
import { createContext, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { BoardRepo, SkillId } from '@openaflow/model'
import { Listbox } from '../../components/Listbox.tsx'
import { DialogAlert } from '../../components/DialogAlert.tsx'
import { ModalAlert } from '../../components/ModalAlert.tsx'
import { Icon } from '../../theme/icons.tsx'
import {
  TEXT_MAX,
  createNewSessionFlow,
  isBusy,
  setupOffer,
  skillItems,
  textLabel,
  versionLine,
  workflowNotice,
  type BundledWorkflow,
  type NewSessionFlow,
  type NewSessionState,
  type WrapperError,
} from './new-session-flow.ts'
import '../../components/modal.css'
import './new-session.css'

const ITEMS = skillItems()

/** The Board's bundle and repos, for the form's workflow lines. The form is drawn by NextStepCard and the ⋯ menu's modal. */
export type WorkflowContextValue = { workflow?: BundledWorkflow; repos: readonly BoardRepo[] }
export const WorkflowContext = createContext<WorkflowContextValue>({ repos: [] })

/**
 * The flow, fed each Board's copy of `repo`, and dropped when the caller leaves. Held by the card (not the form), so the
 * flow still moves to the Terminal tab after the Board lists the session and the start card leaves.
 */
export function useNewSession(repo: BoardRepo): [NewSessionState, NewSessionFlow] {
  const [state, setState] = useState<NewSessionState>({ kind: 'idle' })
  const [flow] = useState(() => createNewSessionFlow(setState))
  useEffect(() => flow.board(repo), [repo, flow])
  useEffect(() => () => flow.dispose(), [flow])
  return [state, flow]
}

/**
 * The alert box for a run wrapper or stop command refusal (draft section 4): the title, the line, the reason as code
 * (it wraps, whatever its length), and Open settings. Used by the form and by the stop bar.
 */
export function WrapperErrorBox({ title, wrapper, onOpenSettings, id }: { title: string; wrapper: WrapperError; onOpenSettings(): void; id?: string }) {
  return (
    <div id={id} className="modal-alert wrapper-error" role="alert">
      <Icon name="alert" />
      <div className="wrapper-error-body">
        <p className="modal-alert-text">
          <b>{title}</b>
        </p>
        <p className="wrapper-error-line">{wrapper.line}</p>
        <code className="mono wrapper-error-code">{wrapper.code}</code>
        <div>
          <button className="btn" type="button" onClick={onOpenSettings}>
            Open settings
          </button>
        </div>
      </div>
    </div>
  )
}

type Props = {
  repoId: string
  state: NewSessionState
  flow: NewSessionFlow
  /** Focus the text field on mount (the modal). The card never takes focus by itself. */
  focusText?: boolean
  /** The modal's Cancel, before New session. */
  cancel?: ReactNode
  /**
   * In the modal, whose backdrop covers the Reload banner: a stale-token error gets its own Reload (DialogAlert). On
   * the Next step card the banner stays in view, so the error box has none.
   */
  inDialog?: boolean
}

/**
 * Top to bottom: the "Start with" group, the text group (its error under the field), a box for any other error, a
 * quiet note, then the actions. Busy: the button reads "Starting…" and every control is off. After a start the
 * text clears.
 */
export function NewSessionForm({ repoId, state, flow, focusText, cancel, inDialog = false }: Props) {
  const skillLabel = useId()
  const skillId = useId()
  const textId = useId()
  const errorId = useId()
  const [skill, setSkill] = useState<SkillId>('plan')
  const [text, setText] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const busy = isBusy(state)
  const idle = state.kind === 'idle' ? state : undefined
  const posting = state.kind === 'posting' ? state.action : undefined
  const { workflow, repos } = useContext(WorkflowContext)
  const repo = repos.find((r) => r.id === repoId)
  const notice = workflowNotice(repo, workflow)
  const offer = setupOffer(repo)
  const version = versionLine(repo, workflow)

  useEffect(() => {
    if (focusText) field.current?.focus()
  }, [])
  useEffect(() => {
    if (idle?.done) setText('')
  }, [state])
  // A refused text: back to the field, to fix it.
  useEffect(() => {
    if (idle?.fieldError) field.current?.focus()
  }, [idle?.fieldError])
  // Use or Set up is done: its button leaves with the next Board, so focus goes to the text field.
  useEffect(() => {
    if (idle?.focusText) field.current?.focus()
  }, [state])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    flow.start({ repoId, skill, text })
  }

  return (
    <form className="new-session" noValidate aria-busy={busy} onSubmit={submit}>
      <div className="ns-group">
        <label id={skillLabel} className="ns-label" htmlFor={skillId}>
          Start with
        </label>
        <Listbox
          id={skillId}
          labelledBy={skillLabel}
          items={ITEMS}
          value={skill}
          disabled={busy}
          onChange={(v) => {
            setSkill(v as SkillId)
            flow.edit()
          }}
        />
      </div>
      <div className="ns-group">
        <label className="ns-label" htmlFor={textId}>
          {textLabel(skill)}
        </label>
        <input
          ref={field}
          id={textId}
          className="input mono ns-text"
          type="text"
          autoComplete="off"
          maxLength={TEXT_MAX}
          value={text}
          readOnly={busy}
          aria-invalid={idle?.fieldError ? 'true' : undefined}
          aria-describedby={idle?.fieldError || idle?.error ? errorId : undefined}
          onChange={(e) => {
            setText(e.target.value)
            flow.edit()
          }}
        />
        {idle?.fieldError && (
          <p id={errorId} className="modal-field-error" role="alert">
            <Icon name="alert" />
            <span>{idle.fieldError}</span>
          </p>
        )}
      </div>
      {idle?.error &&
        (idle.wrapper ? (
          <WrapperErrorBox id={errorId} title={idle.error} wrapper={idle.wrapper} onOpenSettings={flow.openSettings} />
        ) : (
          inDialog ? (
            <DialogAlert id={errorId} message={idle.error} />
          ) : (
            <ModalAlert id={errorId} message={idle.error} />
          )
        ))}
      <p className="note ns-note" role="status">
        {idle?.note ?? ''}
      </p>
      {notice && (
        <div className="ns-workflow">
          <p className="ns-workflow-text">{notice.text}</p>
          <button className="btn" type="button" disabled={busy} onClick={() => flow.useVersion(repoId, notice.name)}>
            {posting === 'use' ? 'Updating…' : notice.use}
          </button>
        </div>
      )}
      {offer && repo && (
        <div className="ns-workflow">
          <p className="ns-workflow-text">
            Create <code className="mono">.openaflow/</code> in this repo?
          </p>
          <button className="btn" type="button" disabled={busy} onClick={() => flow.setUp(repo.path)}>
            {posting === 'setup' ? 'Setting up…' : 'Set up'}
          </button>
        </div>
      )}
      {/* On the card the buttons stack on a phone, as every card action does; the modal keeps its row. */}
      <div className={cancel ? 'ns-actions' : 'ns-actions inplace-actions'}>
        {cancel}
        <button className="btn primary" type="submit" disabled={busy || idle?.fieldError !== undefined}>
          {state.kind === 'starting' || state.kind === 'waiting' ? 'Starting…' : 'New session'}
        </button>
      </div>
      {version && <p className="ns-version">{version}</p>}
    </form>
  )
}
