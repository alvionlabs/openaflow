// Glue: Open at login's IPC, with the real fs and Electron's login item API. The rules are in login-item.ts and
// login-autostart.ts.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { BridgeCaller } from './folder-bridge.ts'
import type { AutostartFs } from './login-autostart.ts'
import { createLoginBridge, LOGIN_GET_CHANNEL, LOGIN_SET_CHANNEL, loginItemFor, repairLoginItem } from './login-item.ts'

// Sync calls: two quick toggles can't interleave.
const nodeFs: AutostartFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  mkdir: (path) => void mkdirSync(path, { recursive: true }),
  writeFile: (path, text, mode) => writeFileSync(path, text, { mode }),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path),
}

/** The asking frame. One that navigated away or closed reads as no frame, which the bridge refuses. As in window-main.ts. */
function callerOf(e: IpcMainInvokeEvent): BridgeCaller<BrowserWindow> {
  let frame: { isMain: boolean; url: string } | undefined
  try {
    frame = e.senderFrame ? { isMain: e.senderFrame.parent === null, url: e.senderFrame.url } : undefined
  } catch {
    frame = undefined
  }
  return { window: BrowserWindow.fromWebContents(e.sender) ?? undefined, isMainFrame: frame?.isMain ?? false, url: frame?.url ?? '' }
}

/** Once per app, at start: a second handle on one channel throws. */
export function startLoginItem(o: { env: NodeJS.ProcessEnv; origin(): string | undefined; appWindow(): BrowserWindow | undefined }): void {
  const log = (message: string) => console.error(message)
  const place = {
    platform: process.platform,
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    execPath: process.execPath,
    env: o.env,
    home: homedir(),
    fs: nodeFs,
    log,
  }
  // Every start, a --hidden one too: an update moves the AppImage.
  repairLoginItem(place)
  const item = loginItemFor({
    ...place,
    api: {
      get: (query) => app.getLoginItemSettings(query),
      set: (options) => app.setLoginItemSettings(options),
    },
  })
  const bridge = createLoginBridge({ item, origin: o.origin, appWindow: o.appWindow, log })
  ipcMain.handle(LOGIN_GET_CHANNEL, (e) => bridge.get(callerOf(e)))
  ipcMain.handle(LOGIN_SET_CHANNEL, (e, on: unknown) => bridge.set(callerOf(e), on))
}
