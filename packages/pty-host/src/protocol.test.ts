import { describe, expect, test } from 'vitest'
import { specError } from './protocol.ts'

const o = { isAbsolute: (p: string) => p.startsWith('/'), isDir: () => true }
const base = { id: 'run-1', program: '/bin/sh', args: [], cwd: '/work', env: {}, cols: 80, rows: 24 }

describe('specError', () => {
  test('scrollback rule', () => {
    for (const scrollback of [99, 100_001, 1.5, '5000', null, Number.NaN]) {
      expect(specError({ ...base, scrollback }, o), String(scrollback)).toBe('bad scrollback')
    }
    for (const scrollback of [100, 100_000, undefined]) {
      expect(specError({ ...base, scrollback }, o), String(scrollback)).toBeUndefined()
    }
    expect(specError(base, o)).toBeUndefined()
    // A bad screen file comes first.
    expect(specError({ ...base, screenFile: 'rel.txt', scrollback: 99 }, o)).toBe('bad screen file')
  })
})
