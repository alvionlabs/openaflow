import { describe, expect, test, vi } from 'vitest'
import { trayMenu } from './tray-menu.ts'

const menu = () => {
  const on = { onOpen: vi.fn(), onSettings: vi.fn(), onQuit: vi.fn() }
  return { on, items: trayMenu(on) }
}

describe('tray menu', () => {
  test('tray menu', () => {
    const { on, items } = menu()
    expect(items.map((i) => i.label)).toEqual(['Open', 'Settings', 'Quit'])
    for (const row of items) {
      expect(row).not.toHaveProperty('type')
      expect(row).not.toHaveProperty('checked')
    }

    items[0]!.click()
    expect(on.onOpen).toHaveBeenCalledOnce()
    expect(on.onSettings).not.toHaveBeenCalled()
    expect(on.onQuit).not.toHaveBeenCalled()
    items[1]!.click()
    expect(on.onSettings).toHaveBeenCalledOnce()
    expect(on.onOpen).toHaveBeenCalledOnce()
    expect(on.onQuit).not.toHaveBeenCalled()
    items[2]!.click()
    expect(on.onQuit).toHaveBeenCalledOnce()
  })
})
