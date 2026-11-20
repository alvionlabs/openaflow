// The Terminal tab's panel (sprint terminal-tab T1, session-life W2, draft sections 1 and 3): the row's shown session
// as a live terminal, or the stop bar (dot, word, one muted line, Resume and Dismiss) over its faded last screen. Also
// the browser build's note in place of the tab. Glue: the rules are in terminal-tab.ts, dismiss-flow.ts, and
// resume-session-flow.ts.

import { sessionView, sessionWord, type HostedSession } from '@openaflow/model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ModalAlert } from '../../components/ModalAlert.tsx'
import type { WrapperError } from './new-session-flow.ts'
import { WrapperErrorBox } from './NewSessionForm.tsx'
import type { TerminalBridge } from '../../desktop-bridge.ts'
import { barStatus, createDismissFlow, type DismissState } from './dismiss-flow.ts'
import { createResumeFlow, resumeBusy, resumeError, resumeWrapper, type ResumeState, type ResumeTarget } from './resume-session-flow.ts'
import { browserView, canAttach, terminalBody, type StopBar } from './terminal-tab.ts'
import { TerminalView } from './TerminalView.tsx'
import './terminal.css'

type Props = {
  repoId: string
  repoPath: string
  session: HostedSession
  now: number
  bridge: TerminalBridge | undefined
  /**
   * After a dismissal (or a session already gone): the stop bar leaves, maybe already has, so the screen moves focus.
   * Called with the callback given when Dismiss was pressed, so the screen can tell the run has changed since.
   */
  onDismissed?: () => void
  /** Open terminal (or a started New session) asked for focus in the live terminal; `onFocusDone` once taken or dropped. */
  focus?: boolean
  onFocusDone?: () => void
}

export function TerminalTab({ repoId, repoPath, session, now, bridge, onDismissed, focus = false, onFocusDone }: Props) {
  const body = terminalBody(session, now, bridge !== undefined)
  const ended = body.kind === 'stopped'
  const view = sessionView(session, now)
  // Resume lives here, not in the bar: the bar leaves once the new session shows, and the tab then focuses it.
  const [resume, setResume] = useState<ResumeState>({ kind: 'idle' })
  const [own, setOwn] = useState<string | undefined>(undefined)
  const resumeFlow = useMemo(() => createResumeFlow(setResume, setOwn), [])
  useEffect(() => () => resumeFlow.dispose(), [resumeFlow])
  useEffect(() => resumeFlow.seen(session.marker), [resumeFlow, session.marker])
  const ownFocus = own === session.marker
  const focusDone = useCallback(() => {
    setOwn(undefined)
    if (focus) onFocusDone?.()
  }, [focus, onFocusDone])
  return (
    <div className="terminal-panel">
      {body.kind === 'stopped' && (
        <StopBarView
          // Not the view's key: two siblings with one key leave the old bar on the page when Resume moves to a new marker.
          key={`bar:${session.marker}`}
          bar={body.bar}
          target={{ repoId, marker: session.marker }}
          resuming={resumeBusy(resume, session.marker)}
          resumeError={resumeError(resume, session.marker)}
          resumeWrapper={resumeWrapper(resume, session.marker)}
          onOpenSettings={resumeFlow.openSettings}
          onResume={resumeFlow.resume}
          {...(onDismissed ? { onDismissed } : {})}
        />
      )}
      <TerminalView key={session.marker} id={session.marker} bridge={bridge} attach={canAttach(session, now)} ended={ended} scrollback={session.scrollback} focus={focus || ownFocus} onFocusDone={focusDone} />
      {!ended && (
        <p className="term-foot">
          <span className={`status ${view === 'waiting' ? 's-you' : 's-run'}`}>{sessionWord(session, now)}</span>
          <span aria-hidden="true">·</span>
          <span className="term-where">
            <code className="mono">claude</code> in <code className="mono">{repoPath}</code>
          </span>
        </p>
      )}
    </div>
  )
}

type StopBarViewProps = {
  bar: StopBar
  target: ResumeTarget
  resuming: boolean
  resumeError: string | undefined
  /** The lines under `resumeError`, for a run wrapper or stop command refusal. */
  resumeWrapper: WrapperError | undefined
  onOpenSettings(): void
  onResume(target: ResumeTarget): void
  onDismissed?: () => void
}

function StopBarView({ bar, target, resuming, resumeError, resumeWrapper, onOpenSettings, onResume, onDismissed }: StopBarViewProps) {
  const [state, setState] = useState<DismissState>({ kind: 'idle' })
  // The callback taken at the press: the flow outlives the bar when the new Board comes before the answer.
  const done = useRef<(() => void) | undefined>(undefined)
  const flow = useMemo(() => createDismissFlow(setState, () => done.current?.()), [])
  useEffect(() => () => flow.dispose(), [flow])
  // One alert box: the error of the button pressed last.
  const [last, setLast] = useState<'resume' | 'dismiss'>('dismiss')
  const { busy, error } = barStatus({ dismiss: state, resuming, offers: bar.resume, resumeError, last })
  return (
    <StopBarPanel
      bar={bar}
      {...(busy ? { busy } : {})}
      {...(error ? { error } : {})}
      {...(error !== undefined && error === resumeError && resumeWrapper ? { wrapper: resumeWrapper } : {})}
      onOpenSettings={onOpenSettings}
      onResume={() => {
        setLast('resume')
        onResume(target)
      }}
      onDismiss={() => {
        setLast('dismiss')
        done.current = onDismissed
        flow.dismiss(target)
      }}
    />
  )
}

/**
 * The stop bar (session-life §9): the dot, the word, one muted line, then Resume (primary, when the bar offers it) and
 * Dismiss; the alert box under it. While either runs, both buttons are off; Resume reads Resuming….
 */
export function StopBarPanel({
  bar,
  busy,
  error,
  wrapper,
  onResume,
  onDismiss,
  onOpenSettings,
}: {
  bar: StopBar
  busy?: 'resume' | 'dismiss'
  error?: string
  /** With `error` as the title: the wrapper error's lines, and Open settings. */
  wrapper?: WrapperError
  onResume(): void
  onDismiss(): void
  onOpenSettings?: () => void
}) {
  const off = busy !== undefined
  return (
    <div className="stop-wrap">
      <div className="stop-bar">
        <div className="stop-text">
          <span className={`status ${bar.dot}`}>{bar.word}</span>
          <p className="stop-line muted">{bar.line}</p>
        </div>
        {bar.resume && (
          <button className="btn primary" type="button" disabled={off} aria-busy={busy === 'resume'} onClick={onResume}>
            {busy === 'resume' ? 'Resuming…' : 'Resume'}
          </button>
        )}
        <button className="btn" type="button" disabled={off} aria-busy={busy === 'dismiss'} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {error && (wrapper && onOpenSettings ? <WrapperErrorBox title={error} wrapper={wrapper} onOpenSettings={onOpenSettings} /> : <ModalAlert message={error} />)}
    </div>
  )
}

/**
 * The browser build's line under the Next step card: the session's dot, word, and one line, then "Open the desktop
 * app to use the terminal." (`note` false when the card above already says it). No button.
 */
export function TerminalNote({ session, now, note = true }: { session: HostedSession; now: number; note?: boolean }) {
  const v = browserView(session, now)
  return (
    <div className="term-note" role="status">
      <span className={`status ${v.dot}`}>{v.word}</span>
      <p className="muted">{v.line}</p>
      {note && <p className="muted">{v.note}</p>}
    </div>
  )
}
