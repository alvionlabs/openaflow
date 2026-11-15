import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { HostToMain } from '../src/protocol.ts'
import { startPtyHost, type PtyModule } from '../src/service.ts'

// The real node-pty under Node: its prebuilt binary, a real program, and the real headless terminal. Electron's
// own proof is packages/desktop/src/real-pty-proof.test.ts.

const require = createRequire(import.meta.url)
const WIN = process.platform === 'win32'

const until = async (what: string | (() => string), ok: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('real pty', () => {
  test('a real pty runs a program and reports its output and exit', async () => {
    const sent: HostToMain[] = []
    const exits: number[] = []
    const host = startPtyHost({
      loadPty: () => require('node-pty') as PtyModule,
      send: (m) => sent.push(m),
      exit: (code) => exits.push(code),
      isDir: (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true,
      scrollback: 5_000,
    })
    expect(sent).toEqual([{ type: 'ready', version: 1 }])

    const [program, args] = WIN
      ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/c', 'echo pty-says-hello& exit /b 7']]
      : ['/bin/sh', ['-c', 'echo pty-says-hello; exit 7']]
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
    host.handle({ type: 'start', spec: { id: 'real-1', program, args, cwd: tmpdir(), env, cols: 80, rows: 24 } })

    // Each failure shows every message so far, so one CI run on Windows shows the whole picture.
    const seen = () => JSON.stringify(sent)
    // On Windows the pid comes a moment after the spawn, and `started` waits for it.
    const answer = () => sent.find((m) => m.type === 'started' || m.type === 'start-failed')
    await until(() => `started: ${seen()}`, () => answer() !== undefined)
    expect(answer(), seen()).toMatchObject({ type: 'started', id: 'real-1' })
    expect((answer() as { pid: number }).pid, seen()).toBeGreaterThan(0)

    await until(() => `exit: ${seen()}`, () => sent.some((m) => m.type === 'exit'))
    expect(sent.filter((m) => m.type === 'exit'), seen()).toEqual([{ type: 'exit', id: 'real-1', exitCode: 7 }])

    // ConPTY can pass the last output a moment after the exit, so ask until the line shows.
    const snapshots = () => sent.filter((m): m is Extract<HostToMain, { type: 'snapshot' }> => m.type === 'snapshot')
    await until(() => `the output on the screen: ${seen()}`, () => {
      if (snapshots().at(-1)?.text?.includes('pty-says-hello')) return true
      host.handle({ type: 'snapshot', id: 'real-1' })
      return false
    })
    expect(snapshots().at(-1)).toMatchObject({ type: 'snapshot', id: 'real-1' })
    expect(snapshots().at(-1)!.text, seen()).toContain('pty-says-hello')

    host.handle({ type: 'shutdown' })
    await until(() => `host exit: ${seen()}`, () => exits.length > 0, 4_000)
    expect(exits, seen()).toEqual([0])
  })
})
