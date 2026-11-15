import { describe, expect, it } from 'vitest'
import { postAction, resumeSession, savedScreen, type ActionDeps } from './actions-client.ts'

const TOKEN = 'k'.repeat(43)

type Call = { url: string; init: RequestInit }

/** A fetch that records each call and answers with `reply`. */
function fakeFetch(reply: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return reply()
  }) as typeof fetch
  return { calls, fn }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const deps = (fetchFn: typeof fetch, ...token: [string | null | undefined] | []): ActionDeps => ({
  fetch: fetchFn,
  token: () => (token.length === 0 ? TOKEN : token[0]),
})

describe('action client', () => {
  it('sends the token header', async () => {
    const f = fakeFetch(() => json(200, { number: 7 }))
    const reply = await postAction<{ number: number }>('merge-preview', { repoId: 'r1', number: 7 }, deps(f.fn))
    expect(reply).toEqual({ ok: true, data: { number: 7 } })
    expect(f.calls).toHaveLength(1)
    const { url, init } = f.calls[0]!
    expect(url).toBe('/api/actions/merge-preview')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('x-openaflow-token')).toBe(TOKEN)
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({ repoId: 'r1', number: 7 })
  })

  it('reads the token from the page on each call', async () => {
    let token = 'first'
    const f = fakeFetch(() => json(200, {}))
    await postAction('merge', {}, { fetch: f.fn, token: () => token })
    token = 'second'
    await postAction('merge', {}, { fetch: f.fn, token: () => token })
    expect(f.calls.map((c) => new Headers(c.init.headers).get('x-openaflow-token'))).toEqual(['first', 'second'])
  })

  it('reports each failure in words', async () => {
    // No token meta (or an empty one): no request, and the reload message.
    for (const token of [undefined, null, '']) {
      const f = fakeFetch(() => json(200, {}))
      expect(await postAction('merge', {}, deps(f.fn, token)), String(token)).toEqual({ ok: false, status: 0, message: 'Actions need a page reload.' })
      expect(f.calls).toEqual([])
    }

    // The server restarted with a new token.
    const restarted = fakeFetch(() => json(403, { error: 'bad token' }))
    expect(await postAction('merge', {}, deps(restarted.fn))).toEqual({ ok: false, status: 403, message: 'The board restarted. Reload the page.' })

    // The network failed.
    const down = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(await postAction('merge', {}, deps(down.fn))).toEqual({ ok: false, status: 0, message: "Can't reach the board." })

    // Any other error: the body's error word.
    const notWaiting = fakeFetch(() => json(404, { error: 'not waiting on you' }))
    expect(await postAction('merge', {}, deps(notWaiting.fn))).toEqual({ ok: false, status: 404, message: 'not waiting on you' })
    const origin = fakeFetch(() => json(403, { error: 'forbidden origin' }))
    expect(await postAction('merge', {}, deps(origin.fn))).toEqual({ ok: false, status: 403, message: 'forbidden origin' })

    // No error word, or a body that isn't JSON: the HTTP status.
    const bare = fakeFetch(() => new Response('', { status: 500 }))
    expect(await postAction('merge', {}, deps(bare.fn))).toEqual({ ok: false, status: 500, message: 'HTTP 500' })
    const html = fakeFetch(() => new Response('<h1>Bad Gateway</h1>', { status: 502 }))
    expect(await postAction('merge', {}, deps(html.fn))).toEqual({ ok: false, status: 502, message: 'HTTP 502' })
    const blank = fakeFetch(() => json(503, { error: '' }))
    expect(await postAction('merge', {}, deps(blank.fn))).toEqual({ ok: false, status: 503, message: 'HTTP 503' })
  })

  it('a 502 with an empty body means the board is down', async () => {
    // The Vite proxy answers 502 with no body when the API isn't running.
    const proxy = fakeFetch(() => new Response('', { status: 502 }))
    expect(await postAction('merge-preview', {}, deps(proxy.fn))).toEqual({ ok: false, status: 502, message: "Can't reach the board." })
    const spaces = fakeFetch(() => new Response('  \n', { status: 502 }))
    expect(await postAction('merge-preview', {}, deps(spaces.fn))).toEqual({ ok: false, status: 502, message: "Can't reach the board." })
    // A 502 from the API itself (gh failed) keeps its words.
    const gh = fakeFetch(() => json(502, { error: 'gh failed' }))
    expect(await postAction('merge-preview', {}, deps(gh.fn))).toEqual({ ok: false, status: 502, message: 'gh failed' })
    // Only 502: an empty 500 or 504 still reads its status.
    const other = fakeFetch(() => new Response('', { status: 504 }))
    expect(await postAction('merge-preview', {}, deps(other.fn))).toEqual({ ok: false, status: 504, message: 'HTTP 504' })
  })

  it('a success whose body is not JSON is an error, not data', async () => {
    const f = fakeFetch(() => new Response('<html></html>', { status: 200 }))
    expect(await postAction('merge', {}, deps(f.fn))).toEqual({ ok: false, status: 200, message: 'HTTP 200' })
  })
})

describe('session calls', () => {
  const MARKER = '7f3c9a12-0000-4000-8000-000000000001'
  const NEW = '0b1c2d3e-0000-4000-8000-000000000002'

  it('session calls', async () => {
    // resumeSession posts the route with the token, the repo, the marker, and the size, and reads the new marker.
    const ok = fakeFetch(() => json(200, { outcome: 'started', marker: NEW, logged: true }))
    expect(await resumeSession({ repoId: 'notes', marker: MARKER, cols: 100, rows: 30 }, deps(ok.fn))).toEqual({ ok: true, data: { outcome: 'started', marker: NEW, logged: true } })
    expect(ok.calls).toHaveLength(1)
    expect(ok.calls[0]!.url).toBe('/api/actions/resume-session')
    expect(ok.calls[0]!.init.method).toBe('POST')
    expect(new Headers(ok.calls[0]!.init.headers).get('x-openaflow-token')).toBe(TOKEN)
    expect(JSON.parse(String(ok.calls[0]!.init.body))).toEqual({ repoId: 'notes', marker: MARKER, cols: 100, rows: 30 })
    // No size: none is sent.
    const bare = fakeFetch(() => json(200, { outcome: 'started', marker: NEW, logged: false }))
    await resumeSession({ repoId: 'notes', marker: MARKER }, deps(bare.fn))
    expect(JSON.parse(String(bare.calls[0]!.init.body))).toEqual({ repoId: 'notes', marker: MARKER })
    // A refusal reads as any action's.
    const refused = fakeFetch(() => json(409, { error: "can't resume: no folder" }))
    expect(await resumeSession({ repoId: 'notes', marker: MARKER }, deps(refused.fn))).toEqual({ ok: false, status: 409, message: "can't resume: no folder" })

    // savedScreen: a GET with the token; the text on 200.
    const screen = fakeFetch(() => json(200, { text: 'line 1\nline 2' }))
    expect(await savedScreen(MARKER, deps(screen.fn))).toBe('line 1\nline 2')
    expect(screen.calls[0]!.url).toBe(`/api/sessions/${MARKER}/screen`)
    expect(screen.calls[0]!.init.method ?? 'GET').toBe('GET')
    expect(new Headers(screen.calls[0]!.init.headers).get('x-openaflow-token')).toBe(TOKEN)
    // An empty screen is still a screen.
    expect(await savedScreen(MARKER, deps(fakeFetch(() => json(200, { text: '' })).fn))).toBe('')
    // Nothing to show: 404 no screen, 403, a server with no such route, HTML, a body with no text, the network down.
    const none: (() => Response | Promise<Response>)[] = [
      () => json(404, { error: 'no screen' }),
      () => json(403, { error: 'bad token' }),
      () => json(404, { error: 'not found' }),
      () => new Response('<html></html>', { status: 200 }),
      () => json(200, { text: 3 }),
      () => json(200, null),
      () => Promise.reject(new TypeError('Failed to fetch')),
    ]
    for (const reply of none) expect(await savedScreen(MARKER, deps(fakeFetch(reply).fn))).toBeUndefined()
    // No token: no request.
    const noToken = fakeFetch(() => json(200, { text: 'x' }))
    expect(await savedScreen(MARKER, deps(noToken.fn, null))).toBeUndefined()
    expect(noToken.calls).toEqual([])
    // A marker that is not a UUID is never put in a path.
    const odd = fakeFetch(() => json(200, { text: 'x' }))
    expect(await savedScreen('../board', deps(odd.fn))).toBeUndefined()
    expect(odd.calls).toEqual([])
  })
})
