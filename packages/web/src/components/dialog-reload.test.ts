import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { postAction, RELOAD } from '../actions-client.ts'
import { TRY_AGAIN } from '../add-repo.ts'
import { createReloadFlag, type ReloadFlag } from '../reload-flag.ts'
import { AddRepoForm } from '../screens/runs/AddRepoDialog.tsx'
import type { AddRepoFlow } from '../screens/runs/add-repo-flow.ts'
import { ConfirmModal } from './ConfirmModal.tsx'
import { DialogAlert } from './DialogAlert.tsx'
import { ModalAlert } from './ModalAlert.tsx'

// A dialog's backdrop covers the Reload banner, so a dialog that says "Reload, then try again" has its own Reload
// beside the line, for the stale-token case only.

const on = (): ReloadFlag => {
  const flag = createReloadFlag()
  flag.set()
  return flag
}
const RELOAD_BUTTON = /<button class="btn sm" type="button">Reload<\/button>/
const reloadButtons = (html: string) => html.match(/>Reload<\/button>/g)?.length ?? 0

type Node = { type?: unknown; props?: { children?: unknown; onClick?: () => void } }
function buttons(node: unknown): Node[] {
  const n = node as Node
  if (!n || typeof n !== 'object') return []
  if (typeof n.type === 'function') return buttons((n.type as (p: unknown) => unknown)(n.props))
  const own = n.type === 'button' ? [n] : []
  const kids = n.props?.children
  return [...own, ...(Array.isArray(kids) ? kids : [kids]).flatMap(buttons)]
}

describe("a dialog's Reload", () => {
  it('shows beside the line on a stale token, and calls the reload function', () => {
    const reload = vi.fn()
    const html = renderToStaticMarkup(createElement(DialogAlert, { message: RELOAD, flag: on(), reload }))
    expect(html).toContain('<p class="modal-alert-text">Reload, then try again</p>')
    expect(html).toMatch(RELOAD_BUTTON)
    expect(reloadButtons(html)).toBe(1)
    const [button] = buttons(ModalAlert({ message: RELOAD, onReload: reload }))
    button!.props!.onClick!()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('never shows for other errors, or while no request found the token stale', () => {
    for (const message of [TRY_AGAIN, "Can't reach the board.", 'This repo is already gone']) {
      expect(reloadButtons(renderToStaticMarkup(createElement(DialogAlert, { message, flag: on() }))), message).toBe(0)
    }
    expect(reloadButtons(renderToStaticMarkup(createElement(DialogAlert, { message: RELOAD, flag: createReloadFlag() })))).toBe(0)
    // The shared alert box alone has no button: the Settings load error keeps none (the banner is in view there).
    expect(reloadButtons(renderToStaticMarkup(createElement(ModalAlert, { message: RELOAD })))).toBe(0)
  })

  it('Remove repo, Forget, and Add repo show it on the page flag after a bad-token reply', async () => {
    const confirm = (error: string) =>
      renderToStaticMarkup(createElement(ConfirmModal, { heading: 'Remove x?', detail: 'd', confirmLabel: 'Remove', busy: false, error, returnFocusTo: 'x', onConfirm: () => {}, onCancel: () => {} }))
    const noop = () => {}
    const flow = { cancel: noop, edit: noop, add: noop, browse: noop } as unknown as AddRepoFlow
    const add = (error: string) => renderToStaticMarkup(createElement(AddRepoForm, { state: { kind: 'form', path: '/x', busy: false, canChoose: false, error }, flow }))

    // Before any stale reply: the line alone.
    expect(reloadButtons(confirm(RELOAD))).toBe(0)
    await postAction('remove-repo', {}, { fetch: async () => new Response(JSON.stringify({ error: 'bad token' }), { status: 403 }), token: () => 'k' })
    for (const html of [confirm(RELOAD), add(RELOAD)]) {
      expect(html).toMatch(RELOAD_BUTTON)
      expect(reloadButtons(html)).toBe(1)
    }
    for (const html of [confirm(TRY_AGAIN), add(TRY_AGAIN)]) expect(reloadButtons(html)).toBe(0)
  })
})
