import { describe, expect, it } from 'vitest'
import { NEED_RELOAD, RESTARTED } from './actions-client.ts'
import { addError, postRepo } from './add-repo.ts'
import { createReloadFlag, RELOAD_NOTE, RELOAD_TITLE } from './reload-flag.ts'
import { toggleText } from './screens/runs/AutoContinueButton.tsx'
import { FORGET_ERRORS } from './screens/runs/forget-flow.ts'
import { refusalText, REMOVE_ERRORS } from './screens/runs/remove-flow.ts'
import { readSettings, saveSettings } from './screens/settings/settings-client.ts'

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
})
