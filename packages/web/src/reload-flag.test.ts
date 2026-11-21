import { describe, expect, it, vi } from 'vitest'
import { postAction, savedScreen } from './actions-client.ts'
import { postRepo } from './add-repo.ts'
import { createReloadFlag, reloadFlag, staleToken, type ReloadFlag } from './reload-flag.ts'
import { readSettings, saveSettings } from './screens/settings/settings-client.ts'
import { createSetupGate, readTools } from './screens/setup/setup-client.ts'

const TOKEN = 'k'.repeat(43)
const MARKER = '0d6a8c1e-2b3f-4a5d-9e7f-1a2b3c4d5e6f'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fetchOf = (reply: () => Response | Promise<Response>) => vi.fn<typeof fetch>(async () => reply())

type Deps = { fetch: typeof fetch; token: () => string | null; flag: ReloadFlag }
/** Each request path that sends the page token, as one call with its deps. */
const CLIENTS: [string, (d: Deps) => Promise<unknown>][] = [
  ['postAction', (d) => postAction('merge', {}, d)],
  ['savedScreen', (d) => savedScreen(MARKER, d)],
  ['postRepo', (d) => postRepo('/repo', d)],
  ['readTools', (d) => readTools(d)],
  ['readSettings', (d) => readSettings(d)],
  ['saveSettings', (d) => saveSettings({ scrollback: 200 }, d)],
]

/** Runs `call` with a fresh flag and a fetch that answers `reply`; whether the flag is set after. */
async function flagged(call: (d: Deps) => Promise<unknown>, reply: () => Response | Promise<Response>, token: string | null = TOKEN): Promise<boolean> {
  const flag = createReloadFlag()
  // postRepo throws when the network is down; its flow catches that. Only the flag matters here.
  await call({ fetch: fetchOf(reply), token: () => token, flag }).catch(() => {})
  return flag.get()
}

describe('the reload flag', () => {
  it('starts off, sets once, and tells each listener only the first time', () => {
    const flag = createReloadFlag()
    const heard = vi.fn()
    const stop = flag.subscribe(heard)
    expect(flag.get()).toBe(false)
    flag.set()
    flag.set()
    flag.set()
    expect(flag.get()).toBe(true)
    expect(heard).toHaveBeenCalledOnce()
    stop()
    const late = vi.fn()
    flag.subscribe(late)
    flag.set()
    expect(late).not.toHaveBeenCalled()
  })

  it('a stale token is a 403 with the word "bad token" and nothing else', () => {
    const flag = createReloadFlag()
    expect(staleToken(403, 'forbidden origin', flag)).toBe(false)
    expect(staleToken(400, 'bad token', flag)).toBe(false)
    expect(staleToken(403, undefined, flag)).toBe(false)
    expect(flag.get()).toBe(false)
    expect(staleToken(403, 'bad token', flag)).toBe(true)
    expect(flag.get()).toBe(true)
  })

  for (const [name, call] of CLIENTS) {
    it(`${name}: a bad-token reply sets the flag`, async () => {
      expect(await flagged(call, () => json(403, { error: 'bad token' }))).toBe(true)
    })

    it(`${name}: no token on the page sets the flag, as only a reload gives one`, async () => {
      // savedScreen never shows an error; the other paths ask for a reload, so the banner must offer one.
      expect(await flagged(call, () => json(200, {}), null)).toBe(name !== 'savedScreen')
    })

    it(`${name}: other errors leave the flag off`, async () => {
      const others: [string, () => Response | Promise<Response>][] = [
        ['a 403 with another word', () => json(403, { error: 'forbidden origin' })],
        ['a 403 with no word', () => new Response('', { status: 403 })],
        ['a refused value', () => json(400, { error: 'bad request' })],
        ['an outage', () => json(500, { error: 'internal' })],
        ['the dev proxy with no API', () => new Response('', { status: 502 })],
        ['the network down', () => Promise.reject(new TypeError('Failed to fetch'))],
        ['a success', () => json(200, {})],
      ]
      for (const [why, reply] of others) expect(await flagged(call, reply), why).toBe(false)
    })
  }

  it('many requests that fail at once tell the banner once', async () => {
    const flag = createReloadFlag()
    const heard = vi.fn()
    flag.subscribe(heard)
    const d = { fetch: fetchOf(() => json(403, { error: 'bad token' })), token: () => TOKEN, flag }
    await Promise.all(CLIENTS.map(([, call]) => call(d)))
    expect(flag.get()).toBe(true)
    expect(heard).toHaveBeenCalledOnce()
  })

  it('the setup gate passes its flag to the tool-path save', async () => {
    const flag = createReloadFlag()
    const fetchFn = vi.fn<typeof fetch>(async () => json(200, { tools: [{ tool: 'git', state: 'found', path: '/usr/bin/git', source: 'path' }, { tool: 'gh', state: 'found', path: '/usr/bin/gh', source: 'path' }, { tool: 'claude', state: 'missing' }] }))
    const gate = createSetupGate({ fetch: fetchFn, token: () => TOKEN, flag })
    gate.start()
    await vi.waitFor(() => expect(gate.state().view).toBe('setup'))
    fetchFn.mockImplementation(async () => json(403, { error: 'bad token' }))
    await gate.save('claude', '/opt/claude')
    expect(flag.get()).toBe(true)
  })

  it('with no flag given, the page flag is set', async () => {
    expect(reloadFlag.get()).toBe(false)
    await postAction('merge', {}, { fetch: fetchOf(() => json(403, { error: 'bad token' })), token: () => TOKEN })
    expect(reloadFlag.get()).toBe(true)
  })
})
