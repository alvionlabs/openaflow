import { describe, expect, it, vi } from 'vitest'
import { folderBridge, terminalBridge } from './desktop-bridge.ts'

describe('bridge detection', () => {
  it('is undefined with no window, no openaflow, or a pickFolder that is not a function', () => {
    expect(folderBridge(undefined)).toBeUndefined()
    expect(folderBridge({})).toBeUndefined()
    expect(folderBridge({ openaflow: undefined })).toBeUndefined()
    expect(folderBridge({ openaflow: null })).toBeUndefined()
    expect(folderBridge({ openaflow: {} })).toBeUndefined()
    expect(folderBridge({ openaflow: { pickFolder: 'C:\\x' } })).toBeUndefined()
  })

  it('in node, with no window at all, reads as the browser build', () => {
    expect(typeof window).toBe('undefined')
    expect(folderBridge()).toBeUndefined()
  })

  it('returns a function that calls pickFolder when the desktop shell gives one', async () => {
    const pickFolder = vi.fn(async () => 'C:\\code\\repo')
    const pick = folderBridge({ openaflow: { pickFolder } })
    expect(pick).toBeTypeOf('function')
    expect(pickFolder).not.toHaveBeenCalled()
    await expect(pick!()).resolves.toBe('C:\\code\\repo')
    expect(pickFolder).toHaveBeenCalledTimes(1)
  })

  it('passes a rejection through', async () => {
    const pick = folderBridge({ openaflow: { pickFolder: () => Promise.reject(new Error('forbidden')) } })
    await expect(pick!()).rejects.toThrow('forbidden')
  })
})

describe('terminal bridge', () => {
  it('is undefined with no window.openaflow, or no connectTerminals', () => {
    expect(terminalBridge(undefined)).toBeUndefined()
    expect(terminalBridge({})).toBeUndefined()
    expect(terminalBridge({ openaflow: null })).toBeUndefined()
    expect(terminalBridge({ openaflow: { pickFolder: () => {} } })).toBeUndefined()
    expect(terminalBridge({ openaflow: { connectTerminals: 'x' } })).toBeUndefined()
  })

  it('in node, with no window at all, reads as the browser build', () => {
    expect(terminalBridge()).toBeUndefined()
  })

  it('connects through connectTerminals and passes host states, with a stop function', async () => {
    let listener: ((s: string) => void) | undefined
    const off = vi.fn()
    const connectTerminals = vi.fn(async () => {})
    const bridge = terminalBridge({
      openaflow: {
        connectTerminals,
        onTerminalHost: (fn: (s: string) => void) => {
          listener = fn
          return off
        },
      },
    })!
    await bridge.connect()
    expect(connectTerminals).toHaveBeenCalledTimes(1)
    const seen: string[] = []
    const stop = bridge.onHostState((s) => seen.push(s))
    listener!('restarted')
    expect(seen).toEqual(['restarted'])
    stop()
    expect(off).toHaveBeenCalled()
  })

  it('has a no-op onHostState when the shell gives no onTerminalHost', () => {
    const bridge = terminalBridge({ openaflow: { connectTerminals: async () => {} } })!
    expect(() => bridge.onHostState(() => {})()).not.toThrow()
  })

  it('gives onQuitting and hostState, or undefined where the page lacks them', async () => {
    const bare = terminalBridge({ openaflow: { connectTerminals: async () => {} } })!
    expect(bare.onQuitting).toBeUndefined()
    expect(bare.hostState).toBeUndefined()
    // Not functions: left out, not called.
    const wrong = terminalBridge({ openaflow: { connectTerminals: async () => {}, onQuitting: 'x', terminalHostState: 1 } })!
    expect(wrong.onQuitting).toBeUndefined()
    expect(wrong.hostState).toBeUndefined()

    let quit: ((n: number) => void) | undefined
    const off = vi.fn()
    const terminalHostState = vi.fn(async () => 'unresponsive')
    const bridge = terminalBridge({
      openaflow: {
        connectTerminals: async () => {},
        onQuitting: (fn: (n: number) => void) => {
          quit = fn
          return off
        },
        terminalHostState,
      },
    })!
    const counts: number[] = []
    const stop = bridge.onQuitting!((n) => counts.push(n))
    quit!(2)
    expect(counts).toEqual([2])
    stop()
    expect(off).toHaveBeenCalled()
    await expect(bridge.hostState!()).resolves.toBe('unresponsive')
    expect(terminalHostState).toHaveBeenCalledTimes(1)
    // A shell whose onQuitting returns nothing still gives a stop function.
    const quiet = terminalBridge({ openaflow: { connectTerminals: async () => {}, onQuitting: () => undefined } })!
    expect(() => quiet.onQuitting!(() => {})()).not.toThrow()
  })
})
