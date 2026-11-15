// Glue: the window link's IPC. A page asks for a port; main makes a channel, gives one end to the terminal host and
// the other to the page's main frame, then answers. Every window hears the host's state. The rules are in
// terminal-port.ts.

import { app, BrowserWindow, ipcMain, MessageChannelMain, type MessagePortMain } from 'electron'
import type { PtyHostStarter } from './pty-host-starter.ts'
import { createTerminalLink, TERMINAL_CONNECT_CHANNEL, TERMINAL_PORT_CHANNEL, TERMINAL_STATE_CHANNEL } from './terminal-port.ts'

/** Call before the first window opens: the app window is the last window made, until it closes. */
export function startTerminalLink(o: { starter: PtyHostStarter; origin(): string | undefined }): void {
  // window-main.ts makes the only window, so the newest one is the folder bridge's app window.
  let appWindow: BrowserWindow | undefined
  app.on('browser-window-created', (_e, win) => {
    appWindow = win
    win.on('closed', () => {
      if (appWindow === win) appWindow = undefined
    })
  })

  const link = createTerminalLink<BrowserWindow, MessagePortMain>({
    starter: o.starter,
    origin: o.origin,
    appWindow: () => (appWindow?.isDestroyed() === false ? appWindow : undefined),
    channel: () => {
      const { port1, port2 } = new MessageChannelMain()
      return { host: port1, page: port2 }
    },
    broadcast: (state) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(TERMINAL_STATE_CHANNEL, state)
    },
  })

  ipcMain.handle(TERMINAL_CONNECT_CHANNEL, (e, request: unknown) => {
    // A frame that navigated away or closed reads as no frame, which the link refuses. As in window-main.ts.
    let frame: { isMain: boolean; url: string } | undefined
    try {
      frame = e.senderFrame ? { isMain: e.senderFrame.parent === null, url: e.senderFrame.url } : undefined
    } catch {
      frame = undefined
    }
    const caller = { window: BrowserWindow.fromWebContents(e.sender) ?? undefined, isMainFrame: frame?.isMain ?? false, url: frame?.url ?? '' }
    return link.request(caller, (port) => e.senderFrame?.postMessage(TERMINAL_PORT_CHANNEL, { request }, [port]))
  })
}
