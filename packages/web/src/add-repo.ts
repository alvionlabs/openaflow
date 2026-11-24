// Adding a repo: the POST to /api/repos and the error word as a sentence. The
// Add repo flow (screens/runs/add-repo-flow.ts) drives them.

import { NEED_RELOAD, pageToken, RELOAD, RESTARTED, type ActionDeps } from './actions-client.ts'
import { noToken, staleToken } from './reload-flag.ts'

/** `openaflow`: the 201's field, set only when the server sent a boolean (false: the repo has no `.openaflow/`). */
export type AddResult = { status: number; error?: string; openaflow?: boolean }

export type PostRepoDeps = ActionDeps

/**
 * POST /api/repos with the page's session token, as the action client sends it. The
 * browser adds the `Origin` header the server's guard checks. No token on the page →
 * nothing is sent and the error asks for a reload; a token from before an API restart →
 * the same words the actions use.
 */
export async function postRepo(path: string, deps: PostRepoDeps = {}): Promise<AddResult> {
  const token = (deps.token ?? pageToken)()
  if (!token) {
    noToken(deps.flag)
    return { status: 0, error: NEED_RELOAD }
  }
  const res = await (deps.fetch ?? fetch)('/api/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token },
    body: JSON.stringify({ path }),
  })
  let error: unknown
  let openaflow: unknown
  try {
    const body = (await res.json()) as { error?: unknown; openaflow?: unknown } | null
    error = body?.error
    openaflow = body?.openaflow
  } catch {
    error = undefined
  }
  if (staleToken(res.status, error, deps.flag)) return { status: 403, error: RESTARTED }
  if (typeof error === 'string' && error.length > 0) return { status: res.status, error }
  return typeof openaflow === 'boolean' ? { status: res.status, openaflow } : { status: res.status }
}

// Short and warm, with no period at the end (DESIGN.md, "Forms and errors"). Remove repo and Forget use the last two too.
export const ADD_ALREADY = 'This repo is already here'
export const ADD_BAD_PATH = "That path doesn't look right"
export const TRY_AGAIN = 'Something went wrong. Please try again'
/** A stale or missing token: the failed action's short line (actions-client.ts). */
export { RELOAD }

/** What the modal says after a refused add. `pathError`: the same path would fail again, so Add waits for a change. */
export type AddError = { message: string; pathError: boolean }

const BAD_PATH = new Set(['not absolute', 'not a local path', 'not a directory'])

/**
 * Three messages, by what you can do next: change the path, reload, or try again. The exact cause goes to the
 * console, so a bug report can still name it.
 */
export function addError(r: AddResult): AddError {
  const word = r.error?.trim()
  if (word === 'already registered') return { message: ADD_ALREADY, pathError: true }
  if (word !== undefined && BAD_PATH.has(word)) return { message: ADD_BAD_PATH, pathError: true }
  if (word === RESTARTED || word === NEED_RELOAD) return { message: RELOAD, pathError: false }
  console.warn(`openaflow: add repo failed (HTTP ${r.status}${word ? `: ${word}` : ''})`)
  return { message: TRY_AGAIN, pathError: false }
}

// The setup step's lines (the server's words are in routes: `setup-workflow`). Same style as above.
export const SETUP_ALREADY = 'This repo already has a .openaflow file or folder'
export const SETUP_MISSING = "The app has no workflow to set up. Please reinstall it"
export const SETUP_BUSY = 'Setup is already running. Please wait'
export const SETUP_FAILED = 'Setup failed. Please try again'

/**
 * The line for a failed `setup-workflow` (the action client's message): the server's word, in plain words. A stale
 * token keeps the reload line; anything else reads as try again. The exact cause goes to the console.
 */
export function setupError(message: string): string {
  const word = message.trim()
  if (word === 'already set up') return SETUP_ALREADY
  if (word === 'workflow missing') return SETUP_MISSING
  if (word === 'setup in progress') return SETUP_BUSY
  if (word.startsWith('setup failed')) {
    console.warn(`openaflow: setup failed (${word})`)
    return SETUP_FAILED
  }
  if (word === RELOAD) return RELOAD
  console.warn(`openaflow: setup failed (${word})`)
  return TRY_AGAIN
}
