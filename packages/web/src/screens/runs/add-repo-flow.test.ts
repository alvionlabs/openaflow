import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RESTARTED, UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import { ADD_ALREADY, ADD_BAD_PATH, CREATED_LINE, PODDOCS_WARNING, SETUP_ALREADY, SETUP_BUSY, SETUP_FAILED, SETUP_MISSING, TRY_AGAIN, RELOAD, type AddResult } from '../../add-repo.ts'
import { AddRepoAdded, AddRepoConfirm, AddRepoForm } from './AddRepoDialog.tsx'
import { ADDED_CLOSE_MS, BRIDGE_FAILED, canAdd, createAddRepoFlow, pathHint, type AddRepoState } from './add-repo-flow.ts'

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** A flow over fakes: `picks` and `posts` answer in order; each call takes the next one. */
function setup(opts: { bridge: boolean }) {
  const picks: ReturnType<typeof deferred<string | null>>[] = []
  const posts: ReturnType<typeof deferred<AddResult>>[] = []
  const pick = vi.fn(() => {
    const d = deferred<string | null>()
    picks.push(d)
    return d.promise
  })
  const post = vi.fn((_path: string) => {
    const d = deferred<AddResult>()
    posts.push(d)
    return d.promise
  })
  const setups: ReturnType<typeof deferred<ActionReply<{ outcome: string }>>>[] = []
  const setupRepo = vi.fn((_path: string) => {
    const d = deferred<ActionReply<{ outcome: string }>>()
    setups.push(d)
    return d.promise
  })
  const onClose = vi.fn()
  const seen: AddRepoState[] = []
  const flow = createAddRepoFlow({ ...(opts.bridge ? { pick } : {}), post, setupRepo, onClose }, (s) => seen.push(s))
  return { flow, pick, post, setupRepo, onClose, picks, posts, setups, seen }
}

const form = (s: AddRepoState) => {
  if (s.kind !== 'form') throw new Error(`expected the form, got ${s.kind}`)
  return s
}

describe('desktop: the form first', () => {
  it('opens the modal with an empty path and Browse…; no folder dialog until Browse…', async () => {
    const t = setup({ bridge: true })
    expect(t.flow.state()).toEqual({ kind: 'form', path: '', busy: false, canChoose: true })
    expect(canAdd(t.flow.state())).toBe(false)
    await tick()
    expect(t.pick).not.toHaveBeenCalled()
    t.flow.choose()
    expect(t.pick).toHaveBeenCalledTimes(1)
  })

  it('a typed path adds with no folder dialog', () => {
    const t = setup({ bridge: true })
    t.flow.type(' /home/me/repo ')
    void t.flow.add()
    expect(t.pick).not.toHaveBeenCalled()
    expect(t.post).toHaveBeenCalledWith('/home/me/repo')
  })

  it('a picked folder fills the field, posts nothing, turns Add on, and moves focus to Add', async () => {
    const t = setup({ bridge: true })
    t.flow.choose()
    t.picks[0]!.resolve('/home/me/chess-web')
    await tick()
    const s = form(t.flow.state())
    expect(s).toEqual({ kind: 'form', path: '/home/me/chess-web', busy: false, canChoose: true, focus: 'add' })
    expect(canAdd(s)).toBe(true)
    expect(t.post).not.toHaveBeenCalled()
    expect(t.onClose).not.toHaveBeenCalled()
  })

  it('a picked folder clears a path error, so Add turns on', async () => {
    const t = setup({ bridge: true })
    t.flow.type('/home/me/chess-web')
    void t.flow.add()
    t.posts[0]!.resolve({ status: 409, error: 'already registered' })
    await tick()
    expect(canAdd(t.flow.state())).toBe(false)
    t.flow.choose()
    t.picks[0]!.resolve('/home/me/ytb-feed')
    await tick()
    const s = form(t.flow.state())
    expect(s).toMatchObject({ path: '/home/me/ytb-feed', busy: false })
    expect(s.error).toBeUndefined()
    expect(s.pathError).toBeUndefined()
    expect(canAdd(s)).toBe(true)
    expect(t.post).toHaveBeenCalledTimes(1)
  })

  it('a picked folder clears a system error too', async () => {
    const t = setup({ bridge: true })
    t.flow.choose()
    t.picks[0]!.reject(new Error('dialog failed'))
    await tick()
    t.flow.choose()
    t.picks[1]!.resolve('/home/me/chess-web')
    await tick()
    expect(form(t.flow.state()).error).toBeUndefined()
  })

  for (const answer of [null, '']) {
    it(`a cancelled pick (${JSON.stringify(answer)}) changes nothing and gives focus back to Browse…`, async () => {
      const t = setup({ bridge: true })
      t.flow.type('/home/me/chess-web')
      void t.flow.add()
      t.posts[0]!.resolve({ status: 409, error: 'already registered' })
      await tick()
      const before = form(t.flow.state())
      t.flow.choose()
      t.picks[0]!.resolve(answer)
      await tick()
      expect(t.flow.state()).toEqual({ ...before, focus: 'browse' })
      expect(canAdd(t.flow.state())).toBe(false)
      expect(t.post).toHaveBeenCalledTimes(1)
      expect(t.onClose).not.toHaveBeenCalled()
    })
  }

  for (const word of ['forbidden', 'dialog failed']) {
    it(`a pick that fails (${word}) shows the type-the-path message in the box and keeps the path`, async () => {
      const t = setup({ bridge: true })
      t.flow.type('/home/me/chess-web')
      t.flow.choose()
      t.picks[0]!.reject(new Error(word))
      await tick()
      const s = form(t.flow.state())
      expect(BRIDGE_FAILED).toBe("The folder dialog didn't open. You can type the path")
      expect(s).toMatchObject({ path: '/home/me/chess-web', busy: false, error: BRIDGE_FAILED, focus: 'path' })
      expect(s.pathError).toBeUndefined()
      expect(canAdd(s)).toBe(true)
      expect(t.post).not.toHaveBeenCalled()
      expect(t.onClose).not.toHaveBeenCalled()
    })
  }

  it('while a pick is out the modal is busy: Add, Browse…, Cancel, and typing do nothing', async () => {
    const t = setup({ bridge: true })
    t.flow.type('/home/me/old')
    t.flow.choose()
    expect(form(t.flow.state()).busy).toBe(true)
    expect(canAdd(t.flow.state())).toBe(false)
    void t.flow.add()
    t.flow.choose()
    t.flow.cancel()
    t.flow.type('/x')
    expect(t.post).not.toHaveBeenCalled()
    expect(t.pick).toHaveBeenCalledTimes(1)
    expect(t.onClose).not.toHaveBeenCalled()
    expect(form(t.flow.state()).path).toBe('/home/me/old')
    t.picks[0]!.resolve('/home/me/new')
    await tick()
    expect(form(t.flow.state())).toMatchObject({ path: '/home/me/new', busy: false })
  })

  it('Add after a pick posts that path; 201 closes', async () => {
    const t = setup({ bridge: true })
    t.flow.choose()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    const added = t.flow.add()
    expect(t.post).toHaveBeenCalledTimes(1)
    expect(t.post).toHaveBeenCalledWith('E:\\code\\chess-web')
    expect(form(t.flow.state()).busy).toBe(true)
    t.posts[0]!.resolve({ status: 201 })
    await added
    expect(t.onClose).toHaveBeenCalledTimes(1)
    expect(t.flow.state().kind).toBe('closed')
  })

  it('Add after a pick, refused as already added: the inline path error, the path kept, Add off', async () => {
    const t = setup({ bridge: true })
    t.flow.choose()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    const added = t.flow.add()
    t.posts[0]!.resolve({ status: 409, error: 'already registered' })
    await added
    const s = form(t.flow.state())
    // Add was off while busy, so focus goes back to the field to fix the path.
    expect(s).toMatchObject({ path: 'E:\\code\\chess-web', busy: false, error: ADD_ALREADY, pathError: true, canChoose: true, focus: 'path' })
    expect(canAdd(s)).toBe(false)
    expect(t.onClose).not.toHaveBeenCalled()
  })

  it('Add after a pick that throws (board out of reach): the box says try again, Add on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup({ bridge: true })
    t.flow.choose()
    t.picks[0]!.resolve('E:\\code\\chess-web')
    await tick()
    const added = t.flow.add()
    t.posts[0]!.reject(new TypeError('Failed to fetch'))
    await added
    const s = form(t.flow.state())
    expect(s).toMatchObject({ path: 'E:\\code\\chess-web', error: TRY_AGAIN, busy: false, focus: 'path' })
    expect(s.pathError).toBeUndefined()
    expect(canAdd(s)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(UNREACHABLE))
    warn.mockRestore()
  })

  it('after close, nothing more happens', async () => {
    const t = setup({ bridge: true })
    t.flow.cancel()
    t.flow.type('x')
    void t.flow.add()
    t.flow.choose()
    t.flow.cancel()
    expect(t.post).not.toHaveBeenCalled()
    expect(t.pick).not.toHaveBeenCalled()
    expect(t.onClose).toHaveBeenCalledTimes(1)
    expect(t.flow.state().kind).toBe('closed')
  })
})

describe('browser path field', () => {
  it('opens the empty field at once, with no Browse…; choose does nothing', () => {
    const t = setup({ bridge: false })
    const s = form(t.flow.state())
    expect(s).toEqual({ kind: 'form', path: '', busy: false, canChoose: false })
    t.flow.choose()
    expect(t.flow.state()).toEqual(s)
  })

  it('blank keeps Add off and posts nothing', () => {
    const t = setup({ bridge: false })
    expect(canAdd(t.flow.state())).toBe(false)
    t.flow.type('   ')
    expect(canAdd(t.flow.state())).toBe(false)
    void t.flow.add()
    expect(t.post).not.toHaveBeenCalled()
    t.flow.type('/home/me/repo')
    expect(canAdd(t.flow.state())).toBe(true)
  })

  it('the path is trimmed', () => {
    const t = setup({ bridge: false })
    t.flow.type('  /home/me/repo\t')
    void t.flow.add()
    expect(t.post).toHaveBeenCalledWith('/home/me/repo')
    expect(form(t.flow.state()).path).toBe('  /home/me/repo\t')
  })

  it('a second Add while posting sends nothing, and the modal is busy', async () => {
    const t = setup({ bridge: false })
    t.flow.type('/home/me/repo')
    void t.flow.add()
    expect(form(t.flow.state()).busy).toBe(true)
    expect(canAdd(t.flow.state())).toBe(false)
    void t.flow.add()
    t.flow.cancel()
    expect(t.post).toHaveBeenCalledTimes(1)
    expect(t.onClose).not.toHaveBeenCalled()
    t.posts[0]!.resolve({ status: 400, error: 'not a directory' })
    await tick()
    expect(form(t.flow.state())).toMatchObject({ busy: false, error: ADD_BAD_PATH })
    // Typing clears the error; Add then sends again.
    t.flow.type('/home/me/repo2')
    expect(form(t.flow.state()).error).toBeUndefined()
    void t.flow.add()
    expect(t.post).toHaveBeenCalledTimes(2)
  })

  it('an error turns Add off; a change to the path turns it on again', async () => {
    const t = setup({ bridge: false })
    t.flow.type('/home/me/repo')
    void t.flow.add()
    t.posts[0]!.resolve({ status: 409, error: 'already registered' })
    await tick()
    const s = form(t.flow.state())
    expect(s).toMatchObject({ path: '/home/me/repo', busy: false, error: ADD_ALREADY })
    expect(canAdd(s)).toBe(false)
    // Enter (add) does nothing while the error shows.
    void t.flow.add()
    expect(t.post).toHaveBeenCalledTimes(1)
    expect(form(t.flow.state()).busy).toBe(false)
    // A change to the path clears the error and turns Add on.
    t.flow.type('/home/me/repo2')
    expect(form(t.flow.state()).error).toBeUndefined()
    expect(canAdd(t.flow.state())).toBe(true)
    // A change to a blank path clears the error, but Add stays off.
    t.flow.type('  ')
    expect(form(t.flow.state()).error).toBeUndefined()
    expect(canAdd(t.flow.state())).toBe(false)
  })

  it('canAdd: an idle form with a path and no error', () => {
    const base = { kind: 'form', path: '/a', busy: false, canChoose: false } as const
    expect(canAdd(base)).toBe(true)
    expect(canAdd({ ...base, error: ADD_ALREADY, pathError: true })).toBe(false)
    // An error that isn't about the path keeps Add on, so the same path can be tried again.
    expect(canAdd({ ...base, error: TRY_AGAIN })).toBe(true)
    expect(canAdd({ ...base, error: '' })).toBe(true)
    expect(canAdd({ ...base, busy: true })).toBe(false)
    expect(canAdd({ kind: 'closed' })).toBe(false)
  })

  it('Cancel closes; 201 closes', async () => {
    const a = setup({ bridge: false })
    a.flow.cancel()
    expect(a.onClose).toHaveBeenCalledTimes(1)
    expect(a.flow.state().kind).toBe('closed')

    const b = setup({ bridge: false })
    b.flow.type('/home/me/repo')
    void b.flow.add()
    b.posts[0]!.resolve({ status: 201 })
    await tick()
    expect(b.onClose).toHaveBeenCalledTimes(1)
  })

  it('every change reaches onChange', () => {
    const t = setup({ bridge: false })
    t.flow.type('/a')
    expect(t.seen.at(-1)).toEqual(t.flow.state())
  })
})

describe('the path hint', () => {
  it('shows a path in the form of the user\'s own system', () => {
    expect(pathHint('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('C:\\code\\my-repo')
    expect(pathHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe('/Users/you/code/my-repo')
    expect(pathHint('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('/home/you/code/my-repo')
    expect(pathHint('')).toBe('/home/you/code/my-repo')
  })
})

describe('the Add repo modal', () => {
  type Form = Extract<AddRepoState, { kind: 'form' }>
  const render = (state: Form) => {
    const { flow } = setup({ bridge: state.canChoose })
    return renderToStaticMarkup(createElement(AddRepoForm, { state, flow }))
  }
  const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ label: m[2]!, attrs: m[1]! }))

  /** The markup between the first `<div class="add-repo-row">` and its closing tag (it holds no nested div). */
  const row = (html: string) => /<div class="add-repo-row">([\s\S]*?)<\/div>/.exec(html)?.[1]

  it('path error: the label, a row with the field and Browse…, the inline error, then Cancel and Add', () => {
    const html = render({ kind: 'form', path: 'E:\\code\\chess-web', busy: false, canChoose: true, error: ADD_ALREADY, pathError: true })
    const order = ['<label', 'class="add-repo-row"', '<input', 'Browse…</button>', 'class="modal-field-error"', '>Cancel<', '>Add<']
    const at = order.map((s) => html.indexOf(s))
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // The field and Browse… share one row; Browse… is a regular button with the 16 px folder icon, not in the actions.
    const inRow = row(html)!
    expect(inRow).toMatch(/^<input[^>]*>/)
    expect(inRow).toMatch(/<button class="btn lead" type="button"><svg[^>]*width="16"[^>]*>[\s\S]*?<\/svg>Browse…<\/button>$/)
    const actions = html.slice(html.indexOf('class="modal-actions"'))
    expect(buttons(actions).map((b) => b.label)).toEqual(['Cancel', 'Add'])
    // The path error is inline under the row: no alert box. The field names it and is invalid; Add is off.
    expect(html).not.toContain('modal-alert')
    const inline = /<p id="([^"]+)" class="modal-field-error" role="alert"><svg[^>]*>[\s\S]*?<\/svg><span>([^<]*)<\/span><\/p>/.exec(html)
    expect(inline, html).not.toBeNull()
    expect(inline![2]).toBe(ADD_ALREADY)
    expect(html).toMatch(new RegExp(`<input[^>]*aria-describedby="${inline![1]}"`))
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/)
    // The label, the row, and the inline error are one group, so the panel's gaps fall between groups.
    expect(html).toMatch(/<div class="add-repo-field"><label[\s\S]*?<\/label><div class="add-repo-row">[\s\S]*?<\/div><p id="[^"]+" class="modal-field-error"[\s\S]*?<\/p><\/div>/)
    expect(buttons(html).find((b) => b.label === 'Add')!.attrs).toMatch(/disabled=""/)
  })

  it('the second path error shows inline too', () => {
    const html = render({ kind: 'form', path: '/nope', busy: false, canChoose: false, error: ADD_BAD_PATH, pathError: true })
    expect(html).toContain(`<span>${ADD_BAD_PATH.replace("'", '&#x27;')}</span>`)
    expect(html).not.toContain('modal-alert')
  })

  for (const message of [TRY_AGAIN, RELOAD, BRIDGE_FAILED]) {
    it(`system error "${message}": the alert box above the actions, no inline error, the field not invalid, Add on`, () => {
      const html = render({ kind: 'form', path: '/home/me/repo', busy: false, canChoose: true, error: message })
      expect(html).not.toContain('modal-field-error')
      expect(html).not.toContain('aria-invalid')
      const errorId = /<div id="([^"]+)" class="modal-alert" role="alert">/.exec(html)?.[1]
      expect(errorId, html).toBeDefined()
      expect(html).toMatch(new RegExp(`<input[^>]*aria-describedby="${errorId}"`))
      // React escapes the apostrophe.
      expect(html).toContain(`>${message.replace("'", '&#x27;')}</p>`)
      // The box sits after the field group and before the actions.
      const at = ['class="add-repo-field"', '</div></div><div id=', 'class="modal-alert"', 'class="modal-actions"'].map((s) => html.indexOf(s))
      expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true)
      expect([...at].sort((a, b) => a - b)).toEqual(at)
      expect(buttons(html).find((b) => b.label === 'Add')!.attrs).not.toMatch(/disabled/)
    })
  }

  it('without the bridge: no Browse…, the field alone fills its row, no error, and Add on for a path', () => {
    const html = render({ kind: 'form', path: '/home/me/repo', busy: false, canChoose: false })
    expect(html).not.toContain('Browse')
    expect(row(html)).toMatch(/^<input[^>]*\/>$/)
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('aria-describedby')
    expect(buttons(html).map((b) => b.label)).toEqual(['Cancel', 'Add'])
    expect(buttons(html).find((b) => b.label === 'Add')!.attrs).not.toMatch(/disabled/)
  })

  it('Browse… is off while the modal is busy', () => {
    const html = render({ kind: 'form', path: '/home/me/repo', busy: true, canChoose: true })
    expect(row(html)).toMatch(/<button class="btn lead" type="button" disabled="">/)
  })
})

describe('an error that is not about the path', () => {
  it('keeps Add on, so you can try the same path again', async () => {
    const t = setup({ bridge: false })
    t.flow.type('/home/me/repo')
    const added = t.flow.add()
    t.posts[0]!.resolve({ status: 500, error: 'config unreadable' })
    await added
    expect(form(t.flow.state())).toMatchObject({ path: '/home/me/repo', error: TRY_AGAIN })
    expect(canAdd(t.flow.state())).toBe(true)
    // Add again with the same path: it posts, and a 201 closes the modal.
    const again = t.flow.add()
    expect(t.post).toHaveBeenCalledTimes(2)
    expect(t.post).toHaveBeenLastCalledWith('/home/me/repo')
    t.posts[1]!.resolve({ status: 201 })
    await again
    expect(t.onClose).toHaveBeenCalledTimes(1)
  })

  it('a reload message keeps Add on too', async () => {
    const t = setup({ bridge: false })
    t.flow.type('/home/me/repo')
    const added = t.flow.add()
    t.posts[0]!.resolve({ status: 403, error: RESTARTED })
    await added
    expect(form(t.flow.state())).toMatchObject({ error: RELOAD })
    expect(canAdd(t.flow.state())).toBe(true)
  })
})

describe('the setup confirm after Add', () => {
  /** A flow that has added `/home/me/repo` and got `reply`. */
  async function added(reply: AddResult) {
    const t = setup({ bridge: false })
    t.flow.type(' /home/me/repo ')
    const p = t.flow.add()
    t.posts[0]!.resolve(reply)
    await p
    return t
  }
  const confirm = (s: AddRepoState) => {
    if (s.kind !== 'confirm') throw new Error(`expected the confirm step, got ${s.kind}`)
    return s
  }

  it('asks after add: a 201 with openaflow false moves to the confirm step and does not close', async () => {
    const t = await added({ status: 201, openaflow: false, podDocs: true })
    expect(t.flow.state()).toEqual({ kind: 'confirm', path: '/home/me/repo', busy: false, warn: true })
    expect(t.onClose).not.toHaveBeenCalled()
    expect(t.setupRepo).not.toHaveBeenCalled()
  })

  it('create sets up: Create posts setup-workflow with the added path, and a 200 closes', async () => {
    const t = await added({ status: 201, openaflow: false, podDocs: true })
    const done = t.flow.create()
    expect(t.setupRepo).toHaveBeenCalledTimes(1)
    expect(t.setupRepo).toHaveBeenCalledWith('/home/me/repo')
    expect(confirm(t.flow.state()).busy).toBe(true)
    t.setups[0]!.resolve({ ok: true, data: { outcome: 'created' } })
    await done
    expect(t.flow.state()).toEqual({ kind: 'closed' })
    expect(t.onClose).toHaveBeenCalledTimes(1)
  })

  it('create is one post at a time, and Not now waits while it runs', async () => {
    const t = await added({ status: 201, openaflow: false, podDocs: true })
    const done = t.flow.create()
    void t.flow.create()
    t.flow.notNow()
    expect(t.setupRepo).toHaveBeenCalledTimes(1)
    expect(t.onClose).not.toHaveBeenCalled()
    t.setups[0]!.resolve({ ok: true, data: { outcome: 'created' } })
    await done
    expect(t.onClose).toHaveBeenCalledTimes(1)
  })

  it('not now writes nothing: it closes and posts no setup', async () => {
    const t = await added({ status: 201, openaflow: false, podDocs: true })
    t.flow.notNow()
    expect(t.flow.state()).toEqual({ kind: 'closed' })
    expect(t.onClose).toHaveBeenCalledTimes(1)
    expect(t.setupRepo).not.toHaveBeenCalled()
    expect(t.post).toHaveBeenCalledTimes(1)
  })

  it('cancel (Escape) at the confirm step is Not now', async () => {
    const t = await added({ status: 201, openaflow: false, podDocs: true })
    t.flow.cancel()
    expect(t.onClose).toHaveBeenCalledTimes(1)
    expect(t.setupRepo).not.toHaveBeenCalled()
  })

  const failures: [string, ActionReply<{ outcome: string }>, string][] = [
    ['already set up', { ok: false, status: 409, message: 'already set up' }, SETUP_ALREADY],
    ['workflow missing', { ok: false, status: 409, message: 'workflow missing' }, SETUP_MISSING],
    ['setup in progress', { ok: false, status: 409, message: 'setup in progress' }, SETUP_BUSY],
    ['setup failed: EACCES', { ok: false, status: 500, message: 'setup failed: EACCES' }, SETUP_FAILED],
    ['not a repo', { ok: false, status: 404, message: 'not a repo' }, TRY_AGAIN],
    ['a stale token', { ok: false, status: 403, message: RELOAD }, RELOAD],
    ['no connection', { ok: false, status: 0, message: UNREACHABLE }, TRY_AGAIN],
  ]
  for (const [name, reply, words] of failures) {
    it(`setup failure (${name}): the words show, the confirm step stays, and Create works again`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = await added({ status: 201, openaflow: false, podDocs: true })
      const first = t.flow.create()
      t.setups[0]!.resolve(reply)
      await first
      expect(t.flow.state()).toEqual({ kind: 'confirm', path: '/home/me/repo', busy: false, warn: true, error: words })
      expect(t.onClose).not.toHaveBeenCalled()
      const again = t.flow.create()
      expect(t.setupRepo).toHaveBeenCalledTimes(2)
      t.setups[1]!.resolve({ ok: true, data: { outcome: 'created' } })
      await again
      expect(t.onClose).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })
  }

  it('setup failure: a post that throws reads as a failed setup, and the exact cause goes to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await added({ status: 201, openaflow: false, podDocs: true })
    const p = t.flow.create()
    t.setups[0]!.reject(new Error('boom'))
    await p
    expect(t.flow.state()).toMatchObject({ kind: 'confirm', busy: false, error: TRY_AGAIN })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  for (const [name, reply] of [['true', { status: 201, openaflow: true }], ['no field', { status: 201 }]] as const) {
    it(`already set up closes: a 201 with openaflow ${name} closes as before, with no setup`, async () => {
      const t = await added(reply)
      expect(t.flow.state()).toEqual({ kind: 'closed' })
      expect(t.onClose).toHaveBeenCalledTimes(1)
      expect(t.setupRepo).not.toHaveBeenCalled()
    })
  }

  it('a refused add (409) never reaches the confirm step', async () => {
    const t = await added({ status: 409, error: 'already registered', openaflow: false })
    expect(t.flow.state().kind).toBe('form')
  })

  it('cancel (Escape) while Create runs does nothing, and the answer still lands', async () => {
    const t = await added({ status: 201, openaflow: false, podDocs: true })
    const p = t.flow.create()
    t.flow.cancel()
    expect(t.flow.state()).toEqual({ kind: 'confirm', path: '/home/me/repo', busy: true, warn: true })
    expect(t.onClose).not.toHaveBeenCalled()
    t.setups[0]!.resolve({ ok: false, status: 500, message: 'setup failed: EIO' })
    await p
    expect(t.flow.state()).toMatchObject({ kind: 'confirm', busy: false, error: SETUP_FAILED })
  })

  it('create and not now do nothing outside the confirm step', () => {
    const t = setup({ bridge: false })
    void t.flow.create()
    t.flow.notNow()
    expect(t.setupRepo).not.toHaveBeenCalled()
    expect(t.onClose).not.toHaveBeenCalled()
  })

  describe('the markup', () => {
    type Confirm = Extract<AddRepoState, { kind: 'confirm' }>
    const render = (state: Confirm) => renderToStaticMarkup(createElement(AddRepoConfirm, { state, flow: setup({ bridge: false }).flow }))
    const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ label: m[2]!, attrs: m[1]! }))

    it('the question, the facts under an open Details, then Not now and Create', () => {
      const html = render({ kind: 'confirm', path: '/home/me/repo', busy: false, warn: true })
      expect(html).toMatch(/<h2[^>]*>Create <span class="mono">\.openaflow\/<\/span> in this repo\?<\/h2>/)
      expect(html).toMatch(/<details class="modal-details" open="">/)
      expect(html).toMatch(/<dt>Folder<\/dt><dd>\/home\/me\/repo<\/dd><dt>Creates<\/dt><dd>\.openaflow\/workflows\/claude-pod\/<\/dd>/)
      expect(buttons(html.slice(html.indexOf('class="modal-actions"'))).map((b) => b.label)).toEqual(['Not now', 'Create'])
      expect(html).not.toContain('modal-alert')
    })

    it('busy turns both buttons off; an error shows in the alert box above the actions', () => {
      const busy = render({ kind: 'confirm', path: '/r', busy: true })
      expect(buttons(busy).every((b) => /disabled=""/.test(b.attrs))).toBe(true)
      const html = render({ kind: 'confirm', path: '/r', busy: false, error: SETUP_FAILED })
      expect(html.indexOf('modal-alert')).toBeGreaterThan(0)
      expect(html.indexOf('modal-alert')).toBeLessThan(html.indexOf('class="modal-actions"'))
      expect(html).toContain(SETUP_FAILED)
      expect(buttons(html).find((b) => b.label === 'Create')!.attrs).not.toMatch(/disabled/)
    })
  })
})

describe('Add repo on a repo with no .openaflow/ and no pod-docs/', () => {
  /** A flow that has posted `/home/me/repo` and got a 201 with `openaflow: false, podDocs: false`. Needs fake timers. */
  async function addedPlain() {
    const t = setup({ bridge: false })
    t.flow.type('/home/me/repo')
    // Add's promise waits for setup too, so the test lets the answer land instead of awaiting it.
    void t.flow.add()
    t.posts[0]!.resolve({ status: 201, openaflow: false, podDocs: false })
    await vi.advanceTimersByTimeAsync(0)
    return t
  }
  type Added = Extract<AddRepoState, { kind: 'added' }>
  const renderAdded = (state: Added) => renderToStaticMarkup(createElement(AddRepoAdded, { state, flow: setup({ bridge: false }).flow }))

  it('sets up with no question: setup is posted at once, no confirm step, and success closes with the created line', async () => {
    vi.useFakeTimers()
    try {
      const t = await addedPlain()
      expect(t.setupRepo).toHaveBeenCalledTimes(1)
      expect(t.setupRepo).toHaveBeenCalledWith('/home/me/repo')
      // The modal stays busy while setup runs: nothing to press, nothing to cancel.
      expect(t.flow.state()).toMatchObject({ kind: 'form', busy: true })
      t.flow.cancel()
      void t.flow.add()
      expect(t.post).toHaveBeenCalledTimes(1)
      t.setups[0]!.resolve({ ok: true, data: { outcome: 'created' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(t.seen.some((s) => s.kind === 'confirm')).toBe(false)
      const shown = t.flow.state()
      expect(shown).toEqual({ kind: 'added', path: '/home/me/repo' })
      const html = renderAdded(shown as Added)
      expect(html.replace(/<[^>]+>/g, '')).toContain(CREATED_LINE)
      expect(html).toMatch(/role="status"/)
      expect(html).not.toContain('modal-alert')
      expect(CREATED_LINE).toBe('Created .openaflow/workflows/claude-pod/')
      expect(t.onClose).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(ADDED_CLOSE_MS - 1)
      expect(t.onClose).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(t.flow.state()).toEqual({ kind: 'closed' })
      expect(t.onClose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sets up with no question: Close or Escape closes the created line at once, and the timer then does nothing', async () => {
    vi.useFakeTimers()
    try {
      const t = await addedPlain()
      t.setups[0]!.resolve({ ok: true, data: { outcome: 'created' } })
      await vi.advanceTimersByTimeAsync(0)
      t.flow.cancel()
      expect(t.onClose).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(ADDED_CLOSE_MS)
      expect(t.onClose).toHaveBeenCalledTimes(1)
      expect(t.seen.filter((s) => s.kind === 'closed')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  const failures: [string, ActionReply<{ outcome: string }> | 'throws', string][] = [
    ['already set up', { ok: false, status: 409, message: 'already set up' }, SETUP_ALREADY],
    ['workflow missing', { ok: false, status: 409, message: 'workflow missing' }, SETUP_MISSING],
    ['setup in progress', { ok: false, status: 409, message: 'setup in progress' }, SETUP_BUSY],
    ['setup failed: EACCES', { ok: false, status: 500, message: 'setup failed: EACCES' }, SETUP_FAILED],
    ['a stale token', { ok: false, status: 403, message: RELOAD }, RELOAD],
    ['no connection', { ok: false, status: 0, message: UNREACHABLE }, TRY_AGAIN],
    ['a post that throws', 'throws', TRY_AGAIN],
  ]
  for (const [name, reply, words] of failures) {
    it(`silent setup failure (${name}): the repo stays added, the words show, and the modal waits for Close`, async () => {
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const t = await addedPlain()
        if (reply === 'throws') t.setups[0]!.reject(new Error('boom'))
        else t.setups[0]!.resolve(reply)
        await vi.advanceTimersByTimeAsync(0)
        expect(t.flow.state()).toEqual({ kind: 'added', path: '/home/me/repo', error: words })
        // The repo was added (201): nothing removes it, and no second add or setup is sent.
        expect(t.post).toHaveBeenCalledTimes(1)
        expect(t.setupRepo).toHaveBeenCalledTimes(1)
        const html = renderAdded(t.flow.state() as Added)
        expect(html).toContain('modal-alert')
        expect(html).toContain(words.replace(/'/g, '&#x27;'))
        expect(html.replace(/<[^>]+>/g, '')).not.toContain(CREATED_LINE)
        // A failure never closes by itself: the words stay until you close.
        await vi.advanceTimersByTimeAsync(ADDED_CLOSE_MS * 2)
        expect(t.onClose).not.toHaveBeenCalled()
        t.flow.cancel()
        expect(t.onClose).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
        vi.useRealTimers()
      }
    })
  }

  it('the added step: the heading, the line, then one Close button', () => {
    const html = renderAdded({ kind: 'added', path: '/home/me/repo' })
    expect(html).toMatch(/<h2[^>]*>Repo added<\/h2>/)
    const labels = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
    expect(labels).toEqual(['Close'])
  })
})

describe('Add repo on a repo with pod-docs/', () => {
  async function added(reply: AddResult) {
    const t = setup({ bridge: false })
    t.flow.type('/home/me/repo')
    const p = t.flow.add()
    t.posts[0]!.resolve(reply)
    await p
    return t
  }
  type Confirm = Extract<AddRepoState, { kind: 'confirm' }>
  const render = (state: Confirm) => renderToStaticMarkup(createElement(AddRepoConfirm, { state, flow: setup({ bridge: false }).flow }))

  it('asks with a warning for pod-docs: the confirm step with the warning line; Not now writes nothing', async () => {
    const t = await added({ status: 201, openaflow: false, podDocs: true })
    expect(t.flow.state()).toEqual({ kind: 'confirm', path: '/home/me/repo', busy: false, warn: true })
    expect(t.setupRepo).not.toHaveBeenCalled()
    const html = render(t.flow.state() as Confirm)
    const warning = html.indexOf(PODDOCS_WARNING)
    expect(warning).toBeGreaterThan(html.indexOf('</details>'))
    expect(warning).toBeLessThan(html.indexOf('class="modal-actions"'))
    expect(html).toMatch(/<p class="modal-note">Its pod-docs\/ runs will no longer show on the board\.<\/p>/)
    t.flow.notNow()
    expect(t.onClose).toHaveBeenCalledTimes(1)
    expect(t.setupRepo).not.toHaveBeenCalled()
  })

  it('asks with a warning for pod-docs: an answer with no podDocs field asks too (safe side), with the warning', async () => {
    const t = await added({ status: 201, openaflow: false })
    expect(t.flow.state()).toEqual({ kind: 'confirm', path: '/home/me/repo', busy: false, warn: true })
    expect(t.setupRepo).not.toHaveBeenCalled()
  })

  it('asks with a warning for pod-docs: a confirm with no warn flag draws no warning line', () => {
    expect(render({ kind: 'confirm', path: '/r', busy: false })).not.toContain(PODDOCS_WARNING)
  })

  it('openaflow true closes as before, whatever podDocs says', async () => {
    for (const podDocs of [true, false]) {
      const t = await added({ status: 201, openaflow: true, podDocs })
      expect(t.flow.state()).toEqual({ kind: 'closed' })
      expect(t.setupRepo).not.toHaveBeenCalled()
    }
  })
})
