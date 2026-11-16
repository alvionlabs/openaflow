import { describe, expect, test, vi } from 'vitest'
import type { AutostartFs } from './login-autostart.ts'
import { autostartDir, AUTOSTART_FILE } from './login-autostart.ts'
import {
  createLoginBridge,
  createLoginItem,
  isLoginStart,
  loginAnswerOf,
  loginItemFor,
  loginItemOptions,
  type LoginItem,
} from './login-item.ts'

const APP = 'E:\\app\\packages\\desktop'

const fakeApi = (openAtLogin = false) => {
  const api = {
    openAtLogin,
    get: vi.fn((_q: { args: string[] }) => ({ openAtLogin: api.openAtLogin })),
    set: vi.fn((o: { openAtLogin: boolean; args: string[] }) => void (api.openAtLogin = o.openAtLogin)),
  }
  return api
}

/** An in-memory fs with the same errors as node's: ENOENT for a missing file. */
const fakeFs = (files: Record<string, string> = {}) => {
  const store = new Map(Object.entries(files))
  const dirs = new Set<string>()
  const modes = new Map<string, number>()
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  const fs = {
    store,
    dirs,
    modes,
    readFile: vi.fn((path: string) => {
      const text = store.get(path)
      if (text === undefined) throw missing(path)
      return text
    }),
    mkdir: vi.fn((path: string) => void dirs.add(path)),
    writeFile: vi.fn((path: string, text: string, mode: number) => {
      store.set(path, text)
      modes.set(path, mode)
    }),
    rename: vi.fn((from: string, to: string) => {
      const text = store.get(from)
      if (text === undefined) throw missing(from)
      store.delete(from)
      store.set(to, text)
      modes.set(to, modes.get(from)!)
    }),
    remove: vi.fn((path: string) => {
      if (!store.delete(path)) throw missing(path)
    }),
  } satisfies AutostartFs & Record<string, unknown>
  return fs
}

const DIR = '/tmp/autostart'
const FILE = `${DIR}/openaflow.desktop`
const LINUX = { platform: 'linux' as const, packaged: true, appPath: '/opt/OpenAFlow/resources/app.asar', execPath: '/opt/OpenAFlow/openaflow', home: '/home/u' }
const linuxItem = (fs: ReturnType<typeof fakeFs>, more: Partial<Parameters<typeof loginItemFor>[0]> = {}) =>
  loginItemFor({ ...LINUX, env: { OPENAFLOW_AUTOSTART_DIR: DIR }, fs, api: fakeApi(), ...more })
const entry = (exec: string) => `[Desktop Entry]\nType=Application\nName=OpenAFlow\nExec=${exec}\nX-GNOME-Autostart-enabled=true\n`
const OWN_EXEC = '"/opt/OpenAFlow/openaflow" "--hidden"'

describe('login item', () => {
  test('login item options', () => {
    const unpackaged = { packaged: false, appPath: APP }
    expect(loginItemOptions(true, unpackaged)).toEqual({ openAtLogin: true, args: [APP, '--hidden'] })
    expect(loginItemOptions(false, unpackaged)).toEqual({ openAtLogin: false, args: [APP, '--hidden'] })
    const packaged = { packaged: true, appPath: APP }
    expect(loginItemOptions(true, packaged)).toEqual({ openAtLogin: true, args: ['--hidden'] })
    expect(loginItemOptions(false, packaged)).toEqual({ openAtLogin: false, args: ['--hidden'] })
  })

  test('a login start stays in the tray', () => {
    expect(isLoginStart(['electron.exe', APP, '--hidden'])).toBe(true)
    expect(isLoginStart(['OpenAFlow.exe', '--hidden'])).toBe(true)
    expect(isLoginStart(['electron.exe', APP])).toBe(false)
    expect(isLoginStart(['electron.exe', '--hidden-other', 'x--hidden'])).toBe(false)
  })

  test('off by default', () => {
    const api = fakeApi()
    const item = createLoginItem({ api, packaged: false, appPath: APP })
    expect(item.isOn()).toBe(false)
    expect(api.set).not.toHaveBeenCalled()
  })

  test('a read uses the same args as the write', () => {
    const api = fakeApi()
    createLoginItem({ api, packaged: true, appPath: APP }).isOn()
    expect(api.get).toHaveBeenCalledWith({ args: ['--hidden'] })
    const unpackaged = fakeApi()
    createLoginItem({ api: unpackaged, packaged: false, appPath: APP }).isOn()
    expect(unpackaged.get).toHaveBeenCalledWith({ args: [APP, '--hidden'] })
  })

  test('a toggle writes, then answers what a read returns', () => {
    const api = fakeApi()
    const item = createLoginItem({ api, packaged: false, appPath: APP })
    expect(item.set(true)).toBe(true)
    expect(api.set).toHaveBeenCalledWith({ openAtLogin: true, args: [APP, '--hidden'] })
    expect(item.set(false)).toBe(false)
    expect(api.set).toHaveBeenLastCalledWith({ openAtLogin: false, args: [APP, '--hidden'] })
    // A write that doesn't take: the read wins.
    api.set.mockImplementation(() => {})
    expect(item.set(true)).toBe(false)
  })

  test('windows args unchanged', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const fs = fakeFs()
      const api = fakeApi()
      const unpackaged = loginItemFor({ platform, packaged: false, appPath: APP, execPath: 'E:\\electron.exe', env: {}, home: 'C:\\Users\\u', fs, api })
      expect(unpackaged.set(true)).toBe(true)
      expect(api.set).toHaveBeenLastCalledWith({ openAtLogin: true, args: [APP, '--hidden'] })
      expect(api.get).toHaveBeenLastCalledWith({ args: [APP, '--hidden'] })
      const packedApi = fakeApi()
      const packaged = loginItemFor({ platform, packaged: true, appPath: APP, execPath: 'E:\\OpenAFlow.exe', env: { APPIMAGE: '/x.AppImage' }, home: 'C:\\Users\\u', fs, api: packedApi })
      expect(packaged.set(true)).toBe(true)
      expect(packedApi.set).toHaveBeenLastCalledWith({ openAtLogin: true, args: ['--hidden'] })
      // Windows and macOS never touch the autostart folder.
      expect(fs.writeFile).not.toHaveBeenCalled()
      expect(fs.readFile).not.toHaveBeenCalled()
    }
  })

  test('linux exec line', () => {
    const tick = '`'
    // A path with a space, `$`, `%`, `"`, a backtick, and `\`. Written out by hand: `$` → `\\$`, `\` → `\\\\`.
    const odd = `/opt/a b/$x%"q${tick}\\w`
    const expected = String.raw`"/opt/a b/\\$x%%\\"q\\${tick}\\\\w`
    const lineOf = (more: Partial<Parameters<typeof loginItemFor>[0]>) => {
      const fs = fakeFs()
      linuxItem(fs, more).set(true)
      return (fs.store.get(FILE) ?? '').split('\n').find((l) => l.startsWith('Exec='))
    }

    // An AppImage: the AppImage's own path, never the mount it runs from.
    expect(lineOf({ env: { OPENAFLOW_AUTOSTART_DIR: DIR, APPIMAGE: `${odd}/OpenAFlow.AppImage` } })).toBe(`Exec=${expected}/OpenAFlow.AppImage" "--hidden"`)
    // linux-unpacked: packaged with no APPIMAGE (or an empty one), so the executable.
    expect(lineOf({ execPath: `${odd}/openaflow` })).toBe(`Exec=${expected}/openaflow" "--hidden"`)
    expect(lineOf({ execPath: `${odd}/openaflow`, env: { OPENAFLOW_AUTOSTART_DIR: DIR, APPIMAGE: '' } })).toBe(`Exec=${expected}/openaflow" "--hidden"`)
    // Unpackaged: Electron's binary, then the app folder, then --hidden. APPIMAGE is ignored.
    expect(
      lineOf({ packaged: false, execPath: '/repo/node_modules/electron/dist/electron', appPath: `${odd}/desktop`, env: { OPENAFLOW_AUTOSTART_DIR: DIR, APPIMAGE: '/x.AppImage' } }),
    ).toBe(`Exec="/repo/node_modules/electron/dist/electron" ${expected}/desktop" "--hidden"`)
  })

  test('linux autostart on and off', () => {
    const other = `${DIR}/other.desktop`
    const fs = fakeFs({ [other]: 'keep me' })
    const item = linuxItem(fs)
    expect(item.isOn()).toBe(false)

    expect(item.set(true)).toBe(true)
    expect(fs.mkdir).toHaveBeenCalledWith(DIR)
    expect(fs.store.get(FILE)).toBe(entry(OWN_EXEC))
    expect(fs.modes.get(FILE)).toBe(0o644)
    // Written beside it, then renamed: the temp file is gone and never ends in .desktop.
    const temp = fs.writeFile.mock.calls[0]![0]
    expect(temp.startsWith(`${DIR}/`)).toBe(true)
    expect(temp.endsWith('.desktop')).toBe(false)
    expect(fs.rename).toHaveBeenCalledWith(temp, FILE)
    expect([...fs.store.keys()].sort()).toEqual([FILE, other].sort())
    expect(item.isOn()).toBe(true)
    // On again: the same file.
    expect(item.set(true)).toBe(true)
    expect(fs.store.get(FILE)).toBe(entry(OWN_EXEC))

    expect(item.set(false)).toBe(false)
    expect(fs.remove).toHaveBeenCalledWith(FILE)
    expect([...fs.store.keys()]).toEqual([other])
    expect(fs.store.get(other)).toBe('keep me')
    // Off with no file is fine.
    expect(item.set(false)).toBe(false)
    expect(fs.remove).toHaveBeenCalledTimes(2)
  })

  test('linux reads only its own entry', () => {
    const cases = [
      entry('"/somewhere/else/OpenAFlow.AppImage" "--hidden"'),
      entry(`${OWN_EXEC} "--extra"`),
      `${entry(OWN_EXEC)}Hidden=true\n`,
      entry(OWN_EXEC).replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'),
      `${entry(OWN_EXEC)}Hidden = true\n`,
      '',
    ]
    for (const text of cases) {
      const fs = fakeFs({ [FILE]: text })
      const item = linuxItem(fs)
      expect(item.isOn(), text).toBe(false)
      // On after that rewrites the file to the app's own.
      expect(item.set(true), text).toBe(true)
      expect(fs.store.get(FILE)).toBe(entry(OWN_EXEC))
    }
    // Windows line ends and other keys don't matter.
    expect(linuxItem(fakeFs({ [FILE]: `${entry(OWN_EXEC).replaceAll('\n', '\r\n')}Comment=x\n` })).isOn()).toBe(true)
  })

  test('autostart folder', () => {
    expect(autostartDir({ OPENAFLOW_AUTOSTART_DIR: '/t/auto', XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe('/t/auto')
    expect(autostartDir({ OPENAFLOW_AUTOSTART_DIR: 'rel/auto', XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe('/x/autostart')
    expect(autostartDir({ OPENAFLOW_AUTOSTART_DIR: '', XDG_CONFIG_HOME: '/x/' }, '/home/u')).toBe('/x/autostart')
    expect(autostartDir({ XDG_CONFIG_HOME: 'x' }, '/home/u')).toBe('/home/u/.config/autostart')
    expect(autostartDir({ OPENAFLOW_AUTOSTART_DIR: './a', XDG_CONFIG_HOME: '' }, '/home/u')).toBe('/home/u/.config/autostart')
    expect(autostartDir({}, '/home/u')).toBe('/home/u/.config/autostart')
    expect(AUTOSTART_FILE).toBe('openaflow.desktop')

    // The item writes in that folder.
    const fs = fakeFs()
    linuxItem(fs, { env: { XDG_CONFIG_HOME: '/cfg' } }).set(true)
    expect([...fs.store.keys()]).toEqual(['/cfg/autostart/openaflow.desktop'])
  })

  test('answers what a read returns', () => {
    const allowed = { window: 'win', isMainFrame: true, url: 'http://127.0.0.1:4000/#/r' }
    const bridgeOf = (item: LoginItem) => createLoginBridge({ item, origin: () => 'http://127.0.0.1:4000', appWindow: () => 'win', log: () => {} })

    // A write that throws: the state read after it.
    const fs = fakeFs({ [FILE]: entry(OWN_EXEC) })
    fs.remove.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    expect(bridgeOf(linuxItem(fs)).set(allowed, false)).toEqual({ on: true })
    const failedWrite = fakeFs()
    failedWrite.rename.mockImplementation(() => {
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
    })
    expect(bridgeOf(linuxItem(failedWrite)).set(allowed, true)).toEqual({ on: false })
    // The temp file doesn't stay behind.
    expect([...failedWrite.store.keys()]).toEqual([])
    const api = fakeApi(true)
    api.set.mockImplementation(() => {
      throw new Error('registry says no')
    })
    const win = loginItemFor({ platform: 'win32', packaged: false, appPath: APP, execPath: 'E:\\electron.exe', env: {}, home: 'C:\\', fs: fakeFs(), api })
    expect(bridgeOf(win).set(allowed, false)).toEqual({ on: true })

    // A read that throws, alone or after a write: `login item failed`.
    const unreadable = fakeFs()
    unreadable.readFile.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    expect(bridgeOf(linuxItem(unreadable)).get(allowed)).toEqual({ error: 'login item failed' })
    expect(bridgeOf(linuxItem(unreadable)).set(allowed, true)).toEqual({ error: 'login item failed' })
    api.get.mockImplementation(() => {
      throw new Error('registry says no')
    })
    expect(bridgeOf(win).get(allowed)).toEqual({ error: 'login item failed' })

    // The preload's side: a reply becomes a boolean or a rejection with its word.
    expect(loginAnswerOf({ on: true })).toBe(true)
    expect(loginAnswerOf({ on: false })).toBe(false)
    for (const word of ['forbidden', 'bad request', 'login item failed']) expect(() => loginAnswerOf({ error: word })).toThrow(new Error(word))
    for (const odd of [undefined, null, 'yes', { on: 'yes' }, { error: 'other' }]) expect(() => loginAnswerOf(odd)).toThrow(new Error('login item failed'))
  })

  test('sender rule', () => {
    const origin = 'http://127.0.0.1:4000'
    const item = { isOn: vi.fn(() => false), set: vi.fn((on: boolean) => on) }
    let ready = true
    const bridge = createLoginBridge({ item, origin: () => (ready ? origin : undefined), appWindow: () => 'win' })
    const forbidden = [
      { window: 'other', isMainFrame: true, url: `${origin}/` },
      { window: 'win', isMainFrame: false, url: `${origin}/` },
      { window: 'win', isMainFrame: true, url: 'http://127.0.0.1:4001/' },
      { window: 'win', isMainFrame: true, url: 'about:blank' },
      { window: undefined, isMainFrame: true, url: `${origin}/` },
    ]
    for (const caller of forbidden) {
      expect(bridge.get(caller)).toEqual({ error: 'forbidden' })
      expect(bridge.set(caller, true)).toEqual({ error: 'forbidden' })
      // Forbidden comes before bad request.
      expect(bridge.set(caller, 'yes')).toEqual({ error: 'forbidden' })
    }
    ready = false
    expect(bridge.get({ window: 'win', isMainFrame: true, url: `${origin}/` })).toEqual({ error: 'forbidden' })
    expect(item.isOn).not.toHaveBeenCalled()
    expect(item.set).not.toHaveBeenCalled()

    ready = true
    const page = { window: 'win', isMainFrame: true, url: `${origin}/#settings` }
    for (const bad of ['yes', 1, null, undefined, {}]) expect(bridge.set(page, bad)).toEqual({ error: 'bad request' })
    expect(item.set).not.toHaveBeenCalled()
    expect(bridge.get(page)).toEqual({ on: false })
    expect(bridge.set(page, true)).toEqual({ on: true })
    expect(item.set).toHaveBeenCalledWith(true)
  })
})
