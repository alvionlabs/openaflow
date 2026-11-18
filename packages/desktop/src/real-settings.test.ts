import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { describe, expect, test, type TestContext } from 'vitest'
import {
  DESKTOP,
  endLifeProcesses,
  harnessDir,
  hostedOf,
  launchLife,
  LIFE_SIZE,
  lifeDetails,
  lifeRepo,
  lifeStarts,
  lifeUntil,
  packagedApp,
  postAction,
  readText,
  removeWithRetry,
  testHooks,
  type Harness,
  type LifeWorld,
} from '../test/electron-harness.ts'
import { hooksPluginDir } from './pty-host-launch.ts'

// The settings in the real Electron app (sprint settings §9): the page's scrollback for new sessions, a changed run
// wrapper and stop command, a broken wrapper's refusal and Open settings, Open at login, and the `#settings` route set
// from main. `claude` is test/fixtures/settings-claude.mjs. The changed wrapper and stop are plain `sh` scripts, so CI
// needs no user bus. Unpackaged only. Temp folders only; never the real `claude`, the real autostart folder, or (outside
// CI) the real Windows Run key. `pnpm test:electron real-settings` runs this after `pnpm build`.

const WIN = process.platform === 'win32'
const LINUX = process.platform === 'linux'
const PACKAGED = packagedApp() !== undefined
const RUN_MS = 240_000
const FIXTURE = join(DESKTOP, 'test', 'fixtures', 'settings-claude.mjs')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A repo with pod docs and no plan, so its row offers New session, and settings-claude as `claude`. */
function makeSettingsWorld(): LifeWorld {
  const dir = harnessDir()
  const cfg = join(dir, 'cfg')
  const repo = join(dir, 'repos', 'life-repo')
  const bin = join(dir, 'bin')
  for (const d of [cfg, bin, join(repo, 'pod-docs')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(repo, 'pod-docs', 'README.md'), '# pod docs\n\npod docs: 2\n')
  writeFileSync(join(repo, 'pod-docs', 'handoff-queue.md'), '# Handoff Queue\n')
  writeFileSync(join(cfg, 'config.json'), JSON.stringify({ version: 1, repos: [{ path: repo }] }))
  let claude: string
  if (WIN) {
    // The npm shim form `shimTarget` reads, with its own node.exe, as makeLifeWorld does.
    copyFileSync(FIXTURE, join(bin, 'settings-claude.mjs'))
    copyFileSync(process.execPath, join(bin, 'node.exe'))
    claude = join(bin, 'claude.cmd')
    writeFileSync(claude, ['@ECHO off', 'SET dp0=%~dp0', '"%dp0%\\settings-claude.mjs" %*', ''].join('\r\n'))
  } else {
    claude = join(bin, 'claude')
    copyFileSync(FIXTURE, claude)
    chmodSync(claude, 0o755)
    // An extensionless copy: this tells node it is a module.
    writeFileSync(join(bin, 'package.json'), '{"type":"module"}\n')
  }
  return { dir, cfg, repo, bin, claude }
}

/** Runs `check` on a new world, and always ends the fake's processes and the folders. */
async function inWorld(check: (w: LifeWorld) => Promise<void>): Promise<void> {
  const w = makeSettingsWorld()
  try {
    await check(w)
  } finally {
    endLifeProcesses(w)
    await removeWithRetry(w.dir)
  }
}

async function withApp(w: LifeWorld, run: (h: Harness) => Promise<void>): Promise<void> {
  const h = await launchLife(w)
  try {
    await run(h)
  } finally {
    await h.close()
  }
}

/** Skips the test, with a line that says why, on the systems it isn't for. */
function only(ctx: TestContext, on: boolean, why: string): boolean {
  if (on) return true
  process.stderr.write(`real-settings › ${ctx.task.name}: skipped, ${why} on ${process.platform}\n`)
  ctx.skip()
  return false
}

/** The repo on the Board and the test hook in main. */
async function ready(h: Harness, w: LifeWorld): Promise<string> {
  await lifeUntil('the repo on the Board', async () => (await lifeRepo(h, w)) !== undefined, 60_000, w)
  await lifeUntil('the test hook (is this a --test-hooks build?)', () => testHooks(h).ready(), 60_000, w)
  return (await lifeRepo(h, w))!.id
}

/** A plain New session through the route with `text` as its prompt, live on the Board, and its fake started. */
async function startSession(h: Harness, w: LifeWorld, repoId: string, text: string): Promise<{ marker: string; sessionId: string }> {
  const before = lifeStarts(w).length
  const answer = await postAction(h, 'new-session', { repoId, skill: 'plain', text, ...LIFE_SIZE })
  if (answer.status !== 200) throw new Error(`new-session answered ${JSON.stringify(answer)}\n${lifeDetails(w)}`)
  const marker = answer.body.marker as string
  await lifeUntil('the session live', async () => (await hostedOf(h, w, marker))?.state === 'live', 15_000, w)
  await lifeUntil('the fake to start', () => lifeStarts(w).length > before, 15_000, w)
  return { marker, sessionId: (await hostedOf(h, w, marker))!.sessionId }
}

/** The settings file as the server wrote it. */
const settingsFile = (w: LifeWorld): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(join(w.cfg, 'settings.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** The plugin folder main gives the server, for this build. Unpackaged, the harness names the desktop package as the app's folder. */
async function pluginDir(h: Harness): Promise<string> {
  const place = await h.app.evaluate(({ app }) => ({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }))
  return hooksPluginDir({ ...place, appPath: DESKTOP })
}

/** An executable `sh` script in the world's `bin`. */
function script(w: LifeWorld, name: string, lines: string[]): string {
  const file = join(w.bin, name)
  writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'))
  chmodSync(file, 0o755)
  return file
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])

type Bridge = { openAtLogin(): Promise<boolean>; setOpenAtLogin(on: boolean): Promise<boolean> }
const bridgeCall = (page: Page, on?: boolean) =>
  page.evaluate((on) => {
    const b = (window as unknown as { openaflow: Bridge }).openaflow
    return on === undefined ? b.openAtLogin() : b.setOpenAtLogin(on)
  }, on)

/** The settings page, open beside the sidebar. */
async function openSettings(h: Harness, w: LifeWorld): Promise<void> {
  await h.page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
  await h.page.evaluate(() => (location.hash = '#settings'))
  // GET /api/settings waits for the scope probe's first answer, up to about 6 s after the start.
  await lifeUntil('the settings page, loaded', () => h.page.locator('main.settings-main section[aria-label="Terminals"]').isVisible(), 30_000, w)
}

describe.runIf(process.env.OPENAFLOW_REAL_ELECTRON === '1' && !PACKAGED && (LINUX || WIN))('real settings (unpackaged)', () => {
  test('scrollback applies to new sessions', async () => {
    await inWorld((w) =>
      withApp(w, async (h) => {
        const repoId = await ready(h, w)
        // Before the change: more lines than the default 5,000 keeps.
        const old = await startSession(h, w, repoId, 'print --lines 6000')
        expect(await hostedOf(h, w, old.marker)).toMatchObject({ scrollback: 5_000 })

        // The page's own field and its POST.
        await openSettings(h, w)
        const field = h.page.locator('#settings-scrollback')
        expect(await field.inputValue()).toBe('5000')
        await field.fill('200')
        await field.press('Enter')
        await lifeUntil('scrollback 200 in settings.json', () => settingsFile(w)?.scrollback === 200, 15_000, w)

        const next = await startSession(h, w, repoId, 'print --lines 1000')
        expect(await hostedOf(h, w, next.marker)).toMatchObject({ scrollback: 200 })
        // The fake prints its args after its lines.
        const snap = async (marker: string) => {
          let text = ''
          await lifeUntil('the args on the host screen', async () => (text = (await testHooks(h).snapshot(marker)) ?? '').includes('settings-claude args:'), 30_000, w)
          return text.split('\n')
        }
        const rows = LIFE_SIZE.rows
        const kept = await snap(next.marker)
        expect(kept).toContain('n 1000')
        expect(kept.length, kept.slice(0, 3).join(' | ')).toBeLessThanOrEqual(200 + rows)
        expect(kept.length).toBeGreaterThanOrEqual(200)
        expect(kept).not.toContain('n 700')
        const before = await snap(old.marker)
        expect(before).toContain('n 6000')
        expect(before.length, before.slice(0, 3).join(' | ')).toBeLessThanOrEqual(5_000 + rows)
        expect(before.length).toBeGreaterThanOrEqual(5_000)
        expect(before).toContain('n 1500')
        expect(before).not.toContain('n 900')
      }),
    )
  }, RUN_MS)

  test('changed wrapper and stop', async (ctx) => {
    if (!only(ctx, LINUX, 'no sh wrapper')) return
    await inWorld((w) =>
      withApp(w, async (h) => {
        const repoId = await ready(h, w)
        // The session env has no OPENAFLOW_* names, so the scripts hold absolute paths.
        const wrapped = join(w.bin, 'wrapped.txt')
        const stopped = join(w.bin, 'stopped.txt')
        const wrap = script(w, 'wrap.sh', [`printf '%s\\n' "$1" >> '${wrapped}'`, 'shift', 'exec "$@"'])
        const stop = script(w, 'stop.sh', [`printf '%s\\n' "$1" >> '${stopped}'`])
        const saved = await postAction(h, 'settings', { runWrapper: `${wrap} {runId}`, stopCommand: `${stop} {runId}` })
        expect(saved.status, JSON.stringify(saved)).toBe(200)

        const { marker, sessionId } = await startSession(h, w, repoId, '')
        // First the wrapper check, around `true`, with a fresh id; then the start, with the session's marker.
        const ids = lines(wrapped)
        expect(ids, lifeDetails(w)).toHaveLength(2)
        expect(ids[0]).toMatch(UUID)
        expect(ids[0]).not.toBe(marker)
        expect(ids[1]).toBe(marker)
        // The rest of the command reached the fake: its own args, unchanged.
        expect(lifeStarts(w)[0]!.args).toEqual(['--session-id', sessionId, '--plugin-dir', await pluginDir(h)])
        // The stop is never run as a check, nor at a start.
        expect(existsSync(stopped)).toBe(false)

        const fake = lifeStarts(w)[0]!.pid
        await testHooks(h).quit()
        await lifeUntil('the stop script with the marker', () => lines(stopped).includes(marker), 15_000, w)
        expect(lines(stopped)).toEqual([marker])
        await lifeUntil('the app to quit', () => h.exited(), 15_000, w)
        await lifeUntil('the fake gone', () => {
          try {
            process.kill(fake, 0)
            return false
          } catch {
            return true
          }
        }, 10_000, w)
      }),
    )
  }, RUN_MS)

  test('broken wrapper stops the start', async (ctx) => {
    if (!only(ctx, LINUX, 'no sh wrapper')) return
    await inWorld((w) =>
      withApp(w, async (h) => {
        const repoId = await ready(h, w)
        const bad = script(w, 'bad.sh', ["echo 'bad option' >&2", 'exit 3'])
        expect((await postAction(h, 'settings', { runWrapper: bad })).status).toBe(200)

        // The route: refused, no record, no start.
        expect(await postAction(h, 'new-session', { repoId, skill: 'plain', text: '', ...LIFE_SIZE })).toEqual({ status: 409, body: { error: 'run wrapper: exit 3: bad option' } })
        expect((await lifeRepo(h, w))?.hosted ?? []).toEqual([])
        expect(readText(join(w.cfg, 'sessions.json'))).not.toMatch(/"marker"/)
        expect(lifeStarts(w)).toEqual([])

        // The form: the error box, then Open settings shows the page.
        const page = h.page
        await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
        await page.evaluate((id) => (location.hash = `#/${id}`), repoId)
        const form = page.locator('section.next-step form.new-session')
        await lifeUntil('the New session form', () => form.isVisible(), 30_000, w)
        await form.locator('input.ns-text').fill('add a clock')
        await form.getByRole('button', { name: 'New session' }).click()
        const box = form.locator('.wrapper-error')
        await lifeUntil('the wrapper error', () => box.isVisible(), 30_000, w)
        expect(await box.locator('.modal-alert-text').innerText()).toBe("The session didn't start")
        expect(await box.locator('.wrapper-error-line').innerText()).toBe('Your run wrapper failed:')
        expect(await box.locator('.wrapper-error-code').innerText()).toBe('exit 3: bad option')
        await box.getByRole('button', { name: 'Open settings' }).click()
        await lifeUntil('the settings page', () => page.locator('main.settings-main section[aria-label="Run wrapper"]').isVisible(), 30_000, w)
        expect(await page.evaluate(() => location.hash)).toBe('#settings')
        expect(await page.locator('#settings-runWrapper').inputValue()).toBe(bad)
        expect(lifeStarts(w)).toEqual([])
      }),
    )
  }, RUN_MS)

  test('open at login on linux', async (ctx) => {
    if (!only(ctx, LINUX, 'no autostart file')) return
    await inWorld((w) =>
      withApp(w, async (h) => {
        await ready(h, w)
        const file = join(w.dir, 'autostart', 'openaflow.desktop')
        const { exec, appPath } = await h.app.evaluate(({ app }) => ({ exec: process.execPath, appPath: app.getAppPath() }))
        const entry = ['[Desktop Entry]', 'Type=Application', 'Name=OpenAFlow', `Exec="${exec}" "${appPath}" "--hidden"`, 'X-GNOME-Autostart-enabled=true']
        expect(await bridgeCall(h.page)).toBe(false)
        expect(await bridgeCall(h.page, true)).toBe(true)
        expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual(entry)
        expect(await bridgeCall(h.page)).toBe(true)
        expect(await bridgeCall(h.page, false)).toBe(false)
        expect(existsSync(file)).toBe(false)

        // The page's switch does the same.
        await openSettings(h, w)
        const toggle = h.page.getByRole('switch', { name: 'Open at login' })
        expect(await toggle.getAttribute('aria-checked')).toBe('false')
        await toggle.click()
        await lifeUntil('the switch on', async () => (await toggle.getAttribute('aria-checked')) === 'true', 15_000, w)
        expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual(entry)
        await toggle.click()
        await lifeUntil('the switch off', async () => (await toggle.getAttribute('aria-checked')) === 'false', 15_000, w)
        expect(existsSync(file)).toBe(false)
      }),
    )
  }, RUN_MS)

  test('windows settings', async (ctx) => {
    if (!only(ctx, WIN, 'no Windows Run key')) return
    await inWorld((w) =>
      withApp(w, async (h) => {
        await ready(h, w)
        await openSettings(h, w)
        const main = h.page.locator('main.settings-main')
        expect(await main.locator('section[aria-label="Run wrapper"]').count()).toBe(0)
        expect(await main.locator('section[aria-label="General"]').count()).toBe(1)
        expect(await main.locator('#settings-runWrapper').count()).toBe(0)

        // Turning it on writes the real HKCU Run value, so only on a CI runner.
        if (process.env.CI !== 'true') {
          process.stderr.write('real-settings › windows settings: Open at login not turned on, CI is not true\n')
          return
        }
        try {
          expect(await bridgeCall(h.page)).toBe(false)
          expect(await bridgeCall(h.page, true)).toBe(true)
          expect(await bridgeCall(h.page)).toBe(true)
          expect(await bridgeCall(h.page, false)).toBe(false)
        } finally {
          // From main, so a page that went away still leaves the Run value off. The harness runs unpackaged.
          await h.app.evaluate(({ app }) => app.setLoginItemSettings({ openAtLogin: false, args: [app.getAppPath(), '--hidden'] }))
        }
        expect(await h.app.evaluate(({ app }) => app.getLoginItemSettings({ args: [app.getAppPath(), '--hidden'] }).openAtLogin)).toBe(false)
      }),
    )
  }, RUN_MS)

  test('main opens the settings page', async () => {
    await inWorld((w) =>
      withApp(w, async (h) => {
        const repoId = await ready(h, w)
        const page = h.page
        await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
        await page.evaluate((id) => (location.hash = `#/${id}`), repoId)
        await lifeUntil('the run', () => page.locator('main h1.run-name').isVisible(), 30_000, w)

        // As the tray's Settings does (window-main.ts `setHash`): main sets the hash on the window's page.
        await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#settings')}`))
        await lifeUntil('the settings page', () => page.locator('main.settings-main h1.settings-title').isVisible(), 30_000, w)
        expect(await page.locator('aside.side').isVisible()).toBe(true)
        expect(await page.locator('h1.run-name').count()).toBe(0)

        await page.locator('main.settings-main').getByRole('button', { name: 'Back' }).click()
        await lifeUntil('the run again', () => page.locator('main h1.run-name').isVisible(), 15_000, w)
        expect(await page.evaluate(() => location.hash)).toBe(`#/${repoId}`)
        expect(await page.locator('main.settings-main').count()).toBe(0)
      }),
    )
  }, RUN_MS)
})
