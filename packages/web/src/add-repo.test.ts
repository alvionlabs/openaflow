import { describe, expect, it, vi } from 'vitest'
import { NEED_RELOAD, RESTARTED, UNREACHABLE } from './actions-client.ts'
import { ADD_ALREADY, ADD_BAD_PATH, SETUP_ALREADY, SETUP_BUSY, SETUP_FAILED, SETUP_MISSING, TRY_AGAIN, RELOAD, addError, postRepo, setupError } from './add-repo.ts'

describe('the message for a failed add', () => {
  it('a status with no error word is a failed add', () => {
    expect(addError({ status: 415 })).toEqual({ message: TRY_AGAIN, pathError: false })
  })

  it('reads short and warm, with no period at the end', () => {
    expect(ADD_ALREADY).toBe('This repo is already here')
    expect(ADD_BAD_PATH).toBe("That path doesn't look right")
    expect(TRY_AGAIN).toBe('Something went wrong. Please try again')
    expect(RELOAD).toBe('Reload, then try again')
    for (const m of [ADD_ALREADY, ADD_BAD_PATH, TRY_AGAIN, RELOAD]) expect(m, m).not.toMatch(/\.$/)
  })
})

describe('postRepo', () => {
  const token = () => 'tok-123'

  it('posts JSON with the session token and reads the status and error word', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'already registered' }), { status: 409 }))
    expect(await postRepo('/repo', { fetch: fetchFn, token })).toEqual({ status: 409, error: 'already registered' })
    expect(fetchFn).toHaveBeenCalledWith('/api/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenAFlow-Token': 'tok-123' },
      body: JSON.stringify({ path: '/repo' }),
    })
  })

  it('with no token on the page, sends nothing and asks for a reload', async () => {
    for (const none of [() => null, () => undefined, () => '']) {
      const fetchFn = vi.fn(async () => new Response('{}', { status: 201 }))
      expect(await postRepo('/repo', { fetch: fetchFn, token: none })).toEqual({ status: 0, error: NEED_RELOAD })
      expect(fetchFn).not.toHaveBeenCalled()
    }
  })

  it('a dead token after a restart says to reload', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'bad token' }), { status: 403 }))
    expect(await postRepo('/repo', { fetch: fetchFn, token })).toEqual({ status: 403, error: RESTARTED })
    expect(addError({ status: 403, error: RESTARTED })).toEqual({ message: RELOAD, pathError: false })
  })

  it('a body that is not JSON gives just the status', async () => {
    const fetchFn = vi.fn(async () => new Response('oops', { status: 502 }))
    expect(await postRepo('/repo', { fetch: fetchFn, token })).toEqual({ status: 502 })
    const ok = vi.fn(async () => new Response(JSON.stringify({ path: '/repo' }), { status: 201 }))
    expect(await postRepo('/repo', { fetch: ok, token })).toEqual({ status: 201 })
  })
})

describe('postRepo reads openaflow', () => {
  const token = () => 'tok-123'
  const answer = (body: unknown, status = 201) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

  it('openaflow field: a boolean is passed on; anything else is left out', async () => {
    expect(await postRepo('/r', { fetch: answer({ path: '/r', openaflow: false }), token })).toEqual({ status: 201, openaflow: false })
    expect(await postRepo('/r', { fetch: answer({ path: '/r', openaflow: true }), token })).toEqual({ status: 201, openaflow: true })
    for (const v of ['false', 0, null, 'yes']) {
      expect(await postRepo('/r', { fetch: answer({ path: '/r', openaflow: v }), token })).toEqual({ status: 201 })
    }
  })

  it('podDocs field: a boolean is passed on beside openaflow; anything else is left out', async () => {
    expect(await postRepo('/r', { fetch: answer({ path: '/r', openaflow: false, podDocs: false }), token })).toEqual({ status: 201, openaflow: false, podDocs: false })
    expect(await postRepo('/r', { fetch: answer({ path: '/r', openaflow: false, podDocs: true }), token })).toEqual({ status: 201, openaflow: false, podDocs: true })
    for (const v of ['false', 0, null]) {
      expect(await postRepo('/r', { fetch: answer({ path: '/r', openaflow: false, podDocs: v }), token })).toEqual({ status: 201, openaflow: false })
    }
  })

  it('a refusal keeps its error word and carries no openaflow', async () => {
    expect(await postRepo('/r', { fetch: answer({ error: 'already registered', openaflow: false }, 409), token })).toEqual({ status: 409, error: 'already registered' })
  })
})

describe('the setup messages', () => {
  it('read short and warm, with no period at the end', () => {
    expect(SETUP_ALREADY).toBe('This repo already has a .openaflow file or folder')
    for (const m of [SETUP_ALREADY, SETUP_MISSING, SETUP_BUSY, SETUP_FAILED]) expect(m, m).not.toMatch(/\.$/)
  })
  it('each server word maps to its line; the rest read as try again', () => {
    expect(setupError('already set up')).toBe(SETUP_ALREADY)
    expect(setupError('workflow missing')).toBe(SETUP_MISSING)
    expect(setupError('setup in progress')).toBe(SETUP_BUSY)
    expect(setupError('setup failed: EACCES')).toBe(SETUP_FAILED)
    expect(setupError(RELOAD)).toBe(RELOAD)
    expect(setupError('not a repo')).toBe(TRY_AGAIN)
    expect(setupError('HTTP 500')).toBe(TRY_AGAIN)
  })
})

describe('the three messages and the path rule', () => {
  it('a repo already on the board', () => {
    expect(addError({ status: 409, error: 'already registered' })).toEqual({ message: ADD_ALREADY, pathError: true })
  })
  it('a path that is not a folder on this computer', () => {
    for (const error of ['not absolute', 'not a local path', 'not a directory']) {
      expect(addError({ status: 400, error })).toEqual({ message: ADD_BAD_PATH, pathError: true })
    }
  })
  it('anything else: try again, or reload when the token is gone', () => {
    for (const r of [{ status: 0, error: UNREACHABLE }, { status: 500, error: 'config unreadable' }, { status: 403, error: 'forbidden origin' }, { status: 502 }]) {
      expect(addError(r)).toEqual({ message: TRY_AGAIN, pathError: false })
    }
    expect(addError({ status: 0, error: NEED_RELOAD })).toEqual({ message: RELOAD, pathError: false })
  })

  it('the exact cause goes to the console for a failed add, and only then', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    addError({ status: 500, error: 'config unreadable' })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/HTTP 500.*config unreadable/))
    addError({ status: 502 })
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('HTTP 502'))
    warn.mockClear()
    addError({ status: 409, error: 'already registered' })
    addError({ status: 400, error: 'not a directory' })
    addError({ status: 403, error: RESTARTED })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
