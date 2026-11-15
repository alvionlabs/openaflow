import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DESKTOP, launchHarness, packagedApp, type Harness } from '../test/electron-harness.ts'

// The Terminal tab in the real Electron app, through the product path: the page's New session posts the route, the
// server starts a fake `claude` (test/fixtures/tab-claude.mjs, sprint terminal-tab §9) in the pty host, and the page's
// xterm reads and types into it over the terminal link. Unpackaged only (§9). The tests share one app and one repo, in
// order. `pnpm test:electron real-terminal-tab` runs this after `pnpm build`.

const WIN = process.platform === 'win32'
const PACKAGED = packagedApp() !== undefined
const RUN_MS = 180_000
const FIXTURE = join(DESKTOP, 'test', 'fixtures', 'tab-claude.mjs')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The fake `claude` the server's tool finder takes from OPENAFLOW_CLAUDE_BIN: a script named `claude`, or an npm shim. */
function fakeClaude(dir: string): string {
  if (WIN) {
    copyFileSync(FIXTURE, join(dir, 'tab-claude.mjs'))
    const shim = join(dir, 'claude.cmd')
    // The npm shim form `shimTarget` reads: the last quoted %dp0% path before %*, run with node from PATH.
    writeFileSync(shim, ['@ECHO off', 'SETLOCAL', 'SET dp0=%~dp0', 'node "%dp0%\\tab-claude.mjs" %*', ''].join('\r\n'))
    return shim
  }
  const bin = join(dir, 'claude')
  copyFileSync(FIXTURE, bin)
  chmodSync(bin, 0o755)
  return bin
}

/** A repo the Board reads: pod docs version 2 and an empty queue, so its row offers New session. */
function makeRepo(dir: string): string {
  const repo = join(dir, 'notes-app')
  mkdirSync(join(repo, 'pod-docs'), { recursive: true })
  writeFileSync(join(repo, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
  writeFileSync(join(repo, 'pod-docs', 'handoff-queue.md'), '# Handoff Queue\n')
  return repo
}

const desktopLog = (h: Harness) => {
  const file = join(h.dir, 'shell', 'desktop.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** What xterm draws, as text with its rows run together, so a line xterm wraps still reads whole. */
const screen = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.term .xterm-rows > div')].map((r) => (r.textContent ?? '').trimEnd()).join(''))

/** Every failed wait shows the screen, the page's text, and the desktop log. */
async function until(what: string, ok: () => boolean | Promise<boolean>, h: Harness, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    if (await Promise.resolve().then(ok).catch(() => false)) return
    if (Date.now() > end) {
      const term = await screen(h.page).catch(() => '(no screen)')
      const body = await h.page.evaluate(() => document.body.innerText).catch(() => '(no page)')
      throw new Error(`timed out waiting for ${what}\nterminal:\n${term}\npage:\n${body.slice(0, 3_000)}\ndesktop.log:\n${desktopLog(h).slice(-4_000)}`)
    }
    await sleep(100)
  }
}

/** How far xterm's screen stays inside the terminal box's content area (inside its padding), right and bottom. */
const fitGap = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('.term')
    const screen = document.querySelector('.term .xterm-screen')
    if (!box || !screen) return undefined
    const b = box.getBoundingClientRect()
    const s = screen.getBoundingClientRect()
    const cs = getComputedStyle(box)
    const right = b.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) - s.right
    const bottom = b.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom) - s.bottom
    return { right, bottom }
  })

const terminalTab = (page: Page) => page.locator('.main > .tabs button.tab', { hasText: 'Terminal' })
const count = (text: string, part: string) => text.split(part).length - 1

describe.runIf(process.env.OPENAFLOW_REAL_ELECTRON === '1' && !PACKAGED && (process.platform === 'linux' || WIN))('real terminal tab (unpackaged)', () => {
  let h: Harness
  let dir: string
  let repo: string

  beforeAll(async () => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'openaflow-tab-')))
    const bin = fakeClaude(dir)
    repo = makeRepo(dir)
    h = await launchHarness({ env: { OPENAFLOW_CLAUDE_BIN: bin } })
    await h.page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
    // Add the repo through the API, with the page's own token.
    const added = await h.page.evaluate(async (path) => {
      const token = document.querySelector('meta[name="openaflow-token"]')?.getAttribute('content') ?? ''
      const res = await fetch('/api/repos', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenAFlow-Token': token }, body: JSON.stringify({ path }) })
      return res.status
    }, repo)
    expect(added).toBe(201)
    await until('the repo row with the New session form', () => h.page.locator('section.next-step form.new-session').isVisible(), h)
  }, RUN_MS)

  afterAll(async () => {
    await h?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, RUN_MS)

  test(
    'the form by keys',
    async () => {
      const { page } = h
      // Start with: End opens the list on its last option, Plain session; Enter picks it.
      const box = page.locator('section.next-step form.new-session [role="combobox"]')
      await box.focus()
      await page.keyboard.press('End')
      await until('the open list', async () => (await box.getAttribute('aria-expanded')) === 'true', h)
      await page.keyboard.press('Enter')
      await until('Plain session picked', async () => (await box.innerText()).includes('Plain session'), h)
      expect(await box.getAttribute('aria-expanded')).toBe('false')
      expect(await page.locator('section.next-step form.new-session label', { hasText: 'Message (optional)' }).count()).toBe(1)
      // Back to Plan for the next test.
      await page.keyboard.press('Home')
      await page.keyboard.press('Enter')
      await until('Plan picked', async () => (await box.innerText()).includes('Plan'), h)

      // ⋯ New session by keys: Enter opens the menu (a group of buttons), Tab reaches New session, Enter opens the modal
      // with focus in the text field.
      await page.locator('#run-menu-trigger').focus()
      await page.keyboard.press('Enter')
      await until('the menu', async () => (await page.locator('#run-menu-trigger').getAttribute('aria-expanded')) === 'true', h)
      const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
      for (let i = 0; i < 12 && (await focused()) !== 'New session'; i++) await page.keyboard.press('Tab')
      expect(await focused()).toBe('New session')
      await page.keyboard.press('Enter')
      await until('the modal', () => page.locator('dialog form.new-session').isVisible(), h)
      await until('focus in the text field', () => page.evaluate(() => document.activeElement?.matches('dialog form.new-session input.ns-text') === true), h)
      // Escape closes it, and focus goes back to the ⋯ button.
      await page.keyboard.press('Escape')
      await until('the modal closed', async () => (await page.locator('dialog[open]').count()) === 0, h)
      await until('focus back on ⋯', () => page.evaluate(() => document.activeElement?.id === 'run-menu-trigger'), h)
    },
    RUN_MS,
  )

  test(
    'the tab shows a live session',
    async () => {
      const { page } = h
      const form = page.locator('section.next-step form.new-session')
      await form.locator('input.ns-text').fill('add a clock')
      await form.getByRole('button', { name: 'New session' }).click()
      // The started session opens the Terminal tab on the repo row.
      await until('the Terminal tab, open', async () => (await terminalTab(page).getAttribute('aria-expanded')) === 'true', h)
      await until('the fake claude in xterm', async () => (await screen(page)).includes('ready>'), h)
      const shown = await screen(page)
      expect(shown).toContain('--session-id')
      expect(shown).toContain('/pod:plan add a clock')
      // xterm fits inside the box's padding, at desktop width and at 375 px.
      for (const width of [1280, 375]) {
        await h.app.evaluate(({ BrowserWindow }, w) => {
          const win = BrowserWindow.getAllWindows()[0]!
          win.setMinimumSize(300, 300)
          win.setContentSize(w, 860)
        }, width)
        await until(`a fit at ${width} px`, async () => (await fitGap(page)) !== undefined, h)
        await sleep(500)
        const gap = (await fitGap(page))!
        expect(gap.right, `right gap at ${width} px`).toBeGreaterThanOrEqual(-0.5)
        expect(gap.bottom, `bottom gap at ${width} px`).toBeGreaterThanOrEqual(-0.5)
      }
      await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 900))
      // The tab's run dot while it runs.
      expect(await terminalTab(page).locator('.status.s-run').count()).toBe(1)
      // The Board reads it live, then hooked.
      await until('Live under the terminal', async () => (await page.locator('.term-foot').innerText()).includes('Live'), h)

      // Typed text goes to the session, and its answer shows in xterm.
      await page.locator('.term').click()
      await page.keyboard.type('hello')
      await page.keyboard.press('Enter')
      await until('the echo', async () => (await screen(page)).includes('got:hello'), h)

      // A reload keeps the tab open and replays the screen once.
      await page.reload()
      await until('the Terminal tab after the reload', async () => (await terminalTab(page).getAttribute('aria-expanded')) === 'true', h)
      await until('the replay', async () => (await screen(page)).includes('got:hello'), h)
      await sleep(1_000)
      expect(count(await screen(page), 'got:hello')).toBe(1)
      expect(count(await screen(page), 'tab-claude args:')).toBe(1)
      // Input still reaches it after the reload.
      await page.locator('.term').click()
      await page.keyboard.type('again')
      await page.keyboard.press('Enter')
      await until('the echo after the reload', async () => (await screen(page)).includes('got:again'), h)
    },
    RUN_MS,
  )

  test(
    'ended and dismissed',
    async () => {
      const { page } = h
      await page.locator('.term').click()
      await page.keyboard.type('bye')
      await page.keyboard.press('Enter')
      // The fake ends with code 0: the stop bar, with Dismiss and no Resume, and no dot on the tab.
      const bar = page.locator('.stop-bar')
      await until('the stop bar', () => bar.isVisible(), h)
      expect(await bar.locator('.status').innerText()).toBe('Ended · Claude exited')
      expect(await bar.innerText()).toMatch(/The terminal ended at \d\d:\d\d\./)
      expect(await bar.getByRole('button').allInnerTexts()).toEqual(['Dismiss'])
      expect(await terminalTab(page).locator('.status').count()).toBe(0)
      // The last screen stays under the bar, faded, while the host holds it.
      await until('the faded last screen', async () => (await screen(page)).includes('got:again'), h)
      expect(await page.locator('.term.faded').isVisible()).toBe(true)

      await bar.getByRole('button', { name: 'Dismiss' }).click()
      await until('the Terminal tab gone', async () => (await terminalTab(page).count()) === 0, h)
      expect(await page.locator('.stop-bar').count()).toBe(0)
      // Focus goes to the run title, not to the page body.
      expect(await page.evaluate(() => document.activeElement?.classList.contains('run-name') === true)).toBe(true)
      // The repo row offers New session again.
      await until('the New session form again', () => page.locator('section.next-step form.new-session').isVisible(), h)
    },
    RUN_MS,
  )
})
