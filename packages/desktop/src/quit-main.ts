// Glue: the quit question's native box and the windows' `openaflow:quitting` event. The rules are in quit-flow.ts and
// pod-docs/sprints/session-life.md (§8). A test-hooks build never calls `showQuitDialog`: shell-main.ts answers from
// the test hook instead.

import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { QUITTING_CHANNEL, type QuitAnswer, type QuitQuestion } from './quit-flow.ts'
import { APP_NAME } from './shell-config.ts'

/** Only the first button ends the sessions; Escape, a close, and Cancel keep them. */
export async function showQuitDialog(q: QuitQuestion): Promise<QuitAnswer> {
  const options: MessageBoxOptions = {
    type: 'question',
    title: APP_NAME,
    message: q.message,
    detail: q.detail,
    buttons: q.buttons,
    defaultId: q.defaultId,
    cancelId: q.cancelId,
    noLink: true,
  }
  // Owned by the window when it shows; a quit from the tray with the window hidden gets a box of its own.
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return response === 0 ? 'end' : 'cancel'
}

/** Every window hears the count, so the page can show its Ending overlay. */
export function tellQuitting(count: number): void {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(QUITTING_CHANNEL, { count })
}
