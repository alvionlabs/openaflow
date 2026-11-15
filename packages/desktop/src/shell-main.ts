// Glue: the app's start, for main.ts and the guarded probe. The logic is in the plain modules. The
// rules are in pod-docs/feature-details/desktop.md.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, Menu } from 'electron'
import { hideWindows } from './hide-windows.ts'
import { forkServer } from './host-main.ts'
import { startNotifier } from './notifier-main.ts'
import { ptyHostEntry } from './pty-host-launch.ts'
import { createPtyHost } from './pty-host-main.ts'
import { createQuitFlow } from './quit-flow.ts'
import { showQuitDialog, tellQuitting } from './quit-main.ts'
import { createServerHost, type ServerHost } from './server-host.ts'
import { serverEntry, serverEnv } from './server-launch.ts'
import { createSessionEnder, realEnderOs } from './session-ender.ts'
import { createSessionRoster } from './session-roster.ts'
import { createShellBus, type ShellBus } from './shell-bus.ts'
import { startTerminalLink } from './terminal-port-main.ts'
import { startTerminalRelay } from './terminal-relay.ts'
import { APP_ID, APP_NAME, dataDirOverride } from './shell-config.ts'
import { createLogFile, LOG_FILE, nodeLogFs, teeConsole } from './shell-log.ts'
import { installTestHooks } from './test-hooks-main.ts'
import { applyTestEnv, TEST_ENV_FILE } from './update-feed.ts'
import { failureText, relaunchArgs } from './update-flow.ts'
import { startUpdater } from './updater-main.ts'
import { startWindow } from './window-main.ts'
import { createJobControl } from './windows-jobs.ts'
import { originOf } from './window-rules.ts'

/** `pnpm package --test-feed` sets this. In every other build the test feed's code is removed. */
declare const __OPENAFLOW_TEST_FEED__: boolean
/** The Electron harness and `pnpm package --test-hooks` set this. In every other build the test hooks' code is removed. */
declare const __OPENAFLOW_TEST_HOOKS__: boolean

export type ShellContext = {
  host: ServerHost
  bus: ShellBus
  env: NodeJS.ProcessEnv
  /** Registers the toast activator at the start. Electron then writes a Start-menu shortcut, so a dev run doesn't. */
  activatorAtStart: boolean
  /**
   * For a Restart now: no live session → true with no question; else the quit question. Cancel → false; a confirm
   * ends every session first → true, and the quit after it asks nothing.
   */
  endSessions(): Promise<boolean>
  /**
   * The quit goes through (no live session, a confirm, the server failed, a Windows shutdown): once, before the ends
   * and the stops. Never on Cancel. Use this, not `before-quit`, which also fires for a quit that Cancel stops.
   */
  onQuitThrough(fn: () => void): void
}

export type ShellOptions = {
  env: NodeJS.ProcessEnv
  /** The probe runs from a temp folder, so it names the package. Default: `app.getAppPath()`. */
  appPath?: string | undefined
  onServer?(pid: number): void
  /** Default: only a packaged app. The real toast test turns it on and removes what it leaves. */
  activatorAtStart?: boolean
  /** In place of the error box, which waits for a click. After either, a packaged app checks for an update, then quits. */
  onFailed?(error: string): void
}

const showFailure = (error: string, willCheck: boolean) => dialog.showErrorBox(APP_NAME, failureText(error, willCheck))

/** Returns `undefined` on a second launch, which starts no server and exits. */
export function startShell(o: ShellOptions): ShellContext | undefined {
  if (__OPENAFLOW_TEST_FEED__ && app.isPackaged && !applyTestEnv(o.env, join(dirname(process.execPath), '..', TEST_ENV_FILE))) {
    console.error('openaflow desktop: a test build needs temp folders, so it will not start')
    app.exit(1)
    return undefined
  }
  app.setName(APP_NAME)
  app.setAppUserModelId(APP_ID)
  const dataDir = dataDirOverride(o.env)
  if (dataDir !== undefined) app.setPath('userData', dataDir)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return undefined
  }

  // After the lock, so one file has one writer.
  teeConsole(console, createLogFile({ file: join(app.getPath('userData'), LOG_FILE), fs: nodeLogFs, now: () => new Date(), home: app.getPath('home') }))

  Menu.setApplicationMenu(null)
  // With this listener, the app stays alive with no window.
  app.on('window-all-closed', () => {})

  const place = { packaged: app.isPackaged, appPath: o.appPath ?? app.getAppPath(), resourcesPath: process.resourcesPath }
  const entry = serverEntry(place)
  /** The current server's pid: no session end may signal it. */
  let serverPid: number | undefined
  const host = createServerHost({
    fork: () =>
      forkServer({
        entry,
        env: serverEnv(o.env, process.pid, place),
        onSpawn: (pid) => {
          serverPid = pid
          o.onServer?.(pid)
        },
      }),
  })
  let updater: ReturnType<typeof startUpdater>
  const shellBus = createShellBus()
  // A second launch and the tray's Open come here. After the server failed for good, the page is dead: start fresh.
  const bus: ShellBus = {
    ...shellBus,
    showWindow(hash) {
      const next = updater?.reopen() ?? 'show'
      if (next === 'show') shellBus.showWindow(hash)
      else if (next === 'relaunch') app.relaunch({ args: relaunchArgs(process.argv) })
    },
  }
  // The terminal host forks after the server's first ready; until then, terminal calls wait. Its failure leaves the
  // board running.
  const ptyHost = createPtyHost({ entry: ptyHostEntry(place), env: o.env })
  const testHooks = __OPENAFLOW_TEST_HOOKS__ ? installTestHooks(ptyHost) : undefined
  const log = (line: string) => console.log(line)
  // The sessions main started this app life, and their ends: a Job Object per session on Windows only.
  const jobs = process.platform === 'win32' ? createJobControl({ spawn, log }) : undefined
  const ender = createSessionEnder({ platform: process.platform, os: realEnderOs(), jobs, protectedPids: () => [ptyHost.pid(), serverPid], log })
  const roster = createSessionRoster({ platform: process.platform, ender, jobs, flush: () => ptyHost.flush(), log })
  // The server's sessions: its start, list, and dispose go to the host; answers, exits, and lost ids come back. Its
  // stop, sweep, and labels feed the roster.
  const relay = startTerminalRelay({ server: host, starter: ptyHost, roster, log })
  startTerminalLink({
    starter: ptyHost,
    origin: () => {
      const port = host.port()
      return port === undefined ? undefined : originOf(port)
    },
  })

  let serverFailed = false
  const flow = createQuitFlow({
    stops: [() => host.stop(), () => ptyHost.stop()],
    hide: () => hideWindows(BrowserWindow.getAllWindows()),
    quit: () => app.quit(),
    sessions: {
      live: () => roster.live(),
      ask: (q) => (testHooks ? testHooks.quitAnswer() : showQuitDialog(q)),
      confirmed: (count) => {
        relay.silence()
        tellQuitting(count)
      },
      silence: () => relay.silence(),
      endAll: () => roster.endAll(),
      serverFailed: () => serverFailed,
      log,
    },
  })
  const ctx: ShellContext = {
    host,
    bus,
    env: o.env,
    activatorAtStart: o.activatorAtStart ?? app.isPackaged,
    endSessions: () => flow.endSessions(),
    onQuitThrough: (fn) => flow.onThrough(fn),
  }

  app.on('before-quit', (e) => flow.beforeQuit(e))
  // `session-end` is a window's event, so each window reports it.
  app.on('browser-window-created', (_e, win) => win.on('session-end', () => flow.sessionEnd()))
  app.on('second-instance', () => bus.showWindow())
  // Once: a later ready, after a server restart, does nothing.
  host.onReady(() => ptyHost.start())
  host.onFailed((error) => {
    serverFailed = true
    ;(o.onFailed ?? showFailure)(error, updater?.willCheck() ?? false)
    // The page has no server. The tray stays, so Quit still works while the update check runs.
    hideWindows(BrowserWindow.getAllWindows())
    void (updater?.lastChance() ?? Promise.resolve()).finally(() => app.quit())
  })

  void app.whenReady().then(() => {
    startWindow(ctx)
    startNotifier(ctx)
    updater = startUpdater(ctx)
    host.start()
  })
  return ctx
}
