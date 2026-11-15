import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalBridge, TerminalHostRead, TerminalHostState } from '../../desktop-bridge.ts'
import { BANNER_NOTE, BANNER_TITLE, overlayView, overlayWords, shownAfter, watchBanner, watchOverlay } from './host-banner.ts'

/** A fake shell bridge: `emit` plays a host state event, `read` settles the load-time read. */
function fake(read?: () => Promise<TerminalHostRead>) {
  let listener: ((s: TerminalHostState) => void) | undefined
  const stopped = vi.fn(() => {
    listener = undefined
  })
  const bridge: Pick<TerminalBridge, 'onHostState' | 'hostState'> = {
    onHostState: (fn) => {
      listener = fn
      return stopped
    },
    hostState: read,
  }
  return { bridge, emit: (s: TerminalHostState) => listener?.(s), stopped }
}

const later = () => new Promise<void>((r) => setTimeout(r, 0))

describe('banner', () => {
  it('has the draft words', () => {
    expect(BANNER_TITLE).toBe('Terminals are not responding.')
    expect(BANNER_NOTE).toBe('Your sessions may still run. The app keeps trying.')
  })

  it('shows on unresponsive and hides on ready and restarted', () => {
    expect(shownAfter(false, 'unresponsive')).toBe(true)
    expect(shownAfter(true, 'ready')).toBe(false)
    expect(shownAfter(true, 'restarted')).toBe(false)
    // The host gave up for good, so "the app keeps trying" would be false.
    expect(shownAfter(true, 'failed')).toBe(false)
    expect(shownAfter(true, 'starting')).toBe(false)
    // A word it doesn't know changes nothing.
    expect(shownAfter(true, 'weird')).toBe(true)
    expect(shownAfter(false, 'weird')).toBe(false)

    const { bridge, emit } = fake()
    const seen: boolean[] = []
    watchBanner(bridge, (v) => seen.push(v))
    emit('unresponsive')
    emit('ready')
    emit('unresponsive')
    emit('restarted')
    expect(seen.at(-1)).toBe(false)
    expect(seen.filter((v) => v)).toHaveLength(2)
  })

  it('reads the state at load', async () => {
    const down = fake(async () => 'unresponsive')
    const a: boolean[] = []
    watchBanner(down.bridge, (v) => a.push(v))
    await later()
    expect(a.at(-1)).toBe(true)

    const up = fake(async () => 'ready')
    const b: boolean[] = []
    watchBanner(up.bridge, (v) => b.push(v))
    await later()
    expect(b.at(-1)).toBe(false)

    // A read that fails, or a shell with no read, leaves the banner hidden.
    const broken = fake(() => Promise.reject(new Error('forbidden')))
    const c: boolean[] = []
    watchBanner(broken.bridge, (v) => c.push(v))
    await later()
    expect(c).not.toContain(true)
    const none = fake(undefined)
    const d: boolean[] = []
    watchBanner(none.bridge, (v) => d.push(v))
    await later()
    expect(d).not.toContain(true)
  })

  it('lets an event that came during the read win', async () => {
    let settle!: (s: TerminalHostRead) => void
    const f = fake(() => new Promise<TerminalHostRead>((r) => (settle = r)))
    const seen: boolean[] = []
    watchBanner(f.bridge, (v) => seen.push(v))
    f.emit('restarted')
    settle('unresponsive')
    await later()
    expect(seen.at(-1)).toBe(false)
  })

  it('stops watching', async () => {
    let settle!: (s: TerminalHostRead) => void
    const f = fake(() => new Promise<TerminalHostRead>((r) => (settle = r)))
    const seen: boolean[] = []
    const stop = watchBanner(f.bridge, (v) => seen.push(v))
    stop()
    expect(f.stopped).toHaveBeenCalled()
    settle('unresponsive')
    await later()
    expect(seen).not.toContain(true)
  })

  it('never shows without a bridge', async () => {
    const seen: boolean[] = []
    const stop = watchBanner(undefined, (v) => seen.push(v))
    await later()
    expect(seen).not.toContain(true)
    expect(() => stop()).not.toThrow()
  })
})

describe('overlay', () => {
  it('says how many sessions end', () => {
    expect(overlayWords(1)).toBe('Ending 1 session…')
    expect(overlayWords(3)).toBe('Ending 3 sessions…')
  })

  it('is a status with no buttons', () => {
    expect(overlayView(1)).toEqual({ role: 'status', text: 'Ending 1 session…' })
    expect(overlayView(3)).toEqual({ role: 'status', text: 'Ending 3 sessions…' })
    // A count that is not a whole number of at least 1 draws nothing.
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) expect(overlayView(bad), String(bad)).toBeUndefined()
    const source = readFileSync(new URL('./QuitOverlay.tsx', import.meta.url), 'utf8')
    expect(source).toContain('role={view.role}')
    expect(source).not.toMatch(/<button|<a[\s>]|<input/)
  })

  it('opens on onQuitting and never without the bridge', () => {
    let fire!: (n: number) => void
    const off = vi.fn()
    const seen: number[] = []
    const stop = watchOverlay({ onQuitting: (fn) => ((fire = fn), off) }, (n) => seen.push(n))
    fire(2)
    expect(seen).toEqual([2])
    stop()
    expect(off).toHaveBeenCalled()

    const none: number[] = []
    expect(() => watchOverlay(undefined, (n) => none.push(n))()).not.toThrow()
    expect(() => watchOverlay({ onQuitting: undefined }, (n) => none.push(n))()).not.toThrow()
    expect(none).toEqual([])
  })
})
