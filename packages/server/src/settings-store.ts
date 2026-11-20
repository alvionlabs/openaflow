// The settings file, `<config dir>/settings.json` (sprint settings, shared contract §2). Any server reads and
// writes it, dev and `pnpm start` too. It is read at each use, with no cache, so a hand edit applies to the next
// start. The rules and why are in pod-docs/feature-details/settings.md.

import { readFile, rename as fsRename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SETTINGS_SCROLLBACK, type SettingsChange } from '@openaflow/model'
import { commandTextError } from './run-wrapper.ts'

/** The settings in force. A text key that is absent means the platform default; `''` means none. */
export type Settings = { scrollback: number; runWrapper?: string; stopCommand?: string }

export type SettingsFile = { v: 1; scrollback?: number; runWrapper?: string; stopCommand?: string }

export type SettingsStore = {
  /** The file as it is now. Missing or unreadable: all defaults. A bad key: that key's default. */
  read(): Promise<Settings>
  /** Applies `patch` to the file as it is when its turn comes (`null` removes a key). Rejects when the write fails. */
  change(patch: SettingsChange): Promise<Settings>
}

const KEYS = ['scrollback', 'runWrapper', 'stopCommand'] as const
type Key = (typeof KEYS)[number]

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether `n` is a scrollback setting: an integer from 100 to 100,000. */
export const isScrollback = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= SETTINGS_SCROLLBACK.min && (n as number) <= SETTINGS_SCROLLBACK.max

const goodValue = (key: Key, v: unknown): boolean => (key === 'scrollback' ? isScrollback(v) : typeof v === 'string' && commandTextError(v) === undefined)

/** The file's good keys, and the names of its bad ones; or `undefined` for a file that can't be read. */
async function readKeys(file: string): Promise<{ keys: Omit<SettingsFile, 'v'>; bad: Key[] } | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { keys: {}, bad: [] }
    return undefined
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(data) || data.v !== 1) return undefined
  const keys: Record<string, unknown> = {}
  const bad: Key[] = []
  for (const key of KEYS) {
    if (!(key in data)) continue
    if (goodValue(key, data[key])) keys[key] = data[key]
    else bad.push(key)
  }
  return { keys: keys as Omit<SettingsFile, 'v'>, bad }
}

const inForce = (keys: Omit<SettingsFile, 'v'>): Settings => ({ ...keys, scrollback: keys.scrollback ?? SETTINGS_SCROLLBACK.default })

export function createSettingsStore(o: { file: string; log(line: string): void; rename?: (from: string, to: string) => Promise<void> }): SettingsStore {
  const name = path.basename(o.file)
  const rename = o.rename ?? fsRename
  let writes: Promise<unknown> = Promise.resolve()
  let tempCount = 0

  return {
    async read() {
      const read = await readKeys(o.file)
      if (read === undefined) {
        o.log(`openaflow: ${name} can't be read; using defaults`)
        return inForce({})
      }
      for (const key of read.bad) o.log(`openaflow: ${name} has a bad ${key}; using its default`)
      return inForce(read.keys)
    },
    change(patch) {
      const next = writes.then(async () => {
        // A file that can't be read, and its bad keys, are replaced by this change.
        const keys: Record<string, unknown> = { ...((await readKeys(o.file))?.keys ?? {}) }
        for (const key of KEYS) {
          if (!(key in patch)) continue
          if (patch[key] === null) delete keys[key]
          else keys[key] = patch[key]
        }
        const body = { v: 1, ...keys } as SettingsFile
        const temp = `${o.file}.${process.pid}.${++tempCount}.tmp`
        try {
          await writeFile(temp, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
          await rename(temp, o.file)
        } catch (err) {
          await unlink(temp).catch(() => {})
          throw err
        }
        return inForce(keys)
      })
      // The next change waits for this one, whether it lands or not.
      writes = next.catch(() => {})
      return next
    },
  }
}
