import { describe, expect, test } from 'vitest'
import { DEFAULT_SCROLLBACK, scrollbackFrom } from './host-config.ts'
import { createSession } from './session.ts'

const pty = { write() {}, resize() {}, pause() {}, resume() {} }

describe('host config', () => {
  test('scrollback', async () => {
    expect(DEFAULT_SCROLLBACK).toBe(5_000)
    // Unset is the normal case: the default, with no log line.
    expect(scrollbackFrom({})).toEqual({ scrollback: 5_000 })
    expect(scrollbackFrom({ OPENAFLOW_SCROLLBACK: '' })).toEqual({ scrollback: 5_000 })
    for (const [value, scrollback] of [['100', 100], ['100000', 100_000], ['20000', 20_000]] as const) {
      expect(scrollbackFrom({ OPENAFLOW_SCROLLBACK: value }), value).toEqual({ scrollback })
    }
    for (const value of ['99', '100001', '0', '-500', '500.5', '1e4', ' 500', '500 ', 'abc', '0x200', '+500']) {
      const got = scrollbackFrom({ OPENAFLOW_SCROLLBACK: value })
      expect(got.scrollback, value).toBe(5_000)
      expect(got.log, value).toBe(`openaflow pty host: OPENAFLOW_SCROLLBACK must be a whole number from 100 to 100000, not ${JSON.stringify(value)}; using 5000`)
    }

    // 6,000 lines in a one-row terminal: the newest 5,000 stay.
    const session = createSession({ id: 'run-1', pty, cols: 80, rows: 1, scrollback: scrollbackFrom({}).scrollback })
    for (let i = 1; i <= 6_000; i++) session.output(`line ${i}\r\n`)
    const lines = (await new Promise<string | null>((r) => session.snapshot(r)))!.split('\n')
    expect(lines).toHaveLength(5_000)
    expect(lines[0]).toBe('line 1001')
    expect(lines.at(-1)).toBe('line 6000')
  })
})
