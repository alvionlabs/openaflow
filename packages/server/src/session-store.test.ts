import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHookReader, createSessionStore, followChannel, hostedSession, reconcileSessions, type StoredSession } from './session-store.ts'
import type { SessionInfo, TerminalEvent } from './terminal-channel.ts'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const M3 = '33333333-3333-4333-8333-333333333333'
const M4 = '44444444-4444-4444-8444-444444444444'
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

let root: string
let file: string
let logs: string[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'openaflow-sessions-')))
  file = join(root, 'sessions.json')
  logs = []
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

const record = (marker: string, over: Partial<StoredSession> = {}): StoredSession => ({
  marker,
  repoPath: '/repos/a',
  sessionId: S1,
  skill: 'plan',
  startedAt: 1000,
  state: 'starting',
  ...over,
})

const saved = async () => JSON.parse(await readFile(file, 'utf8')) as { v: number; sessions: StoredSession[] }
const writable = (now = () => 5000) => createSessionStore({ file, writable: true, now, log: (l) => logs.push(l) })

describe('session store', () => {
  test('start transitions', async () => {
    const store = writable()
    // Saved as starting before anything is sent.
    await store.add(record(M1))
    expect((await saved()).sessions).toEqual([record(M1)])
    expect((await saved()).v).toBe(1)
    // started: live with the pid.
    await store.started(M1, 4242)
    expect((await saved()).sessions).toEqual([record(M1, { state: 'live', pid: 4242 })])
    // A refused start removes its record.
    await store.add(record(M2, { startedAt: 2000 }))
    await store.failed(M2)
    expect((await saved()).sessions.map((s) => s.marker)).toEqual([M1])
    // A started for a live record, or for an id the store never saved, changes nothing.
    await store.started(M1, 1)
    await store.started(M3, 1)
    expect(store.list()).toEqual([record(M1, { state: 'live', pid: 4242 })])
    // No temp file is left behind.
    expect(await readdir(root)).toEqual(['sessions.json'])
  })

  test('exit and lost', async () => {
    const store = writable()
    await store.add(record(M1))
    await store.started(M1, 10)
    await store.add(record(M2, { startedAt: 2000 }))
    await store.started(M2, 20)
    await store.add(record(M3, { startedAt: 3000 }))
    await store.exited(M1, 3)
    expect(store.list()[0]).toEqual(record(M1, { state: 'ended', pid: 10, exitCode: 3, endedAt: 5000 }))
    // lost: every named live or starting record is stopped · terminals restarted; an unknown id is ignored.
    await store.lost([M2, M3, M4, M1])
    expect(store.list()).toEqual([
      record(M1, { state: 'ended', pid: 10, exitCode: 3, endedAt: 5000 }),
      record(M2, { startedAt: 2000, state: 'stopped', stopReason: 'terminals restarted', pid: 20, endedAt: 5000 }),
      record(M3, { startedAt: 3000, state: 'stopped', stopReason: 'terminals restarted', endedAt: 5000 }),
    ])
    // ended and stopped never change.
    const before = store.list()
    await store.exited(M2, 0)
    await store.started(M3, 30)
    await store.failed(M3)
    await store.lost([M1])
    expect(store.list()).toEqual(before)
    expect((await saved()).sessions).toEqual(before)
  })

  test('the channel drives the store, and each change is reported', async () => {
    const store = writable()
    const changes: number[] = []
    store.onChange(() => changes.push(store.list().length))
    let send: (e: TerminalEvent) => void = () => {}
    followChannel(store, { onEvent: (fn) => ((send = fn), () => {}) })
    await store.add(record(M1))
    await store.add(record(M2))
    send({ op: 'started', id: M1, pid: 7 })
    send({ op: 'start-failed', id: M2, error: 'no folder' })
    send({ op: 'exit', id: M1, exitCode: 0 })
    send({ op: 'exit', id: M4, exitCode: 0 })
    expect(store.list()).toEqual([record(M1, { state: 'ended', pid: 7, exitCode: 0, endedAt: 5000 })])
    expect(changes).toEqual([1, 2, 2, 1, 1])
    await store.saved()
    expect((await saved()).sessions).toEqual(store.list())
  })

  test('reconcile', async () => {
    vi.useFakeTimers()
    const seed = [
      record(M1, { state: 'live', pid: 1 }),
      record(M2, { state: 'live', pid: 2 }),
      record(M3, { state: 'starting' }),
      record(M4, { state: 'ended', exitCode: 0, endedAt: 900 }),
    ]
    const info = (id: string, live: boolean, pid = 9): SessionInfo => ({ id, pid, live, startedAt: 1 })

    // Listed live stays live (a starting one becomes live with the listed pid), listed exited is ended with no
    // code, unlisted is stopped · app closed; an ended record never changes.
    await writeFile(file, JSON.stringify({ v: 1, sessions: seed }))
    let store = writable()
    await reconcileSessions(store, { list: async () => [info(M1, true, 1), info(M2, false), info(M3, true, 33), info(M4, true)] })
    expect(store.list()).toEqual([
      record(M1, { state: 'live', pid: 1 }),
      record(M2, { state: 'ended', pid: 2 }),
      record(M3, { state: 'live', pid: 33 }),
      seed[3],
    ])
    await writeFile(file, JSON.stringify({ v: 1, sessions: seed }))
    store = writable()
    await reconcileSessions(store, { list: async () => [] })
    expect(store.list().map((s) => [s.state, s.stopReason])).toEqual([
      ['stopped', 'app closed'],
      ['stopped', 'app closed'],
      ['stopped', 'app closed'],
      ['ended', undefined],
    ])
    expect((await saved()).sessions).toEqual(store.list())

    // terminals unavailable: the host failed for good, so starting and live are stopped · terminals restarted.
    await writeFile(file, JSON.stringify({ v: 1, sessions: seed }))
    store = writable()
    await reconcileSessions(store, { list: () => Promise.reject(new Error('terminals unavailable')) })
    expect(store.list().map((s) => [s.state, s.stopReason])).toEqual([
      ['stopped', 'terminals restarted'],
      ['stopped', 'terminals restarted'],
      ['stopped', 'terminals restarted'],
      ['ended', undefined],
    ])

    // Another failure retries once 30 s later; a second failure changes nothing.
    await writeFile(file, JSON.stringify({ v: 1, sessions: seed }))
    store = writable()
    let asks = 0
    const failing = reconcileSessions(store, { list: () => (asks++, Promise.reject(new Error('no answer'))) })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(asks).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(asks).toBe(2)
    await failing
    await vi.advanceTimersByTimeAsync(120_000)
    expect(asks).toBe(2)
    expect(store.list()).toEqual(seed)

    // The retry's answer counts.
    store = writable()
    let tries = 0
    const retried = reconcileSessions(store, { list: () => (++tries === 1 ? Promise.reject(new Error('terminal host exited')) : Promise.resolve([])) })
    await vi.advanceTimersByTimeAsync(30_000)
    await retried
    expect(store.list()[0]).toMatchObject({ state: 'stopped', stopReason: 'app closed' })
  })

  test('reconcile leaves a session started after it began', async () => {
    // A New session while the list waits for the host is unlisted, but it isn't a session from before the start.
    await writeFile(file, JSON.stringify({ v: 1, sessions: [record(M1, { state: 'live', pid: 1 })] }))
    const store = writable()
    let answer: (s: SessionInfo[]) => void = () => {}
    const done = reconcileSessions(store, { list: () => new Promise((r) => (answer = r)) })
    await store.add(record(M2, { startedAt: 6000 }))
    // And a record that changed while the list waited keeps its change.
    await store.exited(M1, 0)
    answer([])
    await done
    expect(store.list()).toEqual([record(M1, { state: 'ended', pid: 1, exitCode: 0, endedAt: 5000 }), record(M2, { startedAt: 6000 })])
  })

  test('resumed records', async () => {
    const store = writable()
    await store.add(record(M2, { resumedFrom: M1 }))
    expect((await saved()).sessions).toEqual([record(M2, { resumedFrom: M1 })])
    // A reload keeps it while the record is starting.
    expect(writable().list()).toEqual([record(M2, { resumedFrom: M1 })])
    // Dropped at started, in memory and on disk.
    await store.started(M2, 77)
    expect(store.list()).toEqual([record(M2, { state: 'live', pid: 77 })])
    expect((await saved()).sessions).toEqual([record(M2, { state: 'live', pid: 77 })])

    // Every other way out of starting drops it too: exit, lost, and the reconcile.
    await store.add(record(M3, { resumedFrom: M1 }))
    await store.exited(M3, 0)
    expect(store.list().find((r) => r.marker === M3)).not.toHaveProperty('resumedFrom')
    await store.add(record(M4, { resumedFrom: M1 }))
    await store.lost([M4])
    expect(store.list().find((r) => r.marker === M4)).not.toHaveProperty('resumedFrom')
    await writeFile(file, JSON.stringify({ v: 1, sessions: [record(M3, { resumedFrom: M1 }), record(M4, { resumedFrom: M1 })] }))
    const fresh = writable()
    await reconcileSessions(fresh, { list: async () => [{ id: M3, pid: 5, live: true, startedAt: 1 }] })
    expect(fresh.list()).toEqual([record(M3, { state: 'live', pid: 5 }), record(M4, { state: 'stopped', stopReason: 'app closed' })])

    // On read: a resumedFrom that isn't a UUID v4, or on a record that isn't starting, is dropped; the record stays.
    const bad = [record(M1, { resumedFrom: '../x' }), { ...record(M2, { state: 'live', pid: 3 }), resumedFrom: M1 }]
    await writeFile(file, JSON.stringify({ v: 1, sessions: bad }))
    expect(writable().list()).toEqual([record(M1), record(M2, { state: 'live', pid: 3 })])
  })

  test('reconcile answers the records it set to app closed', async () => {
    await writeFile(file, JSON.stringify({ v: 1, sessions: [record(M1, { state: 'live', pid: 1 }), record(M2, { state: 'live', pid: 2 }), record(M3, { state: 'ended' })] }))
    expect(await reconcileSessions(writable(), { list: async () => [{ id: M2, pid: 2, live: true, startedAt: 1 }] })).toEqual([M1])
    expect(await reconcileSessions(writable(), { list: async () => [{ id: M1, pid: 1, live: true, startedAt: 1 }, { id: M2, pid: 2, live: true, startedAt: 1 }] })).toEqual([])
    expect(await reconcileSessions(writable(), { list: () => Promise.reject(new Error('terminals unavailable')) })).toEqual([])
  })

  test('keeps scrollback and stop', async () => {
    const STOP = ['/usr/bin/systemctl', '--user', 'stop', `openaflow-run-${M1}.scope`]
    // Saved and read back as they were.
    const store = writable()
    await store.add(record(M1, { scrollback: 200, stop: STOP }))
    await store.started(M1, 7)
    await store.exited(M1, 0)
    expect((await saved()).sessions[0]).toEqual(record(M1, { state: 'ended', pid: 7, exitCode: 0, endedAt: 5000, scrollback: 200, stop: STOP }))
    expect(writable().list()[0]).toMatchObject({ scrollback: 200, stop: STOP })
    // The edges of each rule pass.
    const edges = [record(M1, { scrollback: 100, stop: ['/x'] }), record(M2, { scrollback: 100_000, stop: Array.from({ length: 32 }, (_, i) => (i === 0 ? '/' + 'a'.repeat(1023) : '')) })]
    await writeFile(file, JSON.stringify({ v: 1, sessions: edges }))
    expect(writable().list()).toEqual(edges)

    // A bad value is dropped on read; the record stays.
    const bad: [unknown, unknown][] = [
      [99, ['relative', '--user']],
      [100_001, []],
      [1.5, Array.from({ length: 33 }, () => '/x')],
      ['300', ['/x', 7]],
      [null, ['/' + 'a'.repeat(1024)]],
      [0, '/usr/bin/systemctl'],
      [5000.5, [''] as unknown],
    ]
    const markers = [M1, M2, M3, M4, '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777']
    await writeFile(file, JSON.stringify({ v: 1, sessions: bad.map(([scrollback, stop], i) => ({ ...record(markers[i]!), scrollback, stop })) }))
    const read = writable().list()
    expect(read).toEqual(markers.map((m) => record(m)))
    expect(logs).toEqual([])

    // The Board's session carries the record's scrollback, and never its stop.
    const hosted = hostedSession(record(M1, { state: 'live', scrollback: 300, stop: STOP }), undefined)
    expect(hosted.scrollback).toBe(300)
    expect(hosted).not.toHaveProperty('stop')
    expect(hostedSession(record(M1), undefined)).not.toHaveProperty('scrollback')
  })

  test('unreadable file', async () => {
    await writeFile(file, '{"v":1,"sessions":[')
    const store = writable()
    expect(store.list()).toEqual([])
    expect(logs.filter((l) => l.includes('sessions.json'))).toHaveLength(1)
    // The read leaves it alone; the next real change writes the whole store.
    expect(await readFile(file, 'utf8')).toBe('{"v":1,"sessions":[')
    await store.add(record(M1))
    expect((await saved()).sessions).toEqual([record(M1)])

    // A bad record is left out; the good ones stay. A missing file is empty, with no log line.
    await writeFile(file, JSON.stringify({ v: 1, sessions: [record(M1), { ...record(M2), marker: '../x' }, { ...record(M3), state: 'gone' }] }))
    expect(writable().list()).toEqual([record(M1)])
    await rm(file)
    logs = []
    expect(writable().list()).toEqual([])
    expect(logs).toEqual([])
  })

  test('read-only without a channel', async () => {
    await writeFile(file, JSON.stringify({ v: 1, sessions: [record(M1, { state: 'live', pid: 1 })] }))
    const store = createSessionStore({ file, writable: false, now: () => 5000, log: (l) => logs.push(l) })
    expect(store.list()).toEqual([record(M1, { state: 'live', pid: 1 })])
    const before = await readFile(file, 'utf8')
    await store.add(record(M2))
    await store.exited(M1, 0)
    await store.remove(M1)
    await reconcileSessions(store, { list: async () => [] })
    expect(await readFile(file, 'utf8')).toBe(before)
    // It serves what a server with a channel writes there.
    await writeFile(file, JSON.stringify({ v: 1, sessions: [record(M3, { startedAt: 2 })] }))
    expect(store.list()).toEqual([record(M3, { startedAt: 2 })])
    // With no file, none appears.
    await rm(file)
    const none = createSessionStore({ file, writable: false, now: () => 5000, log: () => {} })
    await none.add(record(M1))
    expect(existsSync(file)).toBe(false)
  })

  test('a failed write keeps the change and logs one line', async () => {
    await mkdir(file) // a folder where the file goes: the rename fails
    const store = writable()
    await store.add(record(M1))
    expect(store.list()).toEqual([record(M1)])
    expect(logs.filter((l) => l.includes('could not save'))).toHaveLength(1)
    expect((await readdir(root)).sort()).toEqual(['sessions.json'])
  })
})

describe('hosted sessions from hook files', () => {
  const row = (at: number, payload: Record<string, unknown>) => JSON.stringify({ v: 1, at, payload })
  const start = (at: number, session: string, source = 'startup') => row(at, { hook_event_name: 'SessionStart', session_id: session, source })

  test('hostedSession carries the hook state, never the prompt', async () => {
    const hooks = join(root, 'hooks')
    await mkdir(hooks)
    const reader = createHookReader(hooks)
    const live = record(M1, { state: 'live', pid: 1 })
    // No file yet: not hooked, the start id only.
    expect(hostedSession(live, await reader.read(M1))).toEqual({
      marker: M1,
      sessionId: S1,
      liveSession: S1,
      sessions: [S1],
      skill: 'plan',
      startedAt: 1000,
      state: 'live',
      hooked: false,
      prompted: false,
    })
    // SessionStart, a prompt, then /clear: the newest SessionStart is live, and every id is held once.
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await writeFile(
      join(hooks, `${M1}.jsonl`),
      [start(1, S1), row(2, { hook_event_name: 'UserPromptSubmit', session_id: S1, prompt: 'secret words' }), start(3, B, 'clear'), start(9000, S1, 'resume'), start(9500, B, 'resume')].join('\n') + '\n',
    )
    const h = hostedSession({ ...live, typeYourself: true }, await reader.read(M1))
    expect(h).toMatchObject({ liveSession: B, sessions: [S1, B], hooked: true, prompted: true, typeYourself: true })
    expect(JSON.stringify(h)).not.toContain('secret')
    // Ended and stopped carry their end.
    expect(hostedSession(record(M2, { state: 'ended', exitCode: 2, endedAt: 7 }), undefined)).toMatchObject({ state: 'ended', exitCode: 2, endedAt: 7 })
    expect(hostedSession(record(M2, { state: 'stopped', stopReason: 'app closed' }), undefined)).toMatchObject({ state: 'stopped', stopReason: 'app closed' })
  })

  test('the reader reads a file again only when its size or time changed', async () => {
    const hooks = join(root, 'hooks')
    await mkdir(hooks)
    const reads: string[] = []
    const reader = createHookReader(hooks, { readText: async (p) => (reads.push(p), readFile(p, 'utf8')) })
    const f = join(hooks, `${M1}.jsonl`)
    await writeFile(f, start(1, S1) + '\n')
    expect((await reader.read(M1))?.live?.session).toBe(S1)
    await reader.read(M1)
    expect(reads).toHaveLength(1)
    await writeFile(f, start(1, S1) + '\n' + row(2, { hook_event_name: 'UserPromptSubmit', session_id: S1, prompt: 'x' }) + '\n')
    expect((await reader.read(M1))?.events.map((e) => e.event)).toEqual(['SessionStart', 'UserPromptSubmit'])
    expect(reads).toHaveLength(2)
    // A deleted file reads as none.
    await rm(f)
    expect(await reader.read(M1)).toBeUndefined()
  })
})
