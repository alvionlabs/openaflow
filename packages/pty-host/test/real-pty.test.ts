import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { HostToMain, HostToWindow } from '../src/protocol.ts'
import { startPtyHost, type PtyModule } from '../src/service.ts'
import type { WindowPort } from '../src/session.ts'

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


const env = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

function realHost() {
  const sent: HostToMain[] = []
  const exits: number[] = []
  const host = startPtyHost({
    loadPty: () => require('node-pty') as PtyModule,
    send: (m) => sent.push(m),
    exit: (code) => exits.push(code),
    isDir: (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true,
    scrollback: 5_000,
  })
  return { host, sent, exits, seen: () => JSON.stringify(sent) }
}

/** A stand-in for a window's MessagePortMain, given to the host as main's `connect` does. */
function windowPort(host: ReturnType<typeof realHost>['host']) {
  const listeners: ((e: { data: unknown }) => void)[] = []
  const got: HostToWindow[] = []
  const port: WindowPort = {
    on: (event: 'message' | 'close', fn: never) => void (event === 'message' && listeners.push(fn)),
    start: () => {},
    postMessage: (m) => void got.push(m as HostToWindow),
  }
  host.handle({ type: 'connect' }, [port])
  const text = () => got.filter((m) => m.type === 'replay' || m.type === 'data').map((m) => (m as { data: string }).data).join('')
  return { got, text, send: (data: unknown) => listeners.forEach((fn) => fn({ data })) }
}

/** Node as the program: the same on Windows and Linux. */
const node = (script: string) => ({ program: process.execPath, args: ['-e', script] })

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
  test('input reaches a real pty', async () => {
    const h = realHost()
    // It prints a prompt, then answers the first line it reads, changed, so the answer can't be the tty's own echo.
    const { program, args } = node("process.stdout.write('ask me\\n'); process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { process.stdout.write('got:' + d.trim().toUpperCase() + '\\n'); process.exit(0) })")
    h.host.handle({ type: 'start', spec: { id: 'real-input', program, args, cwd: tmpdir(), env: env(), cols: 80, rows: 24 } })
    await until(() => `started: ${h.seen()}`, () => h.sent.some((m) => m.type === 'started' || m.type === 'start-failed'))
    expect(h.sent.find((m) => m.type === 'started' || m.type === 'start-failed'), h.seen()).toMatchObject({ type: 'started', id: 'real-input' })

    const w = windowPort(h.host)
    w.send({ type: 'attach', id: 'real-input' })
    await until(() => `the prompt: ${JSON.stringify(w.got)}`, () => w.text().includes('ask me'))
    w.send({ type: 'input', id: 'real-input', data: 'hello pty\r' })
    await until(() => `the answer: ${JSON.stringify(w.got)}`, () => w.text().includes('got:HELLO PTY'))
    await until(() => `exit: ${JSON.stringify(w.got)}`, () => w.got.some((m) => m.type === 'exit'))
    expect(w.got.filter((m) => m.type === 'exit'), JSON.stringify(w.got)).toEqual([{ type: 'exit', id: 'real-input', exitCode: 0 }])
    expect(w.got.filter((m) => m.type === 'error')).toEqual([])

    h.host.handle({ type: 'shutdown' })
    await until(() => `host exit: ${h.seen()}`, () => h.exits.length > 0, 4_000)
  })

  test('kill ends a real pty with one exit', async () => {
    const h = realHost()
    const { program, args } = node("process.stdout.write('running\\n'); setInterval(() => {}, 1000)")
    h.host.handle({ type: 'start', spec: { id: 'real-kill', program, args, cwd: tmpdir(), env: env(), cols: 80, rows: 24 } })
    const w = windowPort(h.host)
    await until(() => `started: ${h.seen()}`, () => h.sent.some((m) => m.type === 'started' || m.type === 'start-failed'))
    w.send({ type: 'attach', id: 'real-kill' })
    // On Windows node-pty holds a kill until the first output, so wait for it as a user would see it.
    await until(() => `output: ${JSON.stringify(w.got)}`, () => w.text().includes('running'))
    h.host.handle({ type: 'kill', id: 'real-kill' })
    await until(() => `exit: ${h.seen()}`, () => h.sent.some((m) => m.type === 'exit'))
    await new Promise((r) => setTimeout(r, 300))
    expect(h.sent.filter((m) => m.type === 'exit'), h.seen()).toHaveLength(1)
    expect(w.got.filter((m) => m.type === 'exit'), JSON.stringify(w.got)).toHaveLength(1)
    h.host.handle({ type: 'list' })
    expect(h.sent.at(-1), h.seen()).toMatchObject({ type: 'list', sessions: [{ id: 'real-kill', live: false }] })

    h.host.handle({ type: 'shutdown' })
    await until(() => `host exit: ${h.seen()}`, () => h.exits.length > 0, 4_000)
  })
})
