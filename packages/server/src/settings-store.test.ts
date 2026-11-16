import { mkdtempSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createSettingsStore } from './settings-store.ts'

const WIN = process.platform === 'win32'
const CANT_READ = "openaflow: settings.json can't be read; using defaults"

let dir: string
let file: string
let lines: string[]
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'oaf-settings-store-')))
  file = join(dir, 'settings.json')
  lines = []
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const store = (o: { rename?: (from: string, to: string) => Promise<void> } = {}) => createSettingsStore({ file, log: (l) => lines.push(l), ...o })

describe('settings store', () => {
  test('reads defaults and keeps good keys', async () => {
    // Missing: all defaults, and no line.
    expect(await store().read()).toEqual({ scrollback: 5000 })
    expect(lines).toEqual([])

    // Not JSON, not an object, or another version: all defaults, one line each, and the file stays as it is.
    for (const text of ['{not json', '[1,2]', '"x"', 'null', JSON.stringify({ v: 2, scrollback: 300 }), JSON.stringify({ scrollback: 300 })]) {
      lines = []
      await writeFile(file, text)
      expect(await store().read(), text).toEqual({ scrollback: 5000 })
      expect(lines, text).toEqual([CANT_READ])
      expect(await readFile(file, 'utf8'), text).toBe(text)
    }

    // Good keys, also empty texts.
    lines = []
    await writeFile(file, JSON.stringify({ v: 1, scrollback: 200, runWrapper: 'wrap {runId}', stopCommand: '' }))
    expect(await store().read()).toEqual({ scrollback: 200, runWrapper: 'wrap {runId}', stopCommand: '' })
    expect(lines).toEqual([])

    // One bad key: its default and one line naming it; the other keys still apply. Unknown keys are ignored.
    const bad: [Record<string, unknown>, string, Record<string, unknown>][] = [
      [{ scrollback: 99, runWrapper: 'w' }, 'scrollback', { scrollback: 5000, runWrapper: 'w' }],
      [{ scrollback: 100_001 }, 'scrollback', { scrollback: 5000 }],
      [{ scrollback: 1.5 }, 'scrollback', { scrollback: 5000 }],
      [{ scrollback: '300', stopCommand: 's' }, 'scrollback', { scrollback: 5000, stopCommand: 's' }],
      [{ scrollback: 300, runWrapper: 'w "x' }, 'runWrapper', { scrollback: 300 }],
      [{ runWrapper: 7, stopCommand: 's' }, 'runWrapper', { scrollback: 5000, stopCommand: 's' }],
      [{ runWrapper: 'w', stopCommand: 'stop {nope}' }, 'stopCommand', { scrollback: 5000, runWrapper: 'w' }],
      [{ stopCommand: null, other: 1 }, 'stopCommand', { scrollback: 5000 }],
    ]
    for (const [keys, name, want] of bad) {
      lines = []
      const text = JSON.stringify({ v: 1, ...keys })
      await writeFile(file, text)
      expect(await store().read(), text).toEqual(want)
      expect(lines, text).toEqual([`openaflow: settings.json has a bad ${name}; using its default`])
      expect(await readFile(file, 'utf8'), text).toBe(text)
    }

    // Read at each call, with no cache: a hand edit applies to the next read.
    const s = store()
    await writeFile(file, JSON.stringify({ v: 1, scrollback: 400 }))
    expect((await s.read()).scrollback).toBe(400)
    await writeFile(file, JSON.stringify({ v: 1, scrollback: 500 }))
    expect((await s.read()).scrollback).toBe(500)
  })

  test('writes one at a time, whole', async () => {
    const s = store()
    // Two changes started together both land, each on the file as it is then.
    const [a, b] = await Promise.all([s.change({ scrollback: 300 }), s.change({ runWrapper: 'wrap --x' })])
    expect(a).toEqual({ scrollback: 300 })
    expect(b).toEqual({ scrollback: 300, runWrapper: 'wrap --x' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 1, scrollback: 300, runWrapper: 'wrap --x' })
    if (!WIN) expect(statSync(file).mode & 0o777).toBe(0o600)

    // Only the keys sent change; null removes one.
    expect(await s.change({ stopCommand: '', runWrapper: null })).toEqual({ scrollback: 300, stopCommand: '' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 1, scrollback: 300, stopCommand: '' })

    // A hand edit between changes is kept by the next change.
    await writeFile(file, JSON.stringify({ v: 1, scrollback: 700, stopCommand: '' }))
    expect(await s.change({ runWrapper: 'w' })).toEqual({ scrollback: 700, stopCommand: '', runWrapper: 'w' })

    // A failed rename: the change rejects, the old file stays, and no temp file is left.
    const before = await readFile(file, 'utf8')
    const failing = store({ rename: async () => Promise.reject(Object.assign(new Error('nope'), { code: 'EACCES' })) })
    await expect(failing.change({ scrollback: 900 })).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['settings.json'])
    // The queue goes on after a failure.
    const after = store({ rename })
    expect(await after.change({ scrollback: 901 })).toEqual({ scrollback: 901, stopCommand: '', runWrapper: 'w' })

    // A change on a file that can't be read starts from defaults and replaces it.
    await writeFile(file, '{bad')
    expect(await s.change({ scrollback: 150 })).toEqual({ scrollback: 150 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 1, scrollback: 150 })
  })
})
