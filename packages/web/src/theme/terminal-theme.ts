/**
 * The terminal's look from the page's tokens (plan terminal-host, ## Look; sprint terminal-tab §8). No new tokens:
 * background --surface, text --fg, cursor --focus, selection --border-strong, font --mono at 13 px. The ANSI colours
 * stay xterm's own. The values come from the page's computed style, so light and dark follow the page's theme.
 */
import type { ITheme } from '@xterm/xterm'

export type StyleSource = { getPropertyValue(name: string): string }
export type TerminalLook = { theme: ITheme; fontFamily: string; fontSize: number }

/** --size-small, the size of all mono text, in px: xterm takes a number. */
export const TERMINAL_FONT_SIZE = 13

/** Each xterm colour and the token it takes. */
const COLOURS: readonly (readonly [keyof ITheme, string])[] = [
  ['background', '--surface'],
  ['foreground', '--fg'],
  ['cursor', '--focus'],
  // The letter under a block cursor: the background colour, on the cursor.
  ['cursorAccent', '--surface'],
  ['selectionBackground', '--border-strong'],
  // Selected text keeps --fg, so ANSI colours on the selection never drop below 4.5:1.
  ['selectionForeground', '--fg'],
]

/** A token the page lacks is left out, so xterm uses its own default for it. */
export function terminalLook(style: StyleSource): TerminalLook {
  const read = (name: string) => style.getPropertyValue(name).trim()
  const theme: Record<string, string> = {}
  for (const [key, token] of COLOURS) {
    const value = read(token)
    if (value !== '') theme[key] = value
  }
  return { theme: theme as ITheme, fontFamily: read('--mono') || 'monospace', fontSize: TERMINAL_FONT_SIZE }
}

export type LookWindow = {
  document: { documentElement: unknown }
  getComputedStyle(el: never): StyleSource
}

export function readTerminalLook(win: LookWindow): TerminalLook {
  return terminalLook(win.getComputedStyle(win.document.documentElement as never))
}

type WatchWindow = LookWindow & {
  MutationObserver: new (cb: () => void) => { observe(target: never, options: MutationObserverInit): void; disconnect(): void }
  matchMedia(query: string): {
    addEventListener(type: 'change', fn: () => void): void
    removeEventListener(type: 'change', fn: () => void): void
  }
}

/**
 * Calls `fn` with the look again after each theme change: the root's `data-theme` (the theme menu), or the system's
 * light or dark (System). Returns the stop.
 */
export function watchTerminalLook(win: WatchWindow, fn: (look: TerminalLook) => void): () => void {
  const changed = () => fn(readTerminalLook(win))
  const observer = new win.MutationObserver(changed)
  observer.observe(win.document.documentElement as never, { attributes: true, attributeFilter: ['data-theme'] })
  const media = win.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', changed)
  return () => {
    observer.disconnect()
    media.removeEventListener('change', changed)
  }
}
