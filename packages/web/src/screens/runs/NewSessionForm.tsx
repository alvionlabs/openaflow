// The New session form (sprint terminal-tab N1, draft section 2): "Start with" (the skill listbox), the text field, and
// New session. The Next step card's start card and the ⋯ menu's modal both draw it. The rules are in
// new-session-flow.ts; this file only wires them.
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { BoardRepo, SkillId } from '@openaflow/model'
import { Listbox } from '../../components/Listbox.tsx'
import { ModalAlert } from '../../components/ModalAlert.tsx'
import { Icon } from '../../theme/icons.tsx'
import { TEXT_MAX, createNewSessionFlow, isBusy, skillItems, textLabel, type NewSessionFlow, type NewSessionState } from './new-session-flow.ts'
import '../../components/modal.css'
import './new-session.css'

const ITEMS = skillItems()

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

type Props = {
  repoId: string
  state: NewSessionState
  flow: NewSessionFlow
  /** Focus the text field on mount (the modal). The card never takes focus by itself. */
  focusText?: boolean
  /** The modal's Cancel, before New session. */
  cancel?: ReactNode
}

/**
 * Top to bottom: the "Start with" group, the text group (its error under the field), a box for any other error, a
 * quiet note, then the actions. Busy: the button reads "Starting…" and every control is off. After a start the
 * text clears.
 */
export function NewSessionForm({ repoId, state, flow, focusText, cancel }: Props) {
  const skillLabel = useId()
  const skillId = useId()
  const textId = useId()
  const errorId = useId()
  const [skill, setSkill] = useState<SkillId>('plan')
  const [text, setText] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const busy = isBusy(state)
  const idle = state.kind === 'idle' ? state : undefined

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
          className="input ns-text"
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
      {idle?.error && <ModalAlert id={errorId} message={idle.error} />}
      <p className="note ns-note" role="status">
        {idle?.note ?? ''}
      </p>
      {/* On the card the buttons stack on a phone, as every card action does; the modal keeps its row. */}
      <div className={cancel ? 'ns-actions' : 'ns-actions inplace-actions'}>
        {cancel}
        <button className="btn primary" type="submit" disabled={busy || idle?.fieldError !== undefined}>
          {busy ? 'Starting…' : 'New session'}
        </button>
      </div>
    </form>
  )
}
