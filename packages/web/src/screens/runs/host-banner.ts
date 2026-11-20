// The terminal host's heartbeat banner and the quit overlay (sprint session-life §9). Pure: the screen passes the
// desktop bridge (a fake in tests), HostBanner.tsx and QuitOverlay.tsx only draw. The browser build has no bridge, so
// it never gets either.

import type { TerminalBridge } from '../../desktop-bridge.ts'

export const BANNER_TITLE = 'Terminals are not responding.'
export const BANNER_NOTE = 'Your sessions may still run. The app keeps trying.'

/**
 * Whether the banner shows after the host reports `state`. Only `unresponsive` shows it; `ready` and `restarted`
 * hide it, and so do `starting` and `failed` (after a failure the app no longer keeps trying, so the note would be
 * false; the Terminal tab words that). A state it doesn't know leaves the banner as it was.
 */
export function shownAfter(current: boolean, state: string): boolean {
  if (state === 'unresponsive') return true
  if (state === 'ready' || state === 'restarted' || state === 'starting' || state === 'failed') return false
  return current
}

/**
 * Keeps `set` on the host's state: the state read at load, then each event. An event that comes while the read is
 * still out wins, since the read is older. Without a bridge it never calls `set`. Returns a stop function.
 */
export function watchBanner(bridge: Pick<TerminalBridge, 'onHostState' | 'hostState'> | undefined, set: (shown: boolean) => void): () => void {
  if (!bridge) return () => {}
  let live = true
  let current = false
  let heard = false
  const stop = bridge.onHostState((state) => {
    if (!live) return
    heard = true
    current = shownAfter(current, state)
    set(current)
  })
  bridge.hostState?.().then(
    (state) => {
      if (!live || heard) return
      current = shownAfter(current, state)
      set(current)
    },
    () => {
      // No read: the banner stays hidden until an event says otherwise.
    },
  )
  return () => {
    live = false
    stop()
  }
}

/** `Ending 1 session…` or `Ending N sessions…`. */
export const overlayWords = (count: number): string => `Ending ${count} ${count === 1 ? 'session' : 'sessions'}…`

export type OverlayView = { role: 'status'; text: string }

/** The overlay for a quit that ends `count` sessions; undefined unless `count` is a whole number of at least 1. */
export const overlayView = (count: number): OverlayView | undefined => (Number.isInteger(count) && count >= 1 ? { role: 'status', text: overlayWords(count) } : undefined)

/** Calls `set(count)` when the shell says a quit is ending sessions. Without the bridge, or its `onQuitting`, never. Returns a stop function. */
export function watchOverlay(bridge: Pick<TerminalBridge, 'onQuitting'> | undefined, set: (count: number) => void): () => void {
  return bridge?.onQuitting?.(set) ?? (() => {})
}
