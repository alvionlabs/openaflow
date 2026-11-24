import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { blocksSideload, managedSettingsPath } from './managed-settings.ts'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'oaf-managed-settings-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('managed settings', () => {
  test('path per platform', () => {
    expect(managedSettingsPath('linux')).toBe('/etc/claude-code/managed-settings.json')
    expect(managedSettingsPath('win32')).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json')
    expect(managedSettingsPath('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-settings.json')
    // Any other platform reads as Linux does.
    expect(managedSettingsPath('freebsd')).toBe('/etc/claude-code/managed-settings.json')
  })

  test('disableSideloadFlags true blocks; anything else does not', async () => {
    const file = join(root, 'managed-settings.json')
    const at = async (text: string | undefined) => {
      rmSync(file, { recursive: true, force: true })
      if (text !== undefined) writeFileSync(file, text)
      return blocksSideload(file)
    }
    expect(await at(JSON.stringify({ disableSideloadFlags: true }))).toBe(true)
    expect(await at(JSON.stringify({ permissions: {}, disableSideloadFlags: true }))).toBe(true)
    // Missing, invalid, not an object, or any other value.
    expect(await at(undefined)).toBe(false)
    for (const text of ['', '{', 'true', 'null', '[{"disableSideloadFlags":true}]', '"x"']) expect(await at(text), text).toBe(false)
    for (const v of [false, 'true', 1, null, {}]) expect(await at(JSON.stringify({ disableSideloadFlags: v })), JSON.stringify(v)).toBe(false)
    expect(await at(JSON.stringify({ other: true }))).toBe(false)
    // A folder in its place can't be read.
    rmSync(file)
    mkdirSync(file)
    expect(await blocksSideload(file)).toBe(false)
  })
})
