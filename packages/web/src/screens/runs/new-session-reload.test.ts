import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildRepoModel, listRuns, type BoardRepo } from '@openaflow/model'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { postAction, RELOAD } from '../../actions-client.ts'
import { reloadFlag } from '../../reload-flag.ts'
import { NewSessionDialog } from './NewSessionDialog.tsx'
import { nextSteps } from './next-step.ts'
import { NextStepCard } from './NextStepCard.tsx'

// The real start card and the real New session modal, each with a start that failed on a stale token. Only the
// session hook is replaced, so both open on that failed state: a static render can't wait for the flow's reply.
vi.mock('./NewSessionForm.tsx', async (actual) => {
  const real = await actual<typeof import('./NewSessionForm.tsx')>()
  const noop = () => {}
  const flow = { board: noop, dispose: noop, start: noop, edit: noop, openSettings: noop }
  return { ...real, useNewSession: () => [{ kind: 'idle', error: RELOAD }, flow] }
})

const NOW = Date.UTC(2026, 10, 21, 12)
const repo: BoardRepo = {
  id: 'notes',
  name: 'notes-app',
  path: '/n',
  source: 'registered',
  model: buildRepoModel({ 'pod-docs/README.md': '# pod docs\n\npod docs: 2\n', 'pod-docs/handoff-queue.md': '' }),
  agents: [],
  prs: [],
  claims: [],
}

/** Renders with the desktop preload's terminal bridge on the page, as the desktop app has it: the card shows its form. */
function inDesktop<T>(fn: () => T): T {
  const g = globalThis as { window?: unknown }
  const had = 'window' in g
  const before = g.window
  g.window = { openaflow: { connectTerminals: () => Promise.resolve() } }
  try {
    return fn()
  } finally {
    if (had) g.window = before
    else delete g.window
  }
}

const reloadButtons = (html: string) => html.match(/<button class="btn sm" type="button">Reload<\/button>/g)?.length ?? 0

beforeAll(async () => {
  await postAction('new-session', {}, { fetch: async () => new Response(JSON.stringify({ error: 'bad token' }), { status: 403 }), token: () => 'k' })
})

describe('New session after a stale token: one Reload on the page', () => {
  it('the Next step start card shows the line with no Reload: the banner is in view', () => {
    expect(reloadFlag.get()).toBe(true)
    const run = listRuns({ generatedAt: NOW, gh: 'ok', repos: [repo] }, NOW).find((r) => r.plan === undefined)!
    const card = nextSteps(run, repo, NOW)!.card
    expect(card.action.kind).toBe('new-session')
    const html = inDesktop(() => renderToStaticMarkup(createElement(NextStepCard, { repo, run, card })))
    expect(html).toContain('<form class="new-session"')
    expect(html).toContain('Reload, then try again')
    expect(reloadButtons(html)).toBe(0)
  })

  it('the New session modal shows exactly one Reload beside the line: its backdrop covers the banner', () => {
    const html = inDesktop(() => renderToStaticMarkup(createElement(NewSessionDialog, { repo, onClose: () => {} })))
    expect(html).toContain('Reload, then try again')
    expect(reloadButtons(html)).toBe(1)
  })
})
