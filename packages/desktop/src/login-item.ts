// Open at login: the settings page's switch. Windows and macOS use Electron's login item API; Linux writes an XDG
// autostart file (login-autostart.ts). A start from either carries --hidden and stays in the tray. On Windows a read
// compares the arguments too, so a read and a write always carry the same ones. No `node:` import: the sandboxed
// preload imports the channels and loginAnswerOf. The rules are in pod-docs/sprints/settings.md §7.

import { senderAllowed, type BridgeCaller } from './folder-bridge.ts'
import { autostartDir, createAutostart, execValue, type AutostartFs } from './login-autostart.ts'

export const HIDDEN_FLAG = '--hidden'
export const LOGIN_GET_CHANNEL = 'openaflow:login-item:get'
export const LOGIN_SET_CHANNEL = 'openaflow:login-item:set'

export type LoginPlace = { packaged: boolean; appPath: string }
export type LoginOptions = { openAtLogin: boolean; args: string[] }
export type LoginApi = { get(query: { args: string[] }): { openAtLogin: boolean }; set(options: LoginOptions): void }
export type LoginItem = {
  /** Throws when the state can't be read. */
  isOn(): boolean
  /** Answers what a read returns after the write, not what was asked for. Throws only when that read throws. */
  set(on: boolean): boolean
}

/** Unpackaged, Electron's exe needs the app's folder as well. */
const loginArgs = (p: LoginPlace) => (p.packaged ? [HIDDEN_FLAG] : [p.appPath, HIDDEN_FLAG])

export function loginItemOptions(on: boolean, p: LoginPlace): LoginOptions {
  return { openAtLogin: on, args: loginArgs(p) }
}

export function isLoginStart(argv: string[]): boolean {
  return argv.includes(HIDDEN_FLAG)
}

/** A write that fails is logged; the read after it tells the truth. */
const readAfterWrite = (write: (on: boolean) => void, isOn: () => boolean, log?: (message: string) => void): LoginItem => ({
  isOn,
  set(on) {
    try {
      write(on)
    } catch (err) {
      log?.(`openaflow desktop: turning Open at login ${on ? 'on' : 'off'} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return isOn()
  },
})

export function createLoginItem(o: LoginPlace & { api: LoginApi; log?(message: string): void }): LoginItem {
  return readAfterWrite((on) => o.api.set(loginItemOptions(on, o)), () => o.api.get({ args: loginArgs(o) }).openAtLogin, o.log)
}

/** The autostart file's program: the AppImage when one runs packaged, else the executable (linux-unpacked, or Electron's). */
export const linuxProgram = (o: { packaged: boolean; execPath: string; env: Record<string, string | undefined> }): string =>
  o.packaged && o.env.APPIMAGE !== undefined && o.env.APPIMAGE !== '' ? o.env.APPIMAGE : o.execPath

export function loginItemFor(o: {
  platform: NodeJS.Platform
  packaged: boolean
  appPath: string
  execPath: string
  env: Record<string, string | undefined>
  home: string
  fs: AutostartFs
  api: LoginApi
  log?(message: string): void
}): LoginItem {
  if (o.platform !== 'linux') return createLoginItem(o)
  const file = createAutostart({ fs: o.fs, dir: autostartDir(o.env, o.home), exec: execValue(linuxProgram(o), loginArgs(o)) })
  return readAfterWrite((on) => file.write(on), () => file.isOn(), o.log)
}

export type LoginReply = { on: boolean } | { error: 'forbidden' | 'bad request' | 'login item failed' }

/** Main's side of the two channels. The folder bridge's sender rule, then the value, then the item. */
export function createLoginBridge<W>(o: {
  item: LoginItem
  origin(): string | undefined
  appWindow(): W | undefined
  log?(message: string): void
}): { get(caller: BridgeCaller<W>): LoginReply; set(caller: BridgeCaller<W>, on: unknown): LoginReply } {
  const answer = (read: () => boolean): LoginReply => {
    try {
      return { on: read() }
    } catch (err) {
      o.log?.(`openaflow desktop: reading Open at login failed: ${err instanceof Error ? err.message : String(err)}`)
      return { error: 'login item failed' }
    }
  }
  const allowed = (caller: BridgeCaller<W>) => senderAllowed(caller, o.origin(), o.appWindow())
  return {
    get: (caller) => (allowed(caller) ? answer(() => o.item.isOn()) : { error: 'forbidden' }),
    set(caller, on) {
      if (!allowed(caller)) return { error: 'forbidden' }
      if (typeof on !== 'boolean') return { error: 'bad request' }
      return answer(() => o.item.set(on))
    },
  }
}

const WORDS: readonly unknown[] = ['forbidden', 'bad request', 'login item failed']

/** The preload's side: a reply becomes a boolean, or a rejection with the reply's word. */
export function loginAnswerOf(reply: unknown): boolean {
  if (typeof reply === 'object' && reply !== null) {
    if ('on' in reply && typeof reply.on === 'boolean') return reply.on
    if ('error' in reply && WORDS.includes(reply.error)) throw new Error(reply.error as string)
  }
  throw new Error('login item failed')
}
