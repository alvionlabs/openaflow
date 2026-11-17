import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsView } from '@openaflow/model'
import { RESTARTED, UNREACHABLE } from '../../actions-client.ts'
import { LOAD_FAILED, LOAD_LIMIT_MS, readSettings, resetWrapper, SAVE_UNREADABLE, saveSettings } from './settings-client.ts'

const VIEW: SettingsView = {
  scrollback: 5000,
  wrapper: {
    runWrapper: 'systemd-run --user --scope --quiet --unit=openaflow-run-{runId}.scope',
    stopCommand: 'systemctl --user stop openaflow-run-{runId}.scope',
    isDefault: true,
    defaults: { runWrapper: 'systemd-run --user --scope --quiet --unit=openaflow-run-{runId}.scope', stopCommand: 'systemctl --user stop openaflow-run-{runId}.scope' },
    preview: 'systemd-run --user --scope --quiet "--unit=openaflow-run-<run id>.scope" claude --session-id "<session id>"',
  },
}
const token = () => 'tok-1'
const answer = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
const headerOf = (init: RequestInit | undefined) => (init?.headers as Record<string, string> | undefined)?.['X-OpenAFlow-Token']

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('settings client', () => {
  it('GET /api/settings sends the token and gives the view', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => answer(VIEW))
    await expect(readSettings({ fetch: fetchFn, token })).resolves.toEqual({ ok: true, view: VIEW })
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('/api/settings')
    expect(init?.method ?? 'GET').toBe('GET')
    expect(headerOf(init)).toBe('tok-1')
    // Windows: no wrapper at all.
    await expect(readSettings({ fetch: async () => answer({ scrollback: 200 }), token })).resolves.toEqual({ ok: true, view: { scrollback: 200 } })
  })

  it('a failed load reads "Couldn\'t load settings. Please try again", with the cause in the console', async () => {
    expect(LOAD_FAILED).toBe("Couldn't load settings. Please try again")
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failures: (() => Promise<Response>)[] = [
      async () => answer({ error: 'bad token' }, 403),
      async () => answer({ error: 'boom' }, 500),
      async () => answer('not json'),
      async () => answer({ scrollback: '5000' }),
      async () => answer({ scrollback: 5000, wrapper: { runWrapper: 1 } }),
      async () => answer(null),
      async () => {
        throw new TypeError('network')
      },
    ]
    for (const reply of failures) {
      await expect(readSettings({ fetch: reply, token })).resolves.toEqual({ ok: false, message: LOAD_FAILED })
    }
    expect(warn).toHaveBeenCalledTimes(failures.length)
    // No token on the page: nothing is sent.
    const fetchFn = vi.fn<typeof fetch>(async () => answer(VIEW))
    await expect(readSettings({ fetch: fetchFn, token: () => null })).resolves.toEqual({ ok: false, message: LOAD_FAILED })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('waits past the scope probe’s 6 s; only no answer by the limit is a failure', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(LOAD_LIMIT_MS).toBeGreaterThanOrEqual(10_000)
    const slow = readSettings({ fetch: () => new Promise((resolve) => setTimeout(() => resolve(answer(VIEW)), 6_500)), token })
    await vi.advanceTimersByTimeAsync(6_500)
    await expect(slow).resolves.toEqual({ ok: true, view: VIEW })

    let signal: AbortSignal | undefined
    const hung = readSettings({
      fetch: (_url, init) => {
        signal = init?.signal ?? undefined
        return new Promise(() => {})
      },
      token,
    })
    await vi.advanceTimersByTimeAsync(LOAD_LIMIT_MS)
    await expect(hung).resolves.toEqual({ ok: false, message: LOAD_FAILED })
    expect(signal?.aborted).toBe(true)
  })

  it('POST /api/actions/settings sends the token and the change, and gives the new view', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => answer({ ...VIEW, scrollback: 200 }))
    await expect(saveSettings({ scrollback: 200 }, { fetch: fetchFn, token })).resolves.toEqual({ ok: true, data: { ...VIEW, scrollback: 200 } })
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('/api/actions/settings')
    expect(init?.method).toBe('POST')
    expect(headerOf(init)).toBe('tok-1')
    expect(JSON.parse(String(init?.body))).toEqual({ scrollback: 200 })
  })

  it('Reset posts {runWrapper:null, stopCommand:null}', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => answer(VIEW))
    await expect(resetWrapper({ fetch: fetchFn, token })).resolves.toEqual({ ok: true, data: VIEW })
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('/api/actions/settings')
    expect(headerOf(init)).toBe('tok-1')
    expect(JSON.parse(String(init?.body))).toEqual({ runWrapper: null, stopCommand: null })
  })

  it('a refused save gives the server’s word and its status; an unreadable answer is a failure too', async () => {
    const said = (body: unknown, status: number) => saveSettings({ runWrapper: 'a "b' }, { fetch: async () => answer(body, status), token })
    await expect(said({ error: 'run wrapper: unclosed quote' }, 400)).resolves.toEqual({ ok: false, status: 400, message: 'run wrapper: unclosed quote' })
    await expect(said({ error: 'not saved' }, 500)).resolves.toEqual({ ok: false, status: 500, message: 'not saved' })
    await expect(said({ error: 'bad token' }, 403)).resolves.toEqual({ ok: false, status: 403, message: RESTARTED })
    await expect(said({ scrollback: 'x' }, 200)).resolves.toEqual({ ok: false, status: 200, message: SAVE_UNREADABLE })
    const down = saveSettings({ scrollback: 200 }, {
      fetch: async () => {
        throw new TypeError('network')
      },
      token,
    })
    await expect(down).resolves.toEqual({ ok: false, status: 0, message: UNREACHABLE })
  })
})
