// A session's screen file: its snapshot text, saved where main asked (`StartSpec.screenFile`), so the page can show
// the last screen after the session is gone. service.ts says when to save; this file says how. The rules are in
// pod-docs/sprints/session-life.md (§2).

import { randomBytes } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { SCREEN_SAVE_MS } from './protocol.ts'

/** The file operations a save uses. `writeFile` makes a new file with mode 0600. */
export type ScreenFs = {
  mkdir(dir: string): Promise<unknown>
  writeFile(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export const nodeScreenFs: ScreenFs = {
  mkdir: (dir) => mkdir(dir, { recursive: true, mode: 0o700 }),
  // `wx`: a temp name that is somehow there already fails, and never takes that file's rights.
  writeFile: (path, text) => writeFile(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
}

/**
 * Replaces `file` whole: makes its folder, writes a temp file beside it, and renames that onto it, so a reader sees
 * the old text or the new one, never a part. `stopped` is asked before each step: once it is true, nothing more
 * lands and the temp file goes. Rejects when a step fails.
 */
export async function writeScreenFile(fs: ScreenFs, file: string, text: string, stopped: () => boolean = () => false): Promise<void> {
  if (stopped()) return
  await fs.mkdir(dirname(file))
  if (stopped()) return
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(temp, text)
    if (stopped()) throw new Error('stopped')
    await fs.rename(temp, file)
  } catch (err) {
    await fs.unlink(temp).catch(() => {})
    if (!stopped()) throw err
  }
}

export type ScreenSaver = {
  /** The pty wrote output: the next 10 s mark saves, if the text changed. */
  changed(): void
  /** Saves the text now. Resolves when the save ends, or failed, or the saver was disposed. Never rejects. */
  save(): Promise<void>
  /** No more 10 s saves. `save` still works. */
  stop(): void
  /** No more saves of any kind; one in flight never lands. */
  dispose(): void
}

const errorCode = (err: unknown) => {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err)
}

export function createScreenSaver(o: {
  id: string
  file: string
  fs: ScreenFs
  log(line: string): void
  /** The session's snapshot text, after every chunk written so far; `null` once it is disposed. */
  snapshot(fn: (text: string | null) => void): void
}): ScreenSaver {
  let dirty = false
  let disposed = false
  let lastText: string | undefined
  let failed = false
  /** One save at a time, so an older text never lands after a newer one. At most one more waits. */
  let running: Promise<void> | undefined
  let queued: Promise<void> | undefined

  const stopped = () => disposed

  const run = (onlyChanged: boolean) =>
    new Promise<string | null>((r) => o.snapshot(r)).then(async (text) => {
      if (disposed || text === null || (onlyChanged && text === lastText)) return
      try {
        await writeScreenFile(o.fs, o.file, text, stopped)
        lastText = text
      } catch (err) {
        // One line for the session's first failure, with no screen text. The session goes on.
        if (failed || disposed) return
        failed = true
        o.log(`openaflow pty host: session ${o.id.slice(0, 8)} could not save its screen: ${errorCode(err)}`)
      }
    })

  const enqueue = (onlyChanged: boolean): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (queued !== undefined) return queued
    const start = () => {
      queued = undefined
      const p = run(onlyChanged).catch(() => {})
      running = p
      void p.then(() => {
        if (running === p) running = undefined
      })
      return p
    }
    if (running === undefined) return start()
    queued = running.then(start)
    return queued
  }

  const timer = setInterval(() => {
    if (!dirty) return
    dirty = false
    void enqueue(true)
  }, SCREEN_SAVE_MS)

  return {
    changed() {
      dirty = true
    },
    save() {
      dirty = false
      return enqueue(false)
    },
    stop() {
      clearInterval(timer)
    },
    dispose() {
      disposed = true
      clearInterval(timer)
    },
  }
}
