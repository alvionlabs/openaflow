import { describe, expect, it, vi } from 'vitest'
import { onTabRequest, requestTab } from './open-tab.ts'

function fakeWindow() {
  const target = new EventTarget()
  return target as unknown as Window
}

describe('tab requests', () => {
  it('reaches each listener once; a stopped listener hears nothing', () => {
    const win = fakeWindow()
    const a = vi.fn()
    const b = vi.fn()
    const stopA = onTabRequest(a, win)
    onTabRequest(b, win)
    requestTab('terminal', win)
    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith('terminal')
    expect(b).toHaveBeenCalledTimes(1)
    stopA()
    requestTab('terminal', win)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('ignores an unknown tab and a malformed event', () => {
    const win = fakeWindow()
    const fn = vi.fn()
    onTabRequest(fn, win)
    requestTab('nope' as never, win)
    win.dispatchEvent(new CustomEvent('openaflow:open-tab', { detail: null }))
    win.dispatchEvent(new CustomEvent('openaflow:open-tab'))
    expect(fn).not.toHaveBeenCalled()
  })

  it('does nothing with no window', () => {
    expect(() => requestTab('terminal', undefined)).not.toThrow()
    expect(onTabRequest(() => {}, undefined)).toBeTypeOf('function')
  })
})
