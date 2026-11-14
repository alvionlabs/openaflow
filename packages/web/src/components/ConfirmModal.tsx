// A yes-or-no question in the shared modal: the heading, the detail, the facts an undo needs (a labelled list under
// an open Details disclosure, DESIGN.md "Forms and errors"), muted notes, the status and the error (the shared alert box), then Cancel (quiet) and the confirm (danger). Busy turns both buttons off; after a refusal, Cancel takes focus.
import { Fragment, useEffect, useId, useRef } from 'react'
import { Modal } from './Modal.tsx'
import { FIRST_FOCUS, focusAfterRefusal } from './modal.ts'
import { ModalAlert } from './ModalAlert.tsx'

/** One fact in the Details list: a muted label and its mono value, such as `Port base` and `3400`. */
export type ConfirmDetail = { label: string; value: string }

export type ConfirmModalProps = {
  heading: string
  detail: string
  details?: ConfirmDetail[]
  notes?: string[]
  confirmLabel: string
  busy: boolean
  status?: string
  error?: string
  onConfirm: () => void
  onCancel: () => void
  /** The id that takes focus back on close, unless focus moved elsewhere. */
  returnFocusTo: string
}

export function ConfirmModal({ heading, detail, details, notes, confirmLabel, busy, status, error, onConfirm, onCancel, returnFocusTo }: ConfirmModalProps) {
  const headingId = useId()
  const actions = useRef<HTMLDivElement>(null)
  const wasBusy = useRef(busy)
  useEffect(() => {
    focusAfterRefusal(actions.current, wasBusy.current, { busy, error })
    wasBusy.current = busy
  }, [busy, error])
  return (
    <Modal labelledBy={headingId} busy={busy} onClose={onCancel} className="confirm-modal" returnFocusTo={returnFocusTo}>
      <h2 id={headingId} className="modal-heading">
        {heading}
      </h2>
      <p className="modal-detail">{detail}</p>
      {details && details.length > 0 && (
        // Open on each mount: the modal mounts anew each time it opens, so a fold lasts only while it is open.
        <details className="modal-details" open>
          <summary>Details</summary>
          <dl>
            {details.map((d) => (
              <Fragment key={d.label}>
                <dt>{d.label}</dt>
                <dd>{d.value}</dd>
              </Fragment>
            ))}
          </dl>
        </details>
      )}
      {notes?.map((line, i) => (
        <p key={`n${i}`} className="muted modal-note">
          {line}
        </p>
      ))}
      <p className="muted modal-status" role="status">
        {status}
      </p>
      {error && <ModalAlert message={error} />}
      <div className="modal-actions" ref={actions}>
        {/* The safe button takes the first focus, and focus again after a refusal, so Enter deletes nothing and keeps the Details list open. */}
        <button className="btn quiet" type="button" disabled={busy} onClick={onCancel} {...{ [FIRST_FOCUS]: '' }}>
          Cancel
        </button>
        <button className="btn danger" type="button" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
