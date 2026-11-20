// One session's xterm on the page's terminal link (sprint terminal-tab §7): L1's theme and fit, F1's link, resize on
// container change, input to the port, detach on unmount. Glue: what it draws is decided in terminal-tab.ts.
// xterm loads in the effect, so the server render and the tests never load it.

import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type { TerminalBridge } from '../../desktop-bridge.ts'
import { createTerminalLink, type TerminalLink } from '../../terminal-link.ts'
import { readTerminalLook, watchTerminalLook } from '../../theme/terminal-theme.ts'
import { savedScreen } from '../../actions-client.ts'
import { focusMove, screenHandlers, screenUnder, terminalOptions, wantSaved, type Lost } from './terminal-tab.ts'

let pageLink: TerminalLink | undefined

/**
 * The page's one terminal link. A link listens on the window for its port for the page's life, so a second one would
 * take the port's messages from the first.
 */
function linkFor(bridge: TerminalBridge): TerminalLink {
  pageLink ??= createTerminalLink(bridge, window)
  return pageLink
}

/** The size the host takes (2–500 by 1–200); 120 × 30 until the box has a size. */
const sizeOf = (cols: number, rows: number) => ({
  cols: Number.isFinite(cols) && cols >= 2 ? Math.min(cols, 500) : 120,
  rows: Number.isFinite(rows) && rows >= 1 ? Math.min(rows, 200) : 30,
})

type Props = {
  /** The session's marker: the host's session id. The caller keys this view by it. */
  id: string
  bridge: TerminalBridge | undefined
  /** False while the session is `starting`: the host may not hold it yet, and an early attach would read as gone. */
  attach: boolean
  /** The session ended or stopped: the last screen, faded, with no input. Nothing at all once the host lacks it. */
  ended: boolean
  /** The lines the view keeps above its screen: the session's own (`HostedSession.scrollback`), else 5,000. */
  scrollback?: number | undefined
  /**
   * Open terminal (or the move after a start) asked for focus: put it in xterm once the view is attached (`focusMove`).
   * `onFocusDone` once the request is taken or dropped (a faded screen, or a terminal that is not available).
   */
  focus?: boolean
  onFocusDone?: () => void
}

export function TerminalView({ id, bridge, attach, ended, scrollback, focus = false, onFocusDone }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const term = useRef<import('@xterm/xterm').Terminal | undefined>(undefined)
  const [ready, setReady] = useState(false)
  // `gone`: the host has no such session; `unavailable`: the host can't be used (a later replay brings it back).
  const [lost, setLost] = useState<Lost>(undefined)
  // The stopped session's saved screen, once the host lacks it; asked for once.
  const [saved, setSaved] = useState<string | undefined>(undefined)
  const asked = useRef(false)
  // The attach was sent: keys typed from now on reach the session.
  const [attached, setAttached] = useState(false)
  const endedNow = useRef(ended)
  endedNow.current = ended

  // The terminal: made once per session, sized to its box, refit on each change of the box.
  useEffect(() => {
    if (!bridge) return
    const link = linkFor(bridge)
    let stopped = false
    let stopLook: (() => void) | undefined
    let observer: ResizeObserver | undefined
    let made: import('@xterm/xterm').Terminal | undefined
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(async ([{ Terminal }, { FitAddon }]) => {
      const el = box.current
      if (stopped || !el) return
      const look = readTerminalLook(window)
      const t = new Terminal(terminalOptions({ look, scrollback, ended: endedNow.current }))
      made = t
      const fit = new FitAddon()
      t.loadAddon(fit)
      t.open(el)
      stopLook = watchTerminalLook(window, (l) => {
        t.options.theme = l.theme
        t.options.fontFamily = l.fontFamily
        refit()
      })
      t.onData((data) => {
        if (!endedNow.current) link.input(id, data)
      })
      t.onResize(({ cols, rows }) => link.resize(id, cols, rows))
      // A box with no size (closed, or not laid out yet) keeps the last size.
      function refit() {
        if (el!.clientWidth === 0 || el!.clientHeight === 0) return
        try {
          fit.fit()
        } catch {
          // Not laid out yet: the observer fits it once it is.
        }
      }
      // The cell size comes from the font: fit once it has loaded.
      await document.fonts?.ready.catch(() => {})
      if (stopped) return
      refit()
      observer = new ResizeObserver(refit)
      observer.observe(el)
      term.current = t
      setReady(true)
    })
    return () => {
      stopped = true
      observer?.disconnect()
      stopLook?.()
      link.close(id)
      made?.dispose()
      term.current = undefined
    }
  }, [id, bridge])

  // Attach once the terminal has its size: `open` sends `resize`, then `attach`, so the replay comes at this size.
  useEffect(() => {
    const t = term.current
    if (!bridge || !ready || !attach || !t) return
    const link = linkFor(bridge)
    let stopped = false
    void link
      .open(id, sizeOf(t.cols, t.rows), screenHandlers(t, setLost))
      .then(() => {
        if (!stopped) setAttached(true)
      })
    // The unmount effect above detaches.
    return () => {
      stopped = true
    }
  }, [id, bridge, ready, attach])

  useEffect(() => {
    if (!focus) return
    const move = focusMove({ attached, ended, lost: lost !== undefined })
    if (move === 'wait') return
    if (move === 'take') term.current?.focus()
    onFocusDone?.()
  }, [focus, attached, ended, lost, onFocusDone])

  useEffect(() => {
    const t = term.current
    if (!t) return
    t.options.disableStdin = ended
    t.options.cursorBlink = !ended
    // The faded last screen draws no cursor, not even xterm's hollow one for an unfocused terminal.
    t.options.cursorInactiveStyle = ended ? 'none' : 'outline'
    if (ended) t.blur()
  }, [ended, ready])

  useEffect(() => {
    if (!wantSaved({ ended, lost }) || asked.current) return
    asked.current = true
    let stopped = false
    void savedScreen(id).then((text) => {
      if (!stopped) setSaved(text)
    })
    return () => {
      stopped = true
      asked.current = false
    }
  }, [id, ended, lost])

  // An ended session the host no longer holds: its saved screen, else the stop bar stands alone.
  const under = screenUnder({ ended, lost, saved })
  const hidden = under.show !== 'terminal'
  return (
    <>
      {under.line !== undefined && (
        <p className="term-lost muted" role="status">
          {under.line}
        </p>
      )}
      {under.show === 'saved' && <SavedScreen text={saved ?? ''} />}
      {/* xterm opens in the inner box: fit measures its element whole, so the padding stays on the outer one. */}
      <div className={ended ? 'term faded' : 'term'} hidden={hidden} aria-hidden={ended ? true : undefined}>
        <div ref={box} className="term-fit" />
      </div>
    </>
  )
}

/** A stopped session's saved screen, faded, as text: scrolled to its end, where the session stopped. */
export function SavedScreen({ text }: { text: string }) {
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = pre.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <div className="term faded saved" aria-hidden="true">
      <pre ref={pre} className="term-saved">
        {text}
      </pre>
    </div>
  )
}
