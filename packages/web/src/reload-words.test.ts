import { describe, expect, it } from 'vitest'
import { NEED_RELOAD, postAction, RESTARTED } from './actions-client.ts'
import { addError, postRepo } from './add-repo.ts'
import { createReloadFlag, RELOAD_NOTE, RELOAD_TITLE } from './reload-flag.ts'
import { toggleText } from './screens/runs/AutoContinueButton.tsx'
import { FORGET_ERRORS } from './screens/runs/forget-flow.ts'
import { refusalText, REMOVE_ERRORS } from './screens/runs/remove-flow.ts'
import { formView } from './screens/runs/answer-flow.ts'
import { confirmView as mergeView } from './screens/runs/merge-flow.ts'
import { resumeView } from './screens/runs/resume-flow.ts'
import { readSettings, saveSettings } from './screens/settings/settings-client.ts'
import { readTools } from './screens/setup/setup-client.ts'
import { afterRecheck, afterSave, type SetupState } from './screens/setup/setup-view.ts'

const SHORT = 'Reload, then try again'
const token = () => 'k'.repeat(43)
const badToken = async () => new Response(JSON.stringify({ error: 'bad token' }), { status: 403 })
const deps = { fetch: badToken, token, flag: createReloadFlag() }

/** Each of the six actions' inline line for a reply with `word`: the reload words, or a refused value's own. */
const SIX: [string, (word: string) => string | Promise<string>][] = [
  ['Add repo', (word) => addError({ status: 403, error: word }).message],
  ['Remove repo', (word) => refusalText(REMOVE_ERRORS, word)],
  ['Forget', (word) => refusalText(FORGET_ERRORS, word)],
  ['Auto-continue save', (word) => toggleText(word)],
]

describe('the failed action says only to reload; the banner says why', () => {
  it('the short line has no final period and is not the banner sentence', () => {
    expect(SHORT).not.toMatch(/\.$/)
    expect(`${RELOAD_TITLE} ${RELOAD_NOTE}`).toBe('OpenAFlow restarted in the background. Reload to continue.')
  })

  for (const [name, line] of SIX) {
    it(`${name}: a stale or missing token shows the short line`, async () => {
      expect(await line(RESTARTED)).toBe(SHORT)
      expect(await line(NEED_RELOAD)).toBe(SHORT)
    })
  }

  it('Add repo: a bad-token reply from the server shows the short line', async () => {
    expect(addError(await postRepo('/repo', deps)).message).toBe(SHORT)
  })

  it('Settings save: a bad-token reply shows the short line', async () => {
    const reply = await saveSettings({ scrollback: 200 }, deps)
    expect(reply.ok === false && reply.message).toBe(SHORT)
  })

  it('Settings load: a bad-token reply shows the short line', async () => {
    const read = await readSettings(deps)
    expect(read.ok === false && read.message).toBe(SHORT)
  })

  it('the action client and the setup check say the short line for a stale or missing token', async () => {
    for (const d of [deps, { ...deps, token: () => null }]) {
      const reply = await postAction('merge', {}, d)
      expect(reply.ok === false && reply.message).toBe(SHORT)
      const read = await readTools(d)
      expect(read.ok === false && read.message).toBe(SHORT)
    }
  })

  // Each of these shows the action client's message as it came: the client's words are the screen's words.
  for (const word of [RESTARTED, NEED_RELOAD]) {
    it(`Merge, Answer, Continue/Go, and the setup check show the short line (${word === RESTARTED ? 'stale' : 'no'} token)`, () => {
      expect(mergeView({ kind: 'error', seq: 1, target: { repoId: 'r', number: 7 }, message: word })?.error).toBe(SHORT)
      expect(formView({ kind: 'error', seq: 1, target: { repoId: 'r', line: 'l' }, text: 'x', message: word })?.error).toBe(SHORT)
      expect(resumeView({ kind: 'error', seq: 1, word: 'continue', message: word }, undefined).error).toBe(SHORT)
      const setup: SetupState = { tools: [], busy: true, rowErrors: {} }
      const saved = afterSave(setup, 'claude', { ok: false, status: 403, message: word })
      expect(saved.view === 'setup' && saved.setup.rowErrors.claude).toBe(SHORT)
      const rechecked = afterRecheck(setup, { ok: false, message: word })
      expect(rechecked.view === 'setup' && rechecked.setup.recheckError).toBe(SHORT)
    })
  }
})
