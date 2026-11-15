import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ParentChannel } from './parent-link.ts'
import { createSessionStore, followChannel } from './session-store.ts'
import { createTerminalChannel, TERMINAL_MESSAGE, type StartSpec } from './terminal-channel.ts'

const M1 = '11111111-1111-4111-8111-111111111111'
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const spec = (id = M1): StartSpec => ({ id, program: '/bin/claude', args: [], cwd: '/repos/a', env: {}, cols: 120, rows: 30 })

/** A fake parent channel: what the server sent, and a way to answer as main. */
function fakeLink() {
  const sent: Record<string, unknown>[] = []
  let deliver: (m: unknown) => void = () => {}
  const link: ParentChannel = { onMessage: (fn) => void (deliver = fn), send: (m) => void sent.push(m as Record<string, unknown>) }
  const answer = (m: Record<string, unknown>) => deliver({ type: TERMINAL_MESSAGE, ...m })
  return { link, sent, answer, deliver: (m: unknown) => deliver(m) }
}

let root: string
let logs: string[]
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'openaflow-channel-')))
  logs = []
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('terminal channel', () => {
  test('start, list and dispose ask main and take its answers', async () => {
    const f = fakeLink()
    const ch = createTerminalChannel({ link: f.link, log: (l) => logs.push(l) })
    const first = ch.start(spec())
    const second = ch.start(spec('22222222-2222-4222-8222-222222222222'))
    const listed = ch.list()
    ch.dispose(M1)
    expect(f.sent).toEqual([
      { type: TERMINAL_MESSAGE, op: 'start', req: 1, spec: spec() },
      { type: TERMINAL_MESSAGE, op: 'start', req: 2, spec: spec('22222222-2222-4222-8222-222222222222') },
      { type: TERMINAL_MESSAGE, op: 'list', req: 3 },
      { type: TERMINAL_MESSAGE, op: 'dispose', id: M1 },
    ])
    f.answer({ op: 'start-failed', req: 2, id: '22222222-2222-4222-8222-222222222222', error: 'no folder' })
    f.answer({ op: 'started', req: 1, id: M1, pid: 77 })
    f.answer({ op: 'list', req: 3, sessions: [{ id: M1, pid: 77, live: true, startedAt: 5 }] })
    await expect(first).resolves.toEqual({ pid: 77 })
    await expect(second).rejects.toThrow('no folder')
    await expect(listed).resolves.toEqual([{ id: M1, pid: 77, live: true, startedAt: 5 }])
    // A repeated answer for a settled request changes nothing.
    f.answer({ op: 'started', req: 1, id: M1, pid: 78 })
    const failedList = ch.list()
    f.answer({ op: 'list-failed', req: 4, error: 'terminals unavailable' })
    await expect(failedList).rejects.toThrow('terminals unavailable')
    ch.close()
  })

  test('answer limit', async () => {
    vi.useFakeTimers()
    const f = fakeLink()
    const ch = createTerminalChannel({ link: f.link, log: (l) => logs.push(l) })
    const store = createSessionStore({ file: join(root, 'sessions.json'), writable: true, now: () => 9, log: () => {} })
    followChannel(store, ch)
    await store.add({ marker: M1, repoPath: '/repos/a', sessionId: S1, skill: 'plan', startedAt: 1, state: 'starting' })
    const start = ch.start(spec())
    const outcome = start.then(
      () => 'resolved',
      (err: Error) => err.message,
    )
    await vi.advanceTimersByTimeAsync(29_999)
    expect(store.list()[0]!.state).toBe('starting')
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('terminals unavailable')
    // A late started still makes the record live.
    f.answer({ op: 'started', req: 1, id: M1, pid: 31 })
    expect(store.list()[0]).toMatchObject({ state: 'live', pid: 31 })
    // A list with no answer rejects too.
    const list = ch.list().then(
      () => 'resolved',
      (err: Error) => err.message,
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await list).toBe('no answer')
    ch.close()
    vi.useRealTimers()
    await store.saved()
  })

  test('exit and lost reach listeners, and the store is live before the start answers', async () => {
    const f = fakeLink()
    const ch = createTerminalChannel({ link: f.link, log: (l) => logs.push(l) })
    const store = createSessionStore({ file: join(root, 'sessions.json'), writable: true, now: () => 9, log: () => {} })
    followChannel(store, ch)
    const events: unknown[] = []
    ch.onEvent((e) => events.push(e))
    await store.add({ marker: M1, repoPath: '/repos/a', sessionId: S1, skill: 'plan', startedAt: 1, state: 'starting' })
    const start = ch.start(spec()).then(() => store.list()[0]!.state)
    f.answer({ op: 'started', req: 1, id: M1, pid: 31 })
    expect(await start).toBe('live')
    f.answer({ op: 'exit', id: M1, exitCode: 2 })
    f.answer({ op: 'lost', ids: [] })
    expect(events).toEqual([
      { op: 'started', id: M1, pid: 31 },
      { op: 'exit', id: M1, exitCode: 2 },
      { op: 'lost', ids: [] },
    ])
    ch.close()
    await store.saved()
  })

  test('bad messages change nothing and log one line each', async () => {
    const f = fakeLink()
    const ch = createTerminalChannel({ link: f.link, log: (l) => logs.push(l) })
    const events: unknown[] = []
    ch.onEvent((e) => events.push(e))
    // Other message types (the stop message) are not this channel's: no line.
    f.deliver({ type: 'openaflow:stop' })
    f.deliver('text')
    expect(logs).toEqual([])
    f.answer({ op: 'kill', id: M1 })
    f.answer({ op: 'started', req: 1, id: M1 })
    f.answer({ op: 'exit', id: M1, exitCode: 'x' })
    f.answer({ op: 'lost', ids: [1] })
    f.answer({ op: 'list', req: 1, sessions: 'none' })
    expect(events).toEqual([])
    expect(logs).toHaveLength(5)
    expect(logs.every((l) => l.startsWith('openaflow: terminal channel ignored a bad message'))).toBe(true)
    // After close, nothing more goes out or comes in.
    ch.close()
    f.answer({ op: 'exit', id: M1, exitCode: 0 })
    expect(events).toEqual([])
    await expect(ch.start(spec())).rejects.toThrow('terminals unavailable')
    expect(f.sent).toEqual([])
  })
})
