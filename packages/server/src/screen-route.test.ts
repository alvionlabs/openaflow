import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Board } from '@openaflow/model'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { createScreenRoutes } from './screen-route.ts'
import { createSessionStore, type StoredSession } from './session-store.ts'
import { createSessionToken } from './session-token.ts'

const PORT = 3080
const TOKEN = createSessionToken()
const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const M3 = '33333333-3333-4333-8333-333333333333'

let cfg: string
beforeEach(() => {
  cfg = realpathSync(mkdtempSync(join(tmpdir(), 'openaflow-screen-')))
})
afterEach(async () => {
  await rm(cfg, { recursive: true, force: true })
})

const rec = (marker: string): StoredSession => ({ marker, repoPath: '/repos/a', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', skill: 'plan', startedAt: 1, state: 'ended' })

async function setup(o: { screens?: boolean } = {}) {
  await writeFile(join(cfg, 'sessions.json'), JSON.stringify({ v: 1, sessions: [rec(M1), rec(M2)] }))
  // Read-only, as a server with no terminal channel (dev) has it: the route reads what the desktop's server wrote.
  const store = createSessionStore({ file: join(cfg, 'sessions.json'), writable: false, now: () => 1, log: () => {} })
  const board: Board = { generatedAt: 1, gh: 'unknown', repos: [], transcriptDays: 30 }
  const app = createApp({
    ports: [PORT],
    token: TOKEN,
    source: { board: () => board, subscribe: () => () => {}, rebuild: async () => {} },
    addRepo: async () => ({ error: 'not a directory' }),
    timeline: async () => undefined,
    ...(o.screens === false ? {} : { screens: createScreenRoutes({ store, configDir: cfg }) }),
  })
  return async (path: string, token: string | null = TOKEN) => {
    const res = await app.request(path, { headers: { host: `127.0.0.1:${PORT}`, ...(token === null ? {} : { 'x-openaflow-token': token }) } })
    return { status: res.status, body: (await res.json()) as unknown }
  }
}

describe('screen route', () => {
  test('saved screen', async () => {
    const get = await setup()
    await mkdir(join(cfg, 'screens'))
    await writeFile(join(cfg, 'screens', `${M1}.txt`), 'line one\nline two')
    // Not stored, but a file is there: still no screen.
    await writeFile(join(cfg, 'screens', `${M3}.txt`), 'not a session')
    await writeFile(join(cfg, 'secret.txt'), 'never read')

    expect(await get(`/api/sessions/${M1}/screen`)).toEqual({ status: 200, body: { text: 'line one\nline two' } })
    // A stored session with no file, a marker the store doesn't hold, and markers that aren't UUIDs.
    for (const marker of [M2, M3, 'abc', '%2E%2E%2Fsecret', `${M1}x`]) {
      expect(await get(`/api/sessions/${marker}/screen`)).toEqual({ status: 404, body: { error: 'no screen' } })
    }
    // A bare `..` leaves the route before it is matched.
    expect((await get('/api/sessions/../screen')).status).toBe(404)
    // A token first: no token or a wrong one is 403, also for a marker that has no screen.
    for (const marker of [M1, M3, 'abc']) {
      expect(await get(`/api/sessions/${marker}/screen`, null)).toEqual({ status: 403, body: { error: 'bad token' } })
      expect(await get(`/api/sessions/${marker}/screen`, 'wrong')).toEqual({ status: 403, body: { error: 'bad token' } })
    }
  })

  test('with no screen routes the path is not found', async () => {
    const get = await setup({ screens: false })
    expect(await get(`/api/sessions/${M1}/screen`)).toEqual({ status: 404, body: { error: 'not found' } })
  })
})
