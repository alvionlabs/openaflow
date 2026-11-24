// Add repo, with no DOM: AddRepoDialog.tsx only wires it.
//
// The modal opens first, with an empty path field, in the desktop app and in the browser build. No folder dialog
// opens by itself. With the desktop bridge, Browse… sits beside the field and opens the folder dialog: a picked
// folder fills the field and clears any error, but posts nothing; you then press Add. Cancel in the dialog leaves
// the modal as it was. A dialog that can't open shows BRIDGE_FAILED in the alert box and keeps the modal.
// `focus` tells the modal where focus goes after a pick: Add after a folder, Browse… after a cancel, the field
// after a failure. After a refused Add, focus goes to the field too.
//
// Add is off while the modal shows a path error (already here, or a path that doesn't look right); a change to the path clears
// it. After any other error, Add stays on, so the same path can be tried again.
//
// After a 201 with `openaflow: false` the modal moves to a confirm step (never closing at once): Create posts
// `setup-workflow` for the added path and closes on success; Not now (or Escape) closes and writes nothing. A failed
// setup shows its words in the alert box and keeps the step, so Create works again; the repo stays added. A 201 with
// `openaflow: true` or with no field closes as before.
//
// The modal is busy while a post or a folder dialog is out: Add, Browse…, and Cancel then do nothing, so one
// post runs at a time. After close, nothing more happens, and a late answer is dropped.

import { UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import { addError, setupError, type AddResult } from '../../add-repo.ts'
import type { PickFolder } from '../../desktop-bridge.ts'

export const BRIDGE_FAILED = "The folder dialog didn't open. You can type the path"

/** The path field's example, in the form of the user's own system. The app and the browser run on one machine. */
export function pathHint(userAgent: string): string {
  if (/Windows/.test(userAgent)) return 'C:\\code\\my-repo'
  if (/Macintosh|Mac OS X/.test(userAgent)) return '/Users/you/code/my-repo'
  return '/home/you/code/my-repo'
}

export type AddRepoState =
  /** The modal. `path` is the field as typed; `canChoose` shows Browse…; `focus` is set by a pick's answer or a refused Add. */
  | { kind: 'form'; path: string; busy: boolean; canChoose: boolean; error?: string; pathError?: boolean; focus?: PickFocus }
  /** The setup question for the added repo at `path`; `error` is the failed setup's line. */
  | { kind: 'confirm'; path: string; busy: boolean; error?: string }
  | { kind: 'closed' }

/** Where focus goes after a pick: Add (a folder), Browse… (a cancel), or the path field (a failure, or a refused Add). */
export type PickFocus = 'add' | 'browse' | 'path'

export type AddRepoDeps = {
  /** The desktop folder dialog (`folderBridge()`); none in the browser build. */
  pick?: PickFolder | undefined
  post: (path: string) => Promise<AddResult>
  /** `setup-workflow { path }` through the action client. */
  setupRepo: (path: string) => Promise<ActionReply<unknown>>
  onClose: () => void
}

/** Add is on in an idle modal whose path isn't blank and that shows no path error. Typing clears the error. */
export function canAdd(s: AddRepoState): boolean {
  return s.kind === 'form' && !s.busy && !(s.error && s.pathError) && s.path.trim() !== ''
}

export type AddRepoFlow = ReturnType<typeof createAddRepoFlow>

export function createAddRepoFlow(deps: AddRepoDeps, onChange: (s: AddRepoState) => void) {
  const { pick } = deps
  let state: AddRepoState = { kind: 'form', path: '', busy: false, canChoose: pick !== undefined }

  const set = (next: AddRepoState) => {
    if (state.kind === 'closed') return
    state = next
    onChange(state)
  }
  const close = () => {
    if (state.kind === 'closed') return
    set({ kind: 'closed' })
    deps.onClose()
  }
  /** The modal, keeping what isn't given. */
  const showForm = (patch: { path?: string; busy: boolean; error?: string | undefined; pathError?: boolean | undefined; focus?: PickFocus }) => {
    const path = patch.path ?? (state.kind === 'form' ? state.path : '')
    const next: AddRepoState = { kind: 'form', path, busy: patch.busy, canChoose: pick !== undefined }
    if (patch.error !== undefined) next.error = patch.error
    if (patch.error !== undefined && patch.pathError) next.pathError = true
    if (patch.focus) next.focus = patch.focus
    set(next)
  }

  /** Posts `path`; 201 closes, else the modal shows the error with `shown` in the field. */
  const post = async (path: string, shown: string) => {
    let result: AddResult
    try {
      result = await deps.post(path)
    } catch {
      result = { status: 0, error: UNREACHABLE }
    }
    if (state.kind === 'closed') return
    if (result.status === 201 && result.openaflow === false) set({ kind: 'confirm', path, busy: false })
    else if (result.status === 201) close()
    else {
      const e = addError(result)
      // Add was off while busy and lost focus: the field takes it, to fix the path or press Enter again.
      showForm({ path: shown, busy: false, error: e.message, pathError: e.pathError, focus: 'path' })
    }
  }

  // A function, so TypeScript reads the state afresh after an await.
  const isClosed = () => state.kind === 'closed'
  const busy = () => state.kind === 'form' && state.busy

  return {
    state: () => state,
    type(text: string) {
      if (state.kind !== 'form' || state.busy) return
      set({ kind: 'form', path: text, busy: false, canChoose: state.canChoose })
    },
    async add() {
      if (!canAdd(state) || state.kind !== 'form') return
      const shown = state.path
      showForm({ busy: true })
      await post(shown.trim(), shown)
    },
    /** Browse…: the folder dialog. A folder fills the field and posts nothing; a cancel keeps the modal as it was. */
    async choose() {
      if (!pick || state.kind !== 'form' || state.busy) return
      const before = state
      showForm({ busy: true, error: before.error, pathError: before.pathError })
      let chosen: string | null
      try {
        chosen = await pick()
      } catch {
        if (!isClosed()) set({ kind: 'form', path: before.path, busy: false, canChoose: true, error: BRIDGE_FAILED, focus: 'path' })
        return
      }
      if (isClosed()) return
      if (typeof chosen !== 'string' || chosen === '') set({ ...before, focus: 'browse' })
      else set({ kind: 'form', path: chosen, busy: false, canChoose: true, focus: 'add' })
    },
    /** Create: sets the added repo up. Success closes; a failure keeps the step with its words. */
    async create() {
      if (state.kind !== 'confirm' || state.busy) return
      const { path } = state
      set({ kind: 'confirm', path, busy: true })
      let reply: ActionReply<unknown>
      try {
        reply = await deps.setupRepo(path)
      } catch {
        reply = { ok: false, status: 0, message: UNREACHABLE }
      }
      if (reply.ok) close()
      else set({ kind: 'confirm', path, busy: false, error: setupError(reply.message) })
    },
    /** Not now: closes and writes nothing. */
    notNow() {
      if (state.kind !== 'confirm' || state.busy) return
      close()
    },
    /** Cancel or Escape: Cancel in the form, Not now in the confirm step. */
    cancel() {
      if (busy() || (state.kind === 'confirm' && state.busy)) return
      close()
    },
  }
}
