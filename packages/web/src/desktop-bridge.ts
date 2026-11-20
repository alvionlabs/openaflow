// The desktop shell's bridge, read in one place. The desktop app's preload puts `window.openaflow` on the page;
// the browser build has none.

export type PickFolder = () => Promise<string | null>

/**
 * The desktop shell's folder dialog, or undefined in the browser build. It opens the system's folder
 * dialog (Windows, Linux, or macOS) and resolves to the chosen path, or null on cancel; it rejects with `forbidden` or `dialog failed`.
 */
export function folderBridge(win: unknown = globalThis.window): PickFolder | undefined {
  if (typeof win !== 'object' || win === null) return undefined
  const bridge = (win as { openaflow?: unknown }).openaflow
  if (typeof bridge !== 'object' || bridge === null) return undefined
  const pick = (bridge as { pickFolder?: unknown }).pickFolder
  if (typeof pick !== 'function') return undefined
  return () => (pick as PickFolder).call(bridge)
}

export type TerminalHostState = 'ready' | 'unresponsive' | 'restarted' | 'failed'

/** What `terminalHostState()` reads at page load; the events add `restarted` and never `starting`. */
export type TerminalHostRead = 'starting' | 'ready' | 'unresponsive' | 'failed'

export type TerminalBridge = {
  /** The shell puts a port on the page as a `window` message, then resolves; it rejects with `terminals unavailable` or `forbidden`. */
  connect(): Promise<void>
  /** Calls `fn` on each host state; returns a function that stops the calls. */
  onHostState(fn: (state: TerminalHostState) => void): () => void
  /** Calls `fn(count)` once a quit is confirmed and the sessions end; returns a stop function. Undefined where the shell has no `onQuitting`. */
  onQuitting?: ((fn: (count: number) => void) => () => void) | undefined
  /** The host's state now. Undefined where the shell has no `terminalHostState`. */
  hostState?: (() => Promise<TerminalHostRead>) | undefined
}

/**
 * The desktop shell's terminal link, or undefined in the browser build (no `window.openaflow`, or no
 * `connectTerminals`). Without it the page shows no terminal feature.
 */
export function terminalBridge(win: unknown = globalThis.window): TerminalBridge | undefined {
  if (typeof win !== 'object' || win === null) return undefined
  const bridge = (win as { openaflow?: unknown }).openaflow
  if (typeof bridge !== 'object' || bridge === null) return undefined
  const { connectTerminals, onTerminalHost, onQuitting, terminalHostState } = bridge as {
    connectTerminals?: unknown
    onTerminalHost?: unknown
    onQuitting?: unknown
    terminalHostState?: unknown
  }
  if (typeof connectTerminals !== 'function') return undefined
  return {
    connect: () => (connectTerminals as () => Promise<void>).call(bridge),
    onHostState: (fn) => {
      if (typeof onTerminalHost !== 'function') return () => {}
      const stop = (onTerminalHost as (f: typeof fn) => unknown).call(bridge, fn)
      return typeof stop === 'function' ? (stop as () => void) : () => {}
    },
    onQuitting:
      typeof onQuitting === 'function'
        ? (fn) => {
            const stop = (onQuitting as (f: typeof fn) => unknown).call(bridge, fn)
            return typeof stop === 'function' ? (stop as () => void) : () => {}
          }
        : undefined,
    hostState: typeof terminalHostState === 'function' ? () => (terminalHostState as () => Promise<TerminalHostRead>).call(bridge) : undefined,
  }
}

/** The desktop shell's Open at login (settings §7). Each call resolves to the state read after it. */
export type LoginBridge = {
  get(): Promise<boolean>
  /** Resolves to the state read after the write, which may differ from `on`; rejects with `login item failed` and the like. */
  set(on: boolean): Promise<boolean>
}

/** Open at login, or undefined in the browser build or a shell without both `openAtLogin` and `setOpenAtLogin`. */
export function loginBridge(win: unknown = globalThis.window): LoginBridge | undefined {
  if (typeof win !== 'object' || win === null) return undefined
  const bridge = (win as { openaflow?: unknown }).openaflow
  if (typeof bridge !== 'object' || bridge === null) return undefined
  const { openAtLogin, setOpenAtLogin } = bridge as { openAtLogin?: unknown; setOpenAtLogin?: unknown }
  if (typeof openAtLogin !== 'function' || typeof setOpenAtLogin !== 'function') return undefined
  return {
    get: () => (openAtLogin as () => Promise<boolean>).call(bridge),
    set: (on) => (setOpenAtLogin as (on: boolean) => Promise<boolean>).call(bridge, on),
  }
}
