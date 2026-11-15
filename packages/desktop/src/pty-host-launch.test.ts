import { join, sep } from 'node:path'
import { describe, expect, test } from 'vitest'
import { hooksPluginDir, hostLogLine, ptyHostEntry, ptyHostEnv } from './pty-host-launch.ts'

const appPath = join('E:', 'repo', 'packages', 'desktop')
const resourcesPath = join('C:', 'pod', 'resources')

describe('pty host launch', () => {
  test('paths and env, dev and packaged', () => {
    expect(ptyHostEntry({ packaged: false, appPath, resourcesPath })).toBe(join('E:', 'repo', 'packages', 'pty-host', 'dist', 'pty-host.cjs'))
    expect(hooksPluginDir({ packaged: false, appPath, resourcesPath })).toBe(join('E:', 'repo', 'packages', 'hooks-plugin', 'plugin'))

    const packaged = { packaged: true, appPath: join(resourcesPath, 'app.asar'), resourcesPath }
    expect(ptyHostEntry(packaged)).toBe(join(resourcesPath, 'pty-host', 'pty-host.cjs'))
    expect(hooksPluginDir(packaged)).toBe(join(resourcesPath, 'hooks-plugin'))
    // Outside the asar, and never in resources/app, which Electron loads as an app.
    for (const path of [ptyHostEntry(packaged), hooksPluginDir(packaged)]) {
      expect(path.split(sep)).not.toContain('app.asar')
      expect(path.split(sep)).not.toContain('app')
    }

    const input: NodeJS.ProcessEnv = {
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\bin',
      OPENAFLOW_CONFIG_DIR: 'C:\\cfg',
      ELECTRON_RUN_AS_NODE: '1',
      electron_run_as_node: '1',
      Electron_Run_As_Node: '',
    }
    const before = { ...input }
    const env = ptyHostEnv(input)
    expect(env).toEqual({ SystemRoot: 'C:\\Windows', Path: 'C:\\bin', OPENAFLOW_CONFIG_DIR: 'C:\\cfg' })
    expect(input).toEqual(before)
    expect(env).not.toBe(input)
    expect(ptyHostEnv({})).toEqual({})
  })

  test('log lines', () => {
    expect(hostLogLine({ type: 'ready', version: 1 })).toBe('openaflow desktop: terminal host ready')
    expect(hostLogLine({ type: 'load-failed', error: 'Failed to load native module: pty.node' })).toBe(
      'openaflow desktop: terminal host could not load node-pty: Failed to load native module: pty.node',
    )
    expect(hostLogLine({ type: 'started', id: 'a', pid: 1 })).toBeUndefined()
    expect(hostLogLine(null)).toBeUndefined()
  })
})
