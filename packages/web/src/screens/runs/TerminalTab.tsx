// The Terminal tab's panel (sprint terminal-tab T1, draft sections 1 and 3): the row's shown session as a live
// terminal, or the stop bar (dot, word, one muted line, Dismiss) over its faded last screen. Also the browser build's
// note in place of the tab. Glue: the rules are in terminal-tab.ts and dismiss-flow.ts.

import { sessionView, sessionWord, type HostedSession } from '@openaflow/model'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ModalAlert } from '../../components/ModalAlert.tsx'
import type { TerminalBridge } from '../../desktop-bridge.ts'
import { createDismissFlow, type DismissState } from './dismiss-flow.ts'
import { browserView, terminalBody, type StopBar } from './terminal-tab.ts'
import { TerminalView } from './TerminalView.tsx'
import './terminal.css'

type Props = {
  repoId: string
  repoPath: string
  session: HostedSession
  now: number
  bridge: TerminalBridge | undefined
  /** After a dismissal (or a session already gone): the stop bar is about to leave, so the screen moves focus. */
  onDismissed?: () => void
}

export function TerminalTab({ repoId, repoPath, session, now, bridge, onDismissed }: Props) {
  const body = terminalBody(session, now)
  const ended = body.kind === 'stopped'
  const view = sessionView(session, now)
  return (
    <div className="terminal-panel">
      {body.kind === 'stopped' && <StopBarView key={session.marker} bar={body.bar} target={{ repoId, marker: session.marker }} {...(onDismissed ? { onDismissed } : {})} />}
      <TerminalView key={session.marker} id={session.marker} bridge={bridge} attach={view !== 'starting'} ended={ended} />
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

function StopBarView({ bar, target, onDismissed }: { bar: StopBar; target: { repoId: string; marker: string }; onDismissed?: () => void }) {
  const [state, setState] = useState<DismissState>({ kind: 'idle' })
  // The screen's callback may change each render; the flow stays the one that holds the request.
  const done = useRef(onDismissed)
  done.current = onDismissed
  const flow = useMemo(() => createDismissFlow(setState, () => done.current?.()), [])
  useEffect(() => () => flow.dispose(), [flow])
  const busy = state.kind === 'dismissing'
  const error = state.kind === 'idle' ? state.error : undefined
  return (
    <div className="stop-wrap">
      <div className="stop-bar">
        <div className="stop-text">
          <span className={`status ${bar.dot}`}>{bar.word}</span>
          <p className="stop-line muted">{bar.line}</p>
        </div>
        <button className="btn" type="button" disabled={busy} aria-busy={busy} onClick={() => flow.dismiss(target)}>
          Dismiss
        </button>
      </div>
      {error && <ModalAlert message={error} />}
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
