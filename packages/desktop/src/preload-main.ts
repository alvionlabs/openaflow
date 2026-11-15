// Glue: the window's preload, bundled to dist/preload.cjs. It runs sandboxed, so it may require only `electron`.
// The page gets exactly `window.openaflow.pickFolder()`, `connectTerminals()`, and `onTerminalHost(fn)`. The rules
// are in folder-bridge.ts and terminal-port.ts.

import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { answerOf, PICK_FOLDER_CHANNEL } from './folder-bridge.ts'
import {
  createDeliveries,
  createPortRequests,
  TERMINAL_CONNECT_CHANNEL,
  TERMINAL_PORT_CHANNEL,
  TERMINAL_STATE_CHANNEL,
  WATCH_PAGE_PORT,
  type TerminalHostState,
} from './terminal-port.ts'

const STATES: readonly unknown[] = ['ready', 'unresponsive', 'restarted', 'failed'] satisfies TerminalHostState[]

// contextBridge can't carry a port, so it reaches the page as a `window` message. The call resolves only after the
// page's world has dispatched that message (see createDeliveries).
const deliveries = createDeliveries<MessagePort>({
  watch: () => webFrame.executeJavaScript(WATCH_PAGE_PORT).then(() => undefined),
  post: (message, port) => window.postMessage(message, window.location.origin, [port]),
})
const ports = createPortRequests<MessagePort>({
  invoke: (id) => ipcRenderer.invoke(TERMINAL_CONNECT_CHANNEL, id),
  deliver: (port) => deliveries.deliver(port),
})
ipcRenderer.on(TERMINAL_PORT_CHANNEL, (e, message: { request?: unknown } | null) => ports.receive(message?.request, e.ports[0]))

contextBridge.exposeInMainWorld('openaflow', {
  // A failed invoke (no handler, a closed window) reads as a failed dialog, never as Electron's own text.
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke(PICK_FOLDER_CHANNEL).then(answerOf, () => {
      throw new Error('dialog failed')
    }),
  connectTerminals: (): Promise<void> => ports.connect(),
  /** Returns a function that stops the calls. */
  onTerminalHost: (fn: (state: TerminalHostState) => void): (() => void) => {
    const on = (_e: unknown, state: unknown) => {
      if (STATES.includes(state)) fn(state as TerminalHostState)
    }
    ipcRenderer.on(TERMINAL_STATE_CHANNEL, on)
    return () => void ipcRenderer.removeListener(TERMINAL_STATE_CHANNEL, on)
  },
})
