import { join, sep } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createPtyHostClient, hooksPluginDir, hostLogLine, ptyHostEntry, ptyHostEnv } from './pty-host-launch.ts'

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

describe('pty host client', () => {
  const client = () => {
    const posted: unknown[] = []
    const c = createPtyHostClient((m) => posted.push(m))
    return { c, posted }
  }

  test('a start waits for ready, then answers the pid', async () => {
    const { c, posted } = client()
    const spec = { id: 'a', program: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 }
    const started = c.start(spec)
    await Promise.resolve()
    expect(posted).toEqual([])
    c.onMessage({ type: 'ready', version: 1 })
    await Promise.resolve()
    expect(posted).toEqual([{ type: 'start', spec }])
    c.onMessage({ type: 'started', id: 'other', pid: 9 })
    c.onMessage({ type: 'started', id: 'a', pid: 42 })
    await expect(started).resolves.toEqual({ pid: 42 })
  })

  test('start-failed rejects with its error', async () => {
    const { c } = client()
    c.onMessage({ type: 'ready', version: 1 })
    const started = c.start({ id: 'Bad', program: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 })
    await Promise.resolve()
    c.onMessage({ type: 'start-failed', id: 'Bad', error: 'bad id' })
    await expect(started).rejects.toThrow('bad id')
  })

  test('snapshot answers by id, in order', async () => {
    const { c, posted } = client()
    c.onMessage({ type: 'ready', version: 1 })
    const first = c.snapshot('a')
    const second = c.snapshot('a')
    const other = c.snapshot('b')
    await Promise.resolve()
    expect(posted).toEqual([{ type: 'snapshot', id: 'a' }, { type: 'snapshot', id: 'a' }, { type: 'snapshot', id: 'b' }])
    c.onMessage({ type: 'snapshot', id: 'b', text: null })
    c.onMessage({ type: 'snapshot', id: 'a', text: 'one' })
    c.onMessage({ type: 'snapshot', id: 'a', text: 'two' })
    await expect(first).resolves.toBe('one')
    await expect(second).resolves.toBe('two')
    await expect(other).resolves.toBeNull()
  })

  test('load-failed or a host exit rejects what waits, and every later call', async () => {
    const { c } = client()
    const before = c.snapshot('a')
    c.onMessage({ type: 'load-failed', error: 'no binary' })
    await expect(before).rejects.toThrow('terminals unavailable: no binary')
    await expect(c.snapshot('a')).rejects.toThrow('terminals unavailable')

    const other = client()
    other.c.onMessage({ type: 'ready', version: 1 })
    const pending = other.c.snapshot('a')
    await Promise.resolve()
    other.c.fail('terminal host exited')
    await expect(pending).rejects.toThrow('terminals unavailable: terminal host exited')
  })
})
