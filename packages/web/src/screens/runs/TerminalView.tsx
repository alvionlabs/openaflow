// One session's xterm on the page's terminal link (sprint terminal-tab §7): L1's theme and fit, F1's link, resize on
// container change, input to the port, detach on unmount. Glue: what it draws is decided in terminal-tab.ts.
// xterm loads in the effect, so the server render and the tests never load it.

import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type { TerminalBridge } from '../../desktop-bridge.ts'
import { createTerminalLink, type TerminalLink } from '../../terminal-link.ts'
import { readTerminalLook, watchTerminalLook } from '../../theme/terminal-theme.ts'
import { UNAVAILABLE } from './terminal-tab.ts'

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
}

export function TerminalView({ id, bridge, attach, ended }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const term = useRef<import('@xterm/xterm').Terminal | undefined>(undefined)
  const [ready, setReady] = useState(false)
  // `gone`: the host has no such session; `unavailable`: the host can't be used (a later replay brings it back).
  const [lost, setLost] = useState<'gone' | 'unavailable' | undefined>(undefined)
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
      // 4.5:1 for every colour: xterm's own ANSI green is about 2.5:1 on the light --surface.
      const t = new Terminal({ ...look, minimumContrastRatio: 4.5, cursorBlink: true, disableStdin: endedNow.current })
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
    void link.open(id, sizeOf(t.cols, t.rows), {
      replay(data) {
        // A replay after the host restarted draws the whole screen again.
        t.reset()
        t.write(data)
        setLost(undefined)
      },
      data(data, written) {
        t.write(data, written)
      },
      exit() {
        // The Board says it ended; the stop bar comes from there.
      },
      gone: () => setLost('gone'),
      unavailable: () => setLost('unavailable'),
    })
    // The unmount effect above detaches.
  }, [id, bridge, ready, attach])

  useEffect(() => {
    const t = term.current
    if (!t) return
    t.options.disableStdin = ended
    t.options.cursorBlink = !ended
    if (ended) t.blur()
  }, [ended, ready])

  // An ended session the host no longer holds: the stop bar stands alone.
  const hidden = lost !== undefined
  return (
    <>
      {hidden && !ended && (
        <p className="term-lost muted" role="status">
          {UNAVAILABLE}
        </p>
      )}
      <div ref={box} className={ended ? 'term faded' : 'term'} hidden={hidden} aria-hidden={ended ? true : undefined} />
    </>
  )
}
