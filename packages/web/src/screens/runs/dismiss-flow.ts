// Dismiss on the Terminal tab's stop bar (sprint terminal-tab §5): posts `dismiss-session` once, and says why in the
// alert box when it is refused. A 404 `no session` means the session is already gone (another window dismissed it),
// so it ends like a dismissal. Pure but for its post; TerminalTab.tsx is the glue.

import type { DismissSessionResult } from '@openaflow/model'
import { postAction, UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import { refusalText, warnUnknown, type Post } from './remove-flow.ts'

/** 409 `session is live`: the record went back to live, or the page's Board is behind. */
export const STILL_RUNNING = 'This terminal is still running, so it stays'

/** The dismiss route's words, for the alert box. Short and warm, with no period at the end (DESIGN.md). */
export const DISMISS_ERRORS: ReadonlyMap<string, string> = new Map([
  ['session is live', STILL_RUNNING],
  ['no terminal host', "The terminals aren't running. Restart the app and try again"],
  ['bad request', "Something's off. Please reload and try again"],
  [UNREACHABLE, "Can't reach the board. Please try again"],
])

/** `idle` with `error` after a refusal; `dismissing` while the request is out. */
export type DismissState = { kind: 'idle'; error?: string } | { kind: 'dismissing' }
export type DismissTarget = { repoId: string; marker: string }

export type DismissFlow = {
  state(): DismissState
  /** Posts once; ignored while one is out. A press means the bar is there again (React's dev mode disposes once on mount). */
  dismiss(target: DismissTarget): void
  /**
   * The bar left. The server rebuilds the Board before it answers, so the bar can leave first: an answer after this
   * changes no state, but a dismissal still calls `onDone`, so the screen can move focus.
   */
  dispose(): void
}

const isGone = (reply: { status: number; message: string }) => reply.status === 404 && reply.message === 'no session'

/** `onDone('dismissed')` after the route removed it; `onDone('gone')` when it was already gone. */
export function createDismissFlow(
  onChange: (s: DismissState) => void,
  onDone: (how: 'dismissed' | 'gone') => void,
  post: Post = (path, body) => postAction(path, body),
): DismissFlow {
  let state: DismissState = { kind: 'idle' }
  let disposed = false
  const set = (s: DismissState) => {
    state = s
    if (!disposed) onChange(s)
  }
  const answered = (reply: ActionReply<DismissSessionResult>) => {
    if (reply.ok || isGone(reply)) {
      set({ kind: 'idle' })
      onDone(reply.ok ? 'dismissed' : 'gone')
      return
    }
    if (disposed) return
    warnUnknown('dismiss', DISMISS_ERRORS, reply)
    set({ kind: 'idle', error: refusalText(DISMISS_ERRORS, reply.message) })
  }
  return {
    state: () => state,
    dismiss(target) {
      if (state.kind === 'dismissing') return
      disposed = false
      set({ kind: 'dismissing' })
      void post<DismissSessionResult>('dismiss-session', { repoId: target.repoId, marker: target.marker }).then(answered)
    },
    dispose() {
      disposed = true
    },
  }
}

/**
 * The stop bar's busy button and its one alert box (session-life §9): busy while Resume or Dismiss runs; the error of
 * the button pressed last, but no Resume error once the bar offers no Resume (`offers`), so one error shows in one place.
 */
export function barStatus(o: { dismiss: DismissState; resuming: boolean; offers: boolean; resumeError?: string | undefined; last: 'resume' | 'dismiss' }): { busy?: 'resume' | 'dismiss'; error?: string } {
  const busy = o.resuming ? 'resume' : o.dismiss.kind === 'dismissing' ? 'dismiss' : undefined
  // A Resume refusal once the bar no longer offers Resume (the Board says why it can't): the bar says it, once.
  const error = o.last === 'resume' ? (o.offers ? o.resumeError : undefined) : o.dismiss.kind === 'idle' ? o.dismiss.error : undefined
  return { ...(busy ? { busy } : {}), ...(error ? { error } : {}) }
}
