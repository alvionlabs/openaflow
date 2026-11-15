// What every install proof uses: a temp place, the machine-wide lock, the machine's state before and after, and the
// install, launch, and uninstall steps. On Linux: the AppImage's temp place, its unpack, its start, and its end. No
// `electron` import. The rules are in pod-docs/sprints/installer-and-updates.md and pod-docs/sprints/host-core.md (P1).

import { execFile, spawn } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { configPath } from '@openaflow/server/config'
import { processAlive } from '@openaflow/server/parent-link'
import { EXE_NAME, UPDATER_CACHE_DIR } from './build-config.ts'
import { APP_ID, APP_NAME } from './shell-config.ts'

const OWNER_FILE = 'auto-continue-owner.json'
const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
const SYS32 = join(SYSTEM_ROOT, 'System32')
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const UNINSTALL_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const UNINSTALLER = `Uninstall ${APP_NAME}.exe`
const LOCK_FILE = 'openaflow-install-proof.lock'
const LOCK_WAIT_MS = 30 * 60_000
/** A lock file with no process ID is one that a holder is writing, until it's this old. */
const UNREADABLE_LOCK_MS = 60_000
const HEALTH_MS = 90_000
const INSTALL_MS = 180_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type ProofPlace = { root: string; installDir: string; env: NodeJS.ProcessEnv; port: number }

/** Inherits only what isn't this project's or the caller's: a stripped env, so a run can't reach a real folder. */
function keptEnv(alsoDropped: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase()
    const dropped = ['OPENAFLOW_', 'CLAUDE', 'ELECTRON_', 'VITEST', 'FAKE_CLAUDE', 'NODE_', 'NPM_', 'PNPM_'].some((prefix) => upper.startsWith(prefix))
    if (!dropped && upper !== 'PATH' && !alsoDropped.includes(key)) env[key] = value
  }
  return env
}

const strippedEnv = (): NodeJS.ProcessEnv => ({ ...keptEnv(), SystemRoot: SYSTEM_ROOT, Path: SYS32 })

/** Temp root named openaflow-install-proof-*; install folder, config, shell data, ports, and claude folders inside it. */
export function proofPlace(port: number): ProofPlace {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openaflow-install-proof-')))
  const folder = (name: string) => {
    const path = join(root, name)
    mkdirSync(path)
    return path
  }
  return {
    root,
    port,
    installDir: join(root, 'install'),
    env: {
      ...strippedEnv(),
      OPENAFLOW_API_PORT: String(port),
      OPENAFLOW_CONFIG_DIR: folder('config'),
      OPENAFLOW_DESKTOP_DATA_DIR: folder('shell'),
      OPENAFLOW_PORTS_DIR: folder('ports'),
      OPENAFLOW_CLAUDE_DIR: folder('claude'),
      // In production the server uses this path only, so no run can find a real claude.
      OPENAFLOW_CLAUDE_BIN: join(root, 'no-claude', 'claude.cmd'),
    },
  }
}

type LockOptions = { path?: string; pollMs?: number; waitMs?: number }

/** Creates the file only when it doesn't exist. Answers false when another holder has it. */
function tryCreate(path: string, text: string): boolean {
  try {
    const fd = openSync(path, 'wx')
    writeSync(fd, text)
    closeSync(fd)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/** The holder's process ID, `stale`, or `gone`. */
function readHolder(path: string): number | 'stale' | 'gone' {
  try {
    const text = readFileSync(path, 'utf8').trim()
    const pid = Number(text)
    if (text !== '' && Number.isInteger(pid) && pid > 0) return processAlive(pid) ? pid : 'stale'
    return Date.now() - statSync(path).mtimeMs > UNREADABLE_LOCK_MS ? 'stale' : process.pid
  } catch {
    return 'gone'
  }
}

/** Only the one who makes the guard file may remove a stale lock, so a waiter never removes a newer holder's lock. */
function takeOver(path: string): void {
  const guard = `${path}.takeover`
  if (!tryCreate(guard, String(process.pid))) {
    if (readHolder(guard) === 'stale') rmSync(guard, { force: true })
    return
  }
  try {
    if (readHolder(path) === 'stale') rmSync(path, { force: true })
  } finally {
    rmSync(guard, { force: true })
  }
}

/** One holder per machine. Waits up to 30 min; a holder whose process ID is gone is stale and is taken over. */
export async function withInstallLock<T>(fn: () => Promise<T>, o: LockOptions = {}): Promise<T> {
  const path = o.path ?? join(tmpdir(), LOCK_FILE)
  const end = Date.now() + (o.waitMs ?? LOCK_WAIT_MS)
  let holder: number | 'stale' | 'gone' = 'gone'
  while (!tryCreate(path, String(process.pid))) {
    holder = readHolder(path)
    if (holder === 'stale') takeOver(path)
    else if (Date.now() > end) throw new Error(`the install lock ${path} is still held by process ${holder}`)
    await sleep(o.pollMs ?? 1000)
  }
  try {
    return await fn()
  } finally {
    rmSync(path, { force: true })
  }
}

/** realConfig: each file's name and modified time in the real config folder; null when there's no folder. */
export type MachineState = { uninstallKeys: string[]; runValue: string | null; startMenu: string[]; apps: number[]; updaterCache: boolean; realConfig: string[] | null }

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const path = join(e.parentPath, e.name)
      return `${relative(dir, path).replaceAll('\\', '/')} ${statSync(path).mtimeMs}`
    })
    .sort()
}

function ownerLives(dir: string): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8')) as { pid?: unknown }
    return typeof pid === 'number' && processAlive(pid)
  } catch {
    return false
  }
}

/** A live server at the first read leaves the folder out for the whole proof: its files change on their own. */
export function createRealConfigReader(dir: string): () => { files: string[] | null; held: boolean } {
  let held: boolean | undefined
  return () => {
    held ??= ownerLives(dir)
    if (held) return { files: null, held: true }
    return { files: existsSync(dir) ? listFiles(dir) : null, held: false }
  }
}

/** The folder an installed app with no temp env would use. */
const realConfigDir = () => dirname(configPath({ APPDATA: process.env.APPDATA }, 'win32', homedir()))
const updaterCacheDir = () => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), UPDATER_CACHE_DIR)
const startMenuDir = () => join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
let readRealConfig: ReturnType<typeof createRealConfigReader> | undefined
const realConfig = () => (readRealConfig ??= createRealConfigReader(realConfigDir()))()

/** Answers the tool's standard output. A non-zero exit means "not found" for the read-only tools used here. */
const stdoutOf = (file: string, args: string[]) =>
  new Promise<string>((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(stdout))
  })

async function uninstallKeys(): Promise<string[]> {
  const queries = [
    `HKCU\\${UNINSTALL_KEY}`,
    `HKLM\\${UNINSTALL_KEY}`,
    `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall`,
  ].map((key) => stdoutOf(join(SYS32, 'reg.exe'), ['query', key, '/s', '/d', '/f', APP_NAME]))
  const lines = (await Promise.all(queries)).flatMap((text) => text.split(/\r?\n/))
  return [...new Set(lines.filter((line) => line.startsWith('HKEY_')).map((line) => line.trim()))].sort()
}

async function runValue(): Promise<string | null> {
  const text = await stdoutOf(join(SYS32, 'reg.exe'), ['query', RUN_KEY, '/v', APP_ID])
  return new RegExp(`^\\s*${APP_ID.replaceAll('.', '\\.')}\\s+REG_\\w+\\s+(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null
}

function startMenuEntries(): string[] {
  const dir = startMenuDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.name.toLowerCase().includes(APP_NAME.toLowerCase()))
    .map((e) => join(e.parentPath, e.name))
    .sort()
}

async function appProcesses(): Promise<number[]> {
  const text = await stdoutOf(join(SYS32, 'tasklist.exe'), ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/FO', 'CSV', '/NH'])
  return text
    .split(/\r?\n/)
    .map((line) => /^"[^"]+","(\d+)"/.exec(line)?.[1])
    .filter((pid) => pid !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
}

export async function machineState(): Promise<MachineState> {
  const [keys, run, apps] = await Promise.all([uninstallKeys(), runValue(), appProcesses()])
  return { uninstallKeys: keys, runValue: run, startMenu: startMenuEntries(), apps, updaterCache: existsSync(updaterCacheDir()), realConfig: realConfig().files }
}

/** Empty when nothing differs. Each line names one leftover. */
export function stateDiff(before: MachineState, after: MachineState): string[] {
  const added = <T>(was: T[], now: T[]) => now.filter((item) => !was.includes(item))
  const lines = [
    ...added(before.uninstallKeys, after.uninstallKeys).map((key) => `uninstall key: ${key}`),
    ...(after.runValue === before.runValue ? [] : [`Run value: ${after.runValue ?? 'removed'}, was ${before.runValue ?? 'unset'}`]),
    ...added(before.startMenu, after.startMenu).map((entry) => `Start-menu entry: ${entry}`),
    ...added(before.apps, after.apps).map((pid) => `app process: ${pid}`),
    ...(after.updaterCache === before.updaterCache ? [] : [`updater cache: ${after.updaterCache ? 'left behind' : 'removed'} (${UPDATER_CACHE_DIR})`]),
  ]
  const was = before.realConfig ?? []
  const now = after.realConfig ?? []
  const nameOf = (entry: string) => entry.slice(0, entry.lastIndexOf(' '))
  const wasNames = was.map(nameOf)
  const nowNames = now.map(nameOf)
  for (const entry of added(was, now)) lines.push(`real config: ${wasNames.includes(nameOf(entry)) ? 'changed' : 'new'} file ${nameOf(entry)}`)
  for (const name of added(nowNames, wasNames)) lines.push(`real config: removed file ${name}`)
  return lines
}

/** Throws, naming what it found, when the app is already installed for this user. */
export function refuseRealInstall(state: MachineState): void {
  const found = [
    ...state.uninstallKeys.map((key) => `uninstall key ${key}`),
    ...state.startMenu.map((entry) => `Start-menu entry ${entry}`),
    ...(state.runValue === null ? [] : [`Run value ${state.runValue}`]),
    ...state.apps.map((pid) => `app process ${pid}`),
  ]
  if (found.length > 0) throw new Error(`${APP_NAME} is already on this machine, so the proof won't install over it: ${found.join('; ')}`)
}

const exitOf = (file: string, args: string[], ms: number, verbatim = false) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim })
    const timer = setTimeout(() => reject(new Error(`${file} took over ${ms} ms`)), ms)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })

/** `/S /D=<installDir>`. NSIS reads `/D=` raw, with no quotes, as the last argument. */
export async function silentInstall(installer: string, place: ProofPlace): Promise<void> {
  if (!existsSync(installer)) throw new Error(`no installer at ${installer}: run pnpm package first`)
  const code = await exitOf(installer, ['/S', `/D=${place.installDir}`], INSTALL_MS, true)
  if (code !== 0) throw new Error(`the installer exited with ${code}`)
  if (!existsSync(join(place.installDir, EXE_NAME))) throw new Error(`the installer put no ${EXE_NAME} in ${place.installDir}`)
}

/** Each main process a proof starts, so that its end stops only those. */
const launched = new Set<number>()
let lastOutput: () => string = () => ''

export async function launch(place: ProofPlace, args: string[] = []): Promise<{ pid: number; output(): string }> {
  // Not hidden: the exe has no console, and SW_HIDE would swallow its window's first show, as no real launch does.
  const child = spawn(join(place.installDir, EXE_NAME), args, { cwd: place.root, env: place.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
  let text = ''
  child.stdout.on('data', (d) => (text += String(d)))
  child.stderr.on('data', (d) => (text += String(d)))
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  launched.add(child.pid!)
  lastOutput = () => text
  return { pid: child.pid!, output: () => text }
}

/** /api/health answers {"ok":true}; a timeout throws, with the output tail. */
export async function waitForHealth(place: ProofPlace, ms = HEALTH_MS): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${place.port}/api/health`)
      if (((await res.json()) as { ok?: unknown }).ok === true) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > end) throw new Error(`no health answer on port ${place.port} in ${ms} ms. Output tail:\n${lastOutput().slice(-2000)}`)
    await sleep(250)
  }
}

/**
 * Waits until the install folder and the registry keys are gone: NSIS re-launches itself, so the first process exits
 * at once, and the copy removes the folder first and the keys last.
 */
export async function silentUninstall(place: ProofPlace): Promise<void> {
  const uninstaller = join(place.installDir, UNINSTALLER)
  if (!existsSync(uninstaller)) throw new Error(`no uninstaller at ${uninstaller}`)
  const keys = await uninstallKeys()
  const code = await exitOf(uninstaller, ['/currentuser', '/S'], INSTALL_MS)
  if (code !== 0) throw new Error(`the uninstaller exited with ${code}`)
  // electron-builder names the app's own key after its uninstall key.
  const appKeys = keys.map((key) => `HKCU\\Software\\${key.split('\\').pop()!}`)
  const left = async () => [
    ...(existsSync(place.installDir) ? [place.installDir] : []),
    ...(await uninstallKeys()).filter((key) => keys.includes(key)),
    ...(await Promise.all(appKeys.map(async (key) => ((await stdoutOf(join(SYS32, 'reg.exe'), ['query', key])) === '' ? '' : key)))).filter((key) => key !== ''),
  ]
  const end = Date.now() + INSTALL_MS
  for (;;) {
    const remaining = await left()
    if (remaining.length === 0) return
    if (Date.now() > end) throw new Error(`the uninstaller left ${remaining.join(', ')}`)
    await sleep(250)
  }
}

/** A killed process's handles close a moment after it's gone, so try the removal again. */
async function removeWithRetry(path: string): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (tries >= 200 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw err
      await sleep(100)
    }
  }
}

/**
 * The `finally` of every proof, on a pass or a failure: uninstalls, removes the temp root and the updater cache the
 * install made, and answers the diff against the state from before the install. It ends only processes a proof
 * started, by their recorded process IDs. The uninstaller ends the rest, the server included.
 */
export async function finishProof(place: ProofPlace, before: MachineState): Promise<string[]> {
  for (const pid of launched) {
    if (processAlive(pid)) {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    }
  }
  launched.clear()
  if (existsSync(join(place.installDir, UNINSTALLER))) await silentUninstall(place)
  // A failed uninstall can't take a Run value with it. This one names the temp folder, so it's the proof's own.
  if ((await runValue())?.includes(place.root)) await stdoutOf(join(SYS32, 'reg.exe'), ['delete', RUN_KEY, '/v', APP_ID, '/f'])
  if (!before.updaterCache) await removeWithRetry(updaterCacheDir())
  await removeWithRetry(place.root)
  return stateDiff(before, await machineState())
}

/** Every proof's final line. */
export function proofLastLine(diff: string[]): string {
  const held = realConfig().held ? ' (a live server holds the real config folder, so realConfig reads null in both states)' : ''
  return `state diff: ${JSON.stringify(diff)}${held}`
}

// Linux: no install. The release check unpacks the AppImage to read it, then starts the AppImage itself.

/** The system's tools only: no folder of the caller's, so no real `claude`. */
const LINUX_PATH = '/usr/local/bin:/usr/bin:/bin'
/** How long the app has to end after a SIGTERM to its process group. */
const END_MS = 20_000
const KILL_MS = 5_000
const UNPACK_MS = 120_000
/** What the release check's temp root is named: openaflow-release-check-*. */
export const APPIMAGE_ROOT_PREFIX = 'openaflow-release-check-'

/**
 * A temp root with a temp home, config, shell data, ports, claude, and TMPDIR. With APPIMAGE_EXTRACT_AND_RUN=1 the
 * AppImage needs no FUSE: its runtime unpacks into TMPDIR, so inside the root. installDir is where the check unpacks it.
 */
export function appImagePlace(port: number): ProofPlace {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), APPIMAGE_ROOT_PREFIX)))
  const folder = (name: string) => {
    const path = join(root, name)
    mkdirSync(path)
    return path
  }
  const home = folder('home')
  // Also dropped: anything that points the app at the caller's home, or says it runs inside another AppImage.
  const env = keptEnv(['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'])
  return {
    root,
    port,
    installDir: folder('unpacked'),
    env: {
      ...env,
      PATH: LINUX_PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      TMPDIR: folder('tmp'),
      APPIMAGE_EXTRACT_AND_RUN: '1',
      OPENAFLOW_API_PORT: String(port),
      OPENAFLOW_CONFIG_DIR: folder('config'),
      OPENAFLOW_DESKTOP_DATA_DIR: folder('shell'),
      OPENAFLOW_PORTS_DIR: folder('ports'),
      OPENAFLOW_CLAUDE_DIR: folder('claude'),
      OPENAFLOW_CLAUDE_BIN: join(root, 'no-claude', 'claude'),
    },
  }
}

/** `<AppImage> --appimage-extract` in installDir, with no FUSE. Answers the unpacked `resources` folder. */
export async function unpackAppImage(file: string, place: ProofPlace): Promise<string> {
  if (!existsSync(file)) throw new Error(`no AppImage at ${file}: run pnpm package first`)
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(file, ['--appimage-extract'], { cwd: place.installDir, env: place.env, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the unpack took over ${UNPACK_MS} ms`))
    }, UNPACK_MS)
    child.once('error', reject)
    child.once('exit', (c) => {
      clearTimeout(timer)
      resolve(c ?? 1)
    })
  })
  if (code !== 0) throw new Error(`${file} --appimage-extract exited with ${code}`)
  return join(place.installDir, 'squashfs-root', 'resources')
}

/** What a packaged app must hold outside its asar (host-core §2). */
const PACKAGED_PARTS = [
  'app.asar',
  'server',
  'THIRD-PARTY-NOTICES.txt',
  'pty-host/pty-host.cjs',
  'pty-host/node_modules/node-pty/package.json',
  'pty-host/node_modules/node-pty/prebuilds/linux-x64',
  'hooks-plugin/.claude-plugin/plugin.json',
  'hooks-plugin/hooks/hooks.json',
  'hooks-plugin/scripts/record.sh',
]

/** Each part of PACKAGED_PARTS that the resources folder lacks. */
export function missingParts(resources: string): string[] {
  return PACKAGED_PARTS.filter((part) => !existsSync(join(resources, part)))
}

/**
 * Starts the AppImage in its own process group, so its end reaches the runtime, Electron, and every child. Its output
 * goes to waitForHealth's failure text.
 */
export async function launchAppImage(file: string, place: ProofPlace): Promise<{ pid: number; output(): string }> {
  const child = spawn(file, [], { cwd: place.root, env: place.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  child.stdout.on('data', (d) => (text += String(d)))
  child.stderr.on('data', (d) => (text += String(d)))
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  lastOutput = () => text
  return { pid: child.pid!, output: () => text }
}

/**
 * This user's processes whose executable path starts with `prefix`: an AppImage's runtime, and every Electron process
 * that its unpack started. A process whose file was removed still counts. Never by name: the real app may run too.
 */
export async function processesUnder(prefix: string): Promise<number[]> {
  const pids: number[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if ((await readlink(join('/proc', entry, 'exe'))).startsWith(prefix)) pids.push(Number(entry))
    } catch {
      // Gone, or another user's.
    }
  }
  return pids.sort((a, b) => a - b)
}

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig)
  } catch {
    // already gone
  }
}

/** The process IDs whose parent is `pid`. */
async function childrenOf(pid: number): Promise<number[]> {
  const out: number[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      // The fields after the name, which can hold spaces and parentheses: state, then the parent's ID.
      const stat = await readFile(join('/proc', entry, 'stat'), 'utf8')
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === pid) out.push(Number(entry))
    } catch {
      // Gone.
    }
  }
  return out
}

/**
 * Ends what launchAppImage started, as a logout would: SIGTERM to the app's main process, the runtime's child, so
 * Electron quits and ends its own children; then the runtime removes its unpack and exits. Answers each process that
 * still ran END_MS later, from the group or from the root, then kills those. Empty means a clean end.
 */
export async function endAppImage(pid: number, place: ProofPlace): Promise<number[]> {
  const left = async () => [...new Set([...(groupAlive(pid) ? [pid] : []), ...(await processesUnder(`${place.root}/`))])].sort((a, b) => a - b)
  const main = await childrenOf(pid)
  for (const p of main.length > 0 ? main : [pid]) signal(p, 'SIGTERM')
  const waitEmpty = async (ms: number) => {
    const end = Date.now() + ms
    for (;;) {
      const now = await left()
      if (now.length === 0 || Date.now() > end) return now
      await sleep(100)
    }
  }
  const stayed = await waitEmpty(END_MS)
  if (stayed.length > 0) {
    signal(-pid, 'SIGKILL')
    for (const p of stayed) signal(p, 'SIGKILL')
    await waitEmpty(KILL_MS)
  }
  return stayed
}

/** Removes the root, unpack and all. */
export const removeAppImagePlace = (place: ProofPlace): Promise<void> => removeWithRetry(place.root)
