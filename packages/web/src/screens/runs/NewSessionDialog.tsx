// The ⋯ menu's New session: the card's form in the shared modal, with Cancel. It opens with focus in the text field
// (the form's field first, as DESIGN.md asks), and closes once the flow has moved to the repo row's Terminal tab.
import { useEffect, useId, useRef } from 'react'
import type { BoardRepo } from '@openaflow/model'
import { Modal } from '../../components/Modal.tsx'
import { NewSessionForm, useNewSession } from './NewSessionForm.tsx'
import { START_DETAIL } from './next-step.ts'
import { isBusy } from './new-session-flow.ts'

/** The header ⋯ trigger's id (BarMenu's MENU_TRIGGER_ID), named here so the two files don't import each other. */
const RETURN_TO = 'run-menu-trigger'

/** `repo`: each Board's copy of the repo the session starts in. */
export function NewSessionDialog({ repo, onClose }: { repo: BoardRepo; onClose: () => void }) {
  const headingId = useId()
  const [state, flow] = useNewSession(repo)
  const busy = isBusy(state)
  const close = useRef(onClose)
  close.current = onClose
  // Moved to the Terminal tab: the modal's work is done. With a note (the Board was slow), it stays to show it.
  useEffect(() => {
    if (state.kind === 'idle' && state.done && state.note === undefined) close.current()
  }, [state])

  return (
    <Modal labelledBy={headingId} busy={busy} onClose={onClose} className="new-session-modal" returnFocusTo={RETURN_TO}>
      <h2 id={headingId} className="modal-heading">
        New session in {repo.name}
      </h2>
      <p className="modal-detail">{START_DETAIL}</p>
      <NewSessionForm
        repoId={repo.id}
        state={state}
        flow={flow}
        focusText
        inDialog
        cancel={
          <button className="btn quiet" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        }
      />
    </Modal>
  )
}
