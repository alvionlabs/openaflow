// The settings page's requests (settings §5): GET /api/settings and POST /api/actions/settings, each with the page's
// token. Every failure comes back as words, never as a throw; a failed load puts its exact cause in the console.

import type { SettingsChange, SettingsView } from '@openaflow/model'
import { NEED_RELOAD, pageToken, postAction, RESTARTED, UNREACHABLE, type ActionDeps, type ActionReply } from '../../actions-client.ts'
import { RELOAD } from '../../add-repo.ts'
import { parseSettingsView } from './settings-view.ts'

export const LOAD_FAILED = "Couldn't load settings. Please try again"
/** A 200 whose body isn't a SettingsView. */
export const SAVE_UNREADABLE = "Couldn't save. Please try again"
/**
 * The load's limit. Just after an app start the server waits for the scope probe's first answer, up to about 6 s,
 * before it answers; this stays well above that, so a slow first answer is never called a failure.
 */
export const LOAD_LIMIT_MS = 15_000
/** A save's limit, as setup-client.ts gives its POST: saves go one at a time, so one with no answer must not hold the rest. */
export const SAVE_LIMIT_MS = 15_000

/** `reload` marks a page whose token no longer fits the API (it restarted): only a page reload gets a new one. */
export type SettingsRead = { ok: true; view: SettingsView } | { ok: false; message: string; reload?: true }

const failed = (cause: string): SettingsRead => {
  console.warn(`openaflow: settings didn't load: ${cause}`)
  return { ok: false, message: LOAD_FAILED }
}

/** The page's token is stale or missing: a retry sends the same token, so the way out is a reload. */
const restarted = (cause: string): SettingsRead => {
  console.warn(`openaflow: settings didn't load: ${cause}`)
  return { ok: false, message: RELOAD, reload: true }
}

function badToken(text: string): boolean {
  try {
    return (JSON.parse(text) as { error?: unknown } | null)?.error === 'bad token'
  } catch {
    return false
  }
}

async function askSettings(fetchFn: typeof fetch, token: string, signal: AbortSignal): Promise<SettingsRead> {
  let res: Response
  let text: string
  try {
    res = await fetchFn('/api/settings', { method: 'GET', headers: { 'X-OpenAFlow-Token': token }, signal })
    text = await res.text()
  } catch (e) {
    return signal.aborted ? { ok: false, message: LOAD_FAILED } : failed(String(e))
  }
  if (res.status === 403 && badToken(text)) return restarted(`HTTP 403 ${text.slice(0, 200)}`)
  if (!res.ok) return failed(`HTTP ${res.status} ${text.slice(0, 200)}`)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return failed('the answer is not JSON')
  }
  const view = parseSettingsView(data)
  return view ? { ok: true, view } : failed('the answer is not a SettingsView')
}

/** GET /api/settings with the page token, within `limitMs`. */
export async function readSettings(deps: ActionDeps = {}, limitMs = LOAD_LIMIT_MS): Promise<SettingsRead> {
  const token = (deps.token ?? pageToken)()
  if (!token) return restarted('no page token')
  const fetchFn = deps.fetch ?? fetch
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<SettingsRead>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(failed(`no answer in ${limitMs / 1000} s`))
    }, limitMs)
  })
  try {
    return await Promise.race([askSettings(fetchFn, token, controller.signal), late])
  } finally {
    clearTimeout(timer)
  }
}

/** POST /api/actions/settings: only the keys sent change; `null` removes a key. */
export async function saveSettings(change: SettingsChange, deps: ActionDeps = {}, limitMs = SAVE_LIMIT_MS): Promise<ActionReply<SettingsView>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<ActionReply<unknown>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ ok: false, status: 0, message: UNREACHABLE })
    }, limitMs)
  })
  const fetchFn = deps.fetch ?? fetch
  const post = postAction<unknown>('settings', change, { ...deps, fetch: (url, init) => fetchFn(url, { ...init, signal: controller.signal }) })
  let reply: ActionReply<unknown>
  try {
    reply = await Promise.race([post, late])
  } finally {
    clearTimeout(timer)
  }
  if (!reply.ok) {
    // A restart (or no token) leaves the page's token stale: say what the other screens say. Never `invalid`: the status stays as it came.
    return reply.message === RESTARTED || reply.message === NEED_RELOAD ? { ...reply, message: RELOAD } : reply
  }
  const view = parseSettingsView(reply.data)
  return view ? { ok: true, data: view } : { ok: false, status: 200, message: SAVE_UNREADABLE }
}

/** Reset to default: both run wrapper keys removed. */
export const resetWrapper = (deps: ActionDeps = {}) => saveSettings({ runWrapper: null, stopCommand: null }, deps)
