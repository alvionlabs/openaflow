// Resume on the Terminal tab's stop bar (sprint session-life §9): posts `resume-session` once, stays busy until the tab
// shows the new session's marker (at most RESUME_WAIT_MS), then asks for focus in its terminal. A refusal goes in the
// alert box under the bar it came from. Pure but for its timer; TerminalTab.tsx is the glue.

import type { ResumeSessionResult } from '@openaflow/model'
import { resumeSession, UNREACHABLE, type ActionReply, type ResumeSessionInput } from '../../actions-client.ts'
import { SETTINGS_HASH, START_ERRORS, wrapperError, type WrapperError } from './new-session-flow.ts'
import { refusalText, warnUnknown } from './remove-flow.ts'
import { RESUME_BLOCKED } from './terminal-tab.ts'

/** How long the new session may take to show in the tab before the bar stops waiting. */
export const RESUME_WAIT_MS = 10_000
/** The start failed, the terminals didn't answer, or the board is out of reach. */
export const RESUME_FAILED = "The session didn't resume. Please try again"

/** The title over a wrapper error's lines. */
export const RESUME_FAILED_TITLE = "The session didn't resume"

const CANT = "can't resume: "

/** The resume route's words, for the alert box (§5). Short and warm, with no period at the end (DESIGN.md). */
export const RESUME_ERRORS: ReadonlyMap<string, string> = new Map([
  ['bad request', START_ERRORS.get('bad request')!],
  ['no terminal host', START_ERRORS.get('no terminal host')!],
  ['claude not found', START_ERRORS.get('claude not found')!],
  ['session starting', START_ERRORS.get('session starting')!],
  ['too many sessions', START_ERRORS.get('too many sessions')!],
  // Another window resumed or dismissed it; the Board catches up.
  ['no session', 'This session is already gone'],
  ['session is live', 'This session is already running'],
  [UNREACHABLE, RESUME_FAILED],
])

/**
 * `idle`, with `error` after a refusal, for the bar of `error.marker` only. `resuming`: the request for `marker` is out.
 * `waiting`: `next` started, until the tab shows it.
 */
export type ResumeState =
  | { kind: 'idle'; error?: { marker: string; text: string; wrapper?: WrapperError } }
  | { kind: 'resuming'; marker: string }
  | { kind: 'waiting'; marker: string; next: string }

/** The bar of `marker` is busy: Resuming…, and both buttons off. */
export const resumeBusy = (s: ResumeState, marker: string): boolean => s.kind !== 'idle' && s.marker === marker

/** The alert text under the bar of `marker`, if its last Resume was refused. */
export const resumeError = (s: ResumeState, marker: string): string | undefined => (s.kind === 'idle' && s.error?.marker === marker ? s.error.text : undefined)

/** The wrapper error's lines under the bar of `marker`, if its last Resume was refused by the run wrapper or the stop command. */
export const resumeWrapper = (s: ResumeState, marker: string): WrapperError | undefined => (s.kind === 'idle' && s.error?.marker === marker ? s.error.wrapper : undefined)

export type ResumeTarget = { repoId: string; marker: string }

export type ResumeFlow = {
  state(): ResumeState
  /** Posts once; ignored while one is out or waiting. */
  resume(target: ResumeTarget): void
  /** The marker the tab shows now, at each render: the flow asks for focus once it is the new session's. */
  seen(marker: string | undefined): void
  /** Open settings: moves the page to `#settings`. */
  openSettings(): void
  /** The tab left: drops any answer and the wait. */
  dispose(): void
}

export type ResumeDeps = { post?: (input: ResumeSessionInput) => Promise<ActionReply<ResumeSessionResult>>; go?: (hash: string) => void }

function errorText(reply: { status: number; message: string }): string {
  if (reply.message.startsWith(CANT)) {
    const why = (RESUME_BLOCKED as Record<string, string | undefined>)[reply.message.slice(CANT.length)]
    if (why !== undefined) return why
  }
  if (reply.message.startsWith('start failed:') || reply.status === 504) {
    console.warn(`openaflow: resume failed (HTTP ${reply.status}: ${reply.message})`)
    return RESUME_FAILED
  }
  warnUnknown('resume', RESUME_ERRORS, reply)
  return refusalText(RESUME_ERRORS, reply.message)
}

/** `onFocus(next)` once the tab shows the session Resume started. */
export function createResumeFlow(onChange: (s: ResumeState) => void, onFocus: (marker: string) => void, deps: ResumeDeps = {}): ResumeFlow {
  const post = deps.post ?? ((input: ResumeSessionInput) => resumeSession(input))
  const go = deps.go ?? ((hash: string) => (window.location.hash = hash))
  let state: ResumeState = { kind: 'idle' }
  let shown: string | undefined
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const set = (s: ResumeState) => {
    state = s
    onChange(s)
  }
  const stopWaiting = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const moveIfShown = () => {
    if (state.kind !== 'waiting' || shown !== state.next) return
    const next = state.next
    stopWaiting()
    set({ kind: 'idle' })
    onFocus(next)
  }
  const answered = (marker: string, reply: ActionReply<ResumeSessionResult>) => {
    if (!reply.ok) {
      const wrapper = wrapperError(reply.message)
      if (wrapper) {
        return set({ kind: 'idle', error: { marker, text: RESUME_FAILED_TITLE, wrapper } })
      }
      return set({ kind: 'idle', error: { marker, text: errorText(reply) } })
    }
    set({ kind: 'waiting', marker, next: reply.data.marker })
    timer = setTimeout(() => {
      timer = undefined
      if (state.kind === 'waiting') set({ kind: 'idle' })
    }, RESUME_WAIT_MS)
    moveIfShown()
  }

  return {
    state: () => state,
    resume(target) {
      if (state.kind !== 'idle') return
      const mine = ++seq
      set({ kind: 'resuming', marker: target.marker })
      void post({ repoId: target.repoId, marker: target.marker }).then((reply) => {
        if (mine === seq && state.kind === 'resuming') answered(target.marker, reply)
      })
    },
    openSettings: () => go(SETTINGS_HASH),
    seen(marker) {
      shown = marker
      moveIfShown()
    },
    dispose() {
      seq++
      stopWaiting()
      state = { kind: 'idle' }
    },
  }
}
