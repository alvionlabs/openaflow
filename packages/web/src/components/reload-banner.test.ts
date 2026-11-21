import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { postRepo } from '../add-repo.ts'
import { createReloadFlag, type ReloadFlag } from '../reload-flag.ts'
import { HostBanner, TopBanners } from '../screens/runs/HostBanner.tsx'
import { RunsScreen } from '../screens/runs/RunsScreen.tsx'
import { SetupScreen } from '../screens/setup/SetupScreen.tsx'
import { ReloadBanner, ReloadBannerView } from './ReloadBanner.tsx'

const on = (): ReloadFlag => {
  const flag = createReloadFlag()
  flag.set()
  return flag
}
const count = (html: string, cls: string) => html.match(new RegExp(`class="[^"]*\\b${cls}\\b`, 'g'))?.length ?? 0

type Node = { type?: unknown; props?: { children?: unknown; onClick?: () => void; className?: string } }
/** The `<button>` elements in a rendered tree, components called through. */
function buttons(node: unknown): Node[] {
  const n = node as Node
  if (!n || typeof n !== 'object') return []
  if (typeof n.type === 'function') return buttons((n.type as (p: unknown) => unknown)(n.props))
  const own = n.type === 'button' ? [n] : []
  const kids = n.props?.children
  return [...own, ...(Array.isArray(kids) ? kids : [kids]).flatMap(buttons)]
}

describe('the Reload banner', () => {
  it('shows the title, the note, and one small Reload button that reloads the page', () => {
    const reload = vi.fn()
    const html = renderToStaticMarkup(createElement(ReloadBannerView, { onReload: reload }))
    expect(html).toContain('<b>OpenAFlow restarted in the background.</b>')
    expect(html).toContain('Reload to continue.')
    expect(html).toMatch(/^<div class="alert-banner reload-banner" role="status"><span class="alert-banner-dot" aria-hidden="true"><\/span>/)
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toMatch(/<button class="btn sm" type="button">Reload<\/button>/)
    const [button] = buttons(ReloadBannerView({ onReload: reload }))
    expect(reload).not.toHaveBeenCalled()
    button!.props!.onClick!()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('draws nothing until a request finds the token stale, then the banner', () => {
    expect(renderToStaticMarkup(createElement(ReloadBanner, { flag: createReloadFlag() }))).toBe('')
    expect(count(renderToStaticMarkup(createElement(ReloadBanner, { flag: on() })), 'reload-banner')).toBe(1)
  })

  it('shares the host banner look: same box, dot, and text classes', () => {
    const host = renderToStaticMarkup(createElement(HostBanner))
    expect(host).toMatch(/^<div class="alert-banner host-banner" role="status"><span class="alert-banner-dot" aria-hidden="true"><\/span><p class="alert-banner-text"><b>/)
    expect(host).toContain('class="alert-banner-note"')
    expect(host).not.toContain('<button')
  })
})

describe('the page flag', () => {
  it('a page with no token sets the page flag, so the banner with no props shows', async () => {
    expect(renderToStaticMarkup(createElement(ReloadBanner))).toBe('')
    await postRepo('/repo', { fetch: async () => new Response('{}'), token: () => null })
    expect(count(renderToStaticMarkup(createElement(ReloadBanner)), 'reload-banner')).toBe(1)
  })
})

describe('where the Reload banner shows', () => {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const screen = (flag: ReloadFlag, settings?: { back: string }) =>
    renderToStaticMarkup(
      createElement(RunsScreen, { board: undefined, stream: 'live', runs: [], selected: undefined, view: 'pipeline', slice: undefined, now: 0, storage, settings, reloadFlag: flag }),
    )
  const mainOf = (html: string) => /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? ''

  it('on the runs screen and on Settings: once, first in the main column', () => {
    for (const html of [screen(on()), screen(on(), { back: '' })]) {
      expect(count(html, 'reload-banner')).toBe(1)
      expect(mainOf(html)).toMatch(/^<div class="alert-banner reload-banner"/)
    }
  })

  it('on the setup check: once, first in its main column', () => {
    const setup = { tools: [], busy: false, rowErrors: {} }
    const gate = { save: async () => {}, recheck: async () => {} }
    const html = renderToStaticMarkup(createElement(SetupScreen, { setup, gate, reloadFlag: on() }))
    expect(count(html, 'reload-banner')).toBe(1)
    expect(mainOf(html)).toMatch(/^<div class="alert-banner reload-banner"/)
  })

  it('above the host banner when both show: it holds the only action', () => {
    const html = renderToStaticMarkup(createElement(TopBanners, { reloadFlag: on(), hostDown: true }))
    expect(html).toMatch(/^<div class="alert-banner reload-banner"[\s\S]*<div class="alert-banner host-banner"/)
    expect(count(renderToStaticMarkup(createElement(TopBanners, { reloadFlag: createReloadFlag(), hostDown: true })), 'reload-banner')).toBe(0)
    expect(renderToStaticMarkup(createElement(TopBanners, { reloadFlag: createReloadFlag(), hostDown: false }))).toBe('')
  })

  it('nowhere while no request found the token stale', () => {
    for (const html of [screen(createReloadFlag()), screen(createReloadFlag(), { back: '' })]) expect(count(html, 'reload-banner')).toBe(0)
  })
})
