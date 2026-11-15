import { join, sep } from 'node:path'
import { describe, expect, test } from 'vitest'
import { hooksPluginDir } from './pty-host-launch.ts'
import { serverEntry, serverEnv } from './server-launch.ts'

const DEV = { packaged: false, appPath: join('E:', 'repo', 'packages', 'desktop'), resourcesPath: join('C:', 'pod', 'resources') }
const PLUGIN = join('E:', 'repo', 'packages', 'hooks-plugin', 'plugin')
const TERMINALS = { OPENAFLOW_TERMINALS: '1', OPENAFLOW_HOOKS_PLUGIN: PLUGIN }

describe('server launch', () => {
  test('finds the bundle', () => {
    const appPath = join('E:', 'repo', 'packages', 'desktop')
    const resourcesPath = join('C:', 'pod', 'resources')
    expect(serverEntry({ packaged: false, appPath, resourcesPath })).toBe(join('E:', 'repo', 'packages', 'server', 'dist', 'app', 'server.mjs'))

    const packaged = serverEntry({ packaged: true, appPath: join(resourcesPath, 'app.asar'), resourcesPath })
    expect(packaged).toBe(join(resourcesPath, 'server', 'server.mjs'))
    // Electron loads resources/app as an app, so the server never sits there.
    expect(packaged.split(sep)).not.toContain('app')
  })

  test('builds the server env', () => {
    const input: NodeJS.ProcessEnv = {
      Path: 'C:\\bin',
      OPENAFLOW_CONFIG_DIR: 'C:\\cfg',
      OPENAFLOW_API_PORT: '3110',
      OPENAFLOW_PARENT_PID: '1',
      openaflow_parent_pid: '2',
      ELECTRON_RUN_AS_NODE: '1',
      electron_run_as_node: '1',
      Electron_Run_As_Node: '',
    }
    const before = { ...input }

    const env = serverEnv(input, 4242, DEV)

    expect(env).toEqual({ Path: 'C:\\bin', OPENAFLOW_CONFIG_DIR: 'C:\\cfg', OPENAFLOW_API_PORT: '3110', OPENAFLOW_PARENT_PID: '4242', ...TERMINALS })
    expect(input).toEqual(before)
    expect(env).not.toBe(input)
  })

  test('sets the parent ID when none was set', () => {
    expect(serverEnv({}, 7, DEV)).toEqual({ OPENAFLOW_PARENT_PID: '7', ...TERMINALS })
  })

  test('terminal env', () => {
    const packaged = { packaged: true, appPath: join(DEV.resourcesPath, 'app.asar'), resourcesPath: DEV.resourcesPath }
    for (const place of [DEV, packaged]) {
      const env = serverEnv({ PATH: '/bin' }, 7, place)
      expect(env.OPENAFLOW_TERMINALS).toBe('1')
      expect(env.OPENAFLOW_HOOKS_PLUGIN).toBe(hooksPluginDir(place))
    }
    expect(serverEnv({}, 7, packaged).OPENAFLOW_HOOKS_PLUGIN).toBe(join(DEV.resourcesPath, 'hooks-plugin'))
    expect(serverEnv({}, 7, DEV).OPENAFLOW_HOOKS_PLUGIN).toBe(PLUGIN)

    // An inherited value, in any case, never wins: dev's `pnpm start` has no channel, so it must not claim one.
    const env = serverEnv({ openaflow_terminals: '0', Openaflow_Hooks_Plugin: '/elsewhere', OPENAFLOW_TERMINALS: '' }, 7, DEV)
    expect(env).toEqual({ OPENAFLOW_PARENT_PID: '7', ...TERMINALS })
    // With no place (a test reporter, not the app's server), no channel is claimed and inherited values still go.
    expect(serverEnv({ OPENAFLOW_TERMINALS: '1', OPENAFLOW_HOOKS_PLUGIN: '/x' }, 7)).toEqual({ OPENAFLOW_PARENT_PID: '7' })
  })
})
