// Add repo: a path field in the shared modal, with Browse… (the desktop shell's folder dialog) beside it in the
// desktop app. The rules are in add-repo-flow.ts; this file only wires them. The opener (screen 1's sidebar)
// puts focus back on its button after `onClose`, so `onClose` runs only once the modal has left the page and the
// page is no longer inert.
import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { postAction } from '../../actions-client.ts'
import { postRepo } from '../../add-repo.ts'
import { Modal } from '../../components/Modal.tsx'
import { DialogAlert } from '../../components/DialogAlert.tsx'
import { folderBridge } from '../../desktop-bridge.ts'
import { Icon } from '../../theme/icons.tsx'
import { canAdd, createAddRepoFlow, pathHint, type AddRepoFlow, type AddRepoState } from './add-repo-flow.ts'

/** `repoPaths` is kept for the opener; the modal doesn't use it. */
type Props = { repoPaths: string[]; onClose: () => void }

export function AddRepoDialog({ onClose }: Props) {
  const [state, setState] = useState<AddRepoState | undefined>(undefined)
  // Closing is read from the state, so the parent hears of it after the modal is gone.
  const [flow] = useState(() => createAddRepoFlow({ pick: folderBridge(), post: (p) => postRepo(p), setupRepo: (path) => postAction('setup-workflow', { path }), onClose: () => {} }, setState))
  const close = useRef(onClose)
  close.current = onClose
  const view = state ?? flow.state()

  useEffect(() => {
    if (view.kind === 'closed') close.current()
  }, [view.kind])

  if (view.kind === 'form') return <AddRepoForm state={view} flow={flow} />
  return view.kind === 'confirm' ? <AddRepoConfirm state={view} flow={flow} /> : null
}

type FormProps = { state: Extract<AddRepoState, { kind: 'form' }>; flow: AddRepoFlow }

/**
 * The modal, top to bottom: the heading; the field group (the label, a row with the path field and Browse…
 * (desktop only), and a path error inline under the row); a system error in the shared alert box; then Cancel and
 * Add. A path error marks the field invalid and turns Add off (`canAdd`). Spacing is in runs.css.
 */
export function AddRepoForm({ state, flow }: FormProps) {
  const headingId = useId()
  const fieldId = useId()
  const errorId = useId()
  const field = useRef<HTMLInputElement>(null)
  const browse = useRef<HTMLButtonElement>(null)
  const add = useRef<HTMLButtonElement>(null)
  // After the modal's showModal(): a closed dialog can't take focus.
  useEffect(() => field.current?.focus(), [])
  // After a pick's answer or a refused Add, once the controls are on again. Any other change carries no `focus`.
  useEffect(() => {
    const target = { add, browse, path: field, none: undefined }[state.focus ?? 'none']
    target?.current?.focus()
  }, [state])
  const pathError = state.error !== undefined && state.pathError === true

  return (
    <Modal labelledBy={headingId} busy={state.busy} onClose={flow.cancel} className="add-repo-modal">
      <h2 id={headingId} className="modal-heading">
        Add repo
      </h2>
      <div className="add-repo-field">
        <label className="modal-detail" htmlFor={fieldId}>
          The repo folder's full path
        </label>
        <div className="add-repo-row">
          <input
            ref={field}
            id={fieldId}
            className="input mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={pathHint(typeof navigator === 'undefined' ? '' : navigator.userAgent)}
            value={state.path}
            readOnly={state.busy}
            aria-invalid={pathError ? 'true' : undefined}
            aria-describedby={state.error ? errorId : undefined}
            onChange={(e) => flow.type(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              void flow.add()
            }}
          />
          {state.canChoose && (
            <button ref={browse} className="btn lead" type="button" disabled={state.busy} onClick={() => void flow.choose()}>
              <Icon name="folder" />
              Browse…
            </button>
          )}
        </div>
        {pathError && (
          <p id={errorId} className="modal-field-error" role="alert">
            <Icon name="alert" />
            <span>{state.error}</span>
          </p>
        )}
      </div>
      {state.error && !pathError && <DialogAlert id={errorId} message={state.error} />}
      <div className="modal-actions">
        <button className="btn quiet" type="button" disabled={state.busy} onClick={flow.cancel}>
          Cancel
        </button>
        <button ref={add} className="btn primary" type="button" disabled={!canAdd(state)} onClick={() => void flow.add()}>
          Add
        </button>
      </div>
    </Modal>
  )
}

type ConfirmProps = { state: Extract<AddRepoState, { kind: 'confirm' }>; flow: AddRepoFlow }

/**
 * The setup question after a repo with no `.openaflow/` was added: the heading, the facts (a labelled list under an
 * open Details, DESIGN.md "Forms and errors"), a system error in the shared alert box, then Not now (quiet) and
 * Create (primary). Create takes focus, and takes it back after a refusal. Both buttons are off while busy.
 */
export function AddRepoConfirm({ state, flow }: ConfirmProps) {
  const headingId = useId()
  const create = useRef<HTMLButtonElement>(null)
  useEffect(() => create.current?.focus(), [state.busy, state.error])
  const facts = [
    { label: 'Folder', value: state.path },
    { label: 'Creates', value: '.openaflow/workflows/claude-pod/' },
  ]
  return (
    <Modal labelledBy={headingId} busy={state.busy} onClose={flow.cancel} className="add-repo-modal">
      <h2 id={headingId} className="modal-heading">
        Create <span className="mono">.openaflow/</span> in this repo?
      </h2>
      <details className="modal-details" open>
        <summary>Details</summary>
        <dl>
          {facts.map((f) => (
            <Fragment key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </Fragment>
          ))}
        </dl>
      </details>
      {state.error && <DialogAlert message={state.error} />}
      <div className="modal-actions">
        <button className="btn quiet" type="button" disabled={state.busy} onClick={flow.notNow}>
          Not now
        </button>
        <button ref={create} className="btn primary" type="button" disabled={state.busy} onClick={() => void flow.create()}>
          Create
        </button>
      </div>
    </Modal>
  )
}
