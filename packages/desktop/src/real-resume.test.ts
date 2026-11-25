import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { describe, expect, test } from 'vitest'
import {
  DESKTOP,
  endLifeProcesses,
  hostedOf,
  launchLife,
  lifeRepo,
  lifeSession,
  lifeStarts,
  lifeUntil,
  makeLifeWorld,
  packagedApp,
  postAction,
  removeWithRetry,
  testHooks,
  writeLifeTranscript,
  type Harness,
  type LifeWorld,
} from '../test/electron-harness.ts'
import { hooksPluginDir, workflowsRoot } from './pty-host-launch.ts'

// Resume in the real Electron app (sprint session-life §4, §5, §9, §10): the route, the Terminal tab's stop bar over
// the saved screen, `can't resume`, and the host banner. `claude` is test/fixtures/life-claude.mjs; the test writes
// the transcript Resume needs, since the fake writes none. Also on the packaged build (OPENAFLOW_PACKAGED_APP).
// Temp folders only; never the real `claude`. `pnpm test:electron real-resume` runs this after `pnpm build`.

const WIN = process.platform === 'win32'
const LINUX = process.platform === 'linux'
const PACKAGED = packagedApp() !== undefined
const RUN_MS = 240_000

/** The plugin folder main gives the server, for this build. Unpackaged, the harness names the desktop package as the app's folder. */
async function pluginDir(h: Harness): Promise<string> {
  const place = await h.app.evaluate(({ app }) => ({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }))
  return hooksPluginDir({ ...place, appPath: DESKTOP })
}

/** The bundled workflow folder main names in OPENAFLOW_WORKFLOWS_DIR, for this build (`pnpm build` makes it). */
async function workflowDir(h: Harness): Promise<string> {
  const place = await h.app.evaluate(({ app }) => ({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }))
  const dir = join(workflowsRoot({ ...place, appPath: DESKTOP }), 'claude-pod')
  expect(existsSync(join(dir, '.claude-plugin', 'plugin.json')), dir).toBe(true)
  return dir
}

// --- The page ---

/** What xterm draws, as text with its rows run together. */
const screen = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.term:not(.saved) .xterm-rows > div')].map((r) => (r.textContent ?? '').trimEnd()).join(''))
const terminalTab = (page: Page) => page.locator('.main > .tabs button.tab', { hasText: 'Terminal' })

/** The repo's page with its Terminal tab open. A restart is a new origin, so the stored open tab is gone. */
async function openTerminalTab(h: Harness, w: LifeWorld, repoId: string): Promise<void> {
  await h.page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
  await h.page.evaluate((id) => (location.hash = `#/${id}`), repoId)
  await lifeUntil('the Terminal tab', async () => (await terminalTab(h.page).count()) === 1, 30_000, w)
  if ((await terminalTab(h.page).getAttribute('aria-expanded')) !== 'true') await terminalTab(h.page).click()
  await lifeUntil('the Terminal tab, open', async () => (await terminalTab(h.page).getAttribute('aria-expanded')) === 'true', 15_000, w)
}

/** Runs `check` on a new world, and always ends the fake's processes and the folders. */
async function inWorld(check: (w: LifeWorld) => Promise<void>): Promise<void> {
  const w = makeLifeWorld()
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

describe.runIf(process.env.OPENAFLOW_REAL_ELECTRON === '1' && (LINUX || WIN))(`real resume (${PACKAGED ? 'packaged' : 'unpackaged'})`, () => {
  test('resume through the route', async () => {
    await inWorld((w) =>
      withApp(w, async (h) => {
        expect(await h.app.evaluate(({ app }) => app.isPackaged)).toBe(PACKAGED)
        const { marker, repoId, sessionId } = await lifeSession(h, w)
        // The host's first save comes at most 10 s after the start.
        await lifeUntil('the saved screen', () => existsSync(join(w.cfg, 'screens', `${marker}.txt`)), 15_000, w)
        const old = await testHooks(h).hostPid()
        process.kill(old!, 'SIGKILL')
        await lifeUntil('stopped · terminals restarted', async () => (await hostedOf(h, w, marker))?.stopReason === 'terminals restarted', 30_000, w)
        await lifeUntil('a new host, ready', async () => ((await testHooks(h).hostPid()) ?? old) !== old && Array.isArray(await testHooks(h).list()), 30_000, w)
        const repoPath = (await lifeRepo(h, w))!.path
        writeLifeTranscript(w, repoPath, sessionId)
        await lifeUntil('resume ok on the Board', async () => (await hostedOf(h, w, marker))?.resume === 'ok', 30_000, w)

        // The old record's files are there before the Resume, so their removal below means something.
        expect(existsSync(join(w.cfg, 'hooks', `${marker}.jsonl`))).toBe(true)
        expect(existsSync(join(w.cfg, 'screens', `${marker}.txt`))).toBe(true)
        const answer = await postAction(h, 'resume-session', { repoId, marker, cols: 120, rows: 30 })
        expect(answer, JSON.stringify(answer)).toMatchObject({ status: 200, body: { outcome: 'started', logged: true } })
        const next = answer.body.marker as string
        expect(next).not.toBe(marker)
        // `--resume <id>` and the plugin folder, with no prompt.
        await lifeUntil('the resumed fake', () => lifeStarts(w).length === 2, 15_000, w)
        expect(lifeStarts(w)[1]!.args).toEqual(['--resume', sessionId, '--plugin-dir', await pluginDir(h)])
        // The old record, its hook file, and its screen file are gone; the new one holds the conversation.
        expect(await hostedOf(h, w, marker)).toBeUndefined()
        expect(existsSync(join(w.cfg, 'hooks', `${marker}.jsonl`))).toBe(false)
        expect(existsSync(join(w.cfg, 'screens', `${marker}.txt`))).toBe(false)
        await lifeUntil('the resumed session hooked', async () => (await hostedOf(h, w, next))?.hooked === true, 15_000, w)
        expect(await hostedOf(h, w, next)).toMatchObject({ state: 'live', liveSession: sessionId })
        // A second Resume of the old marker finds nothing.
        expect(await postAction(h, 'resume-session', { repoId, marker })).toEqual({ status: 404, body: { error: 'no session' } })
      }),
    )
  }, RUN_MS)

  test('resume args', async () => {
    await inWorld(async (w) => {
      // A set-up repo: its sessions load the bundled workflow too. The world's own repo (pod-docs/ only) is the hooks-only case above.
      const folder = join(w.repo, '.openaflow', 'workflows', 'claude-pod')
      mkdirSync(join(folder, 'state'), { recursive: true })
      writeFileSync(join(folder, 'workflow.json'), JSON.stringify({ source: 'claude-pod', version: '0.11.10' }, null, 2) + '\n')
      await withApp(w, async (h) => {
        const { marker, repoId, sessionId } = await lifeSession(h, w)
        await lifeUntil('the fake to start', () => lifeStarts(w).length === 1, 15_000, w)
        expect(lifeStarts(w)[0]!.args).toEqual(['--session-id', sessionId, '--plugin-dir', await pluginDir(h), '--add-dir', await workflowDir(h), '--plugin-dir', await workflowDir(h)])
        await testHooks(h).kill(marker)
        await lifeUntil('the session ended', async () => (await hostedOf(h, w, marker))?.state === 'ended', 15_000, w)
        writeLifeTranscript(w, (await lifeRepo(h, w))!.path, sessionId)
        await lifeUntil('resume ok on the Board', async () => (await hostedOf(h, w, marker))?.resume === 'ok', 30_000, w)
        const answer = await postAction(h, 'resume-session', { repoId, marker, cols: 120, rows: 30 })
        expect(answer, JSON.stringify(answer)).toMatchObject({ status: 200, body: { outcome: 'started', logged: true } })
        // `--resume <id>`, the hooks plugin, then the workflow, with no prompt.
        await lifeUntil('the resumed fake', () => lifeStarts(w).length === 2, 15_000, w)
        expect(lifeStarts(w)[1]!.args).toEqual(['--resume', sessionId, '--plugin-dir', await pluginDir(h), '--add-dir', await workflowDir(h), '--plugin-dir', await workflowDir(h)])
      })
    })
  }, RUN_MS)

  test('resume from the tab', async () => {
    await inWorld(async (w) => {
      let marker = ''
      let sessionId = ''
      await withApp(w, async (h) => {
        ;({ marker, sessionId } = await lifeSession(h, w))
        await lifeUntil('the args on the host screen', async () => ((await testHooks(h).snapshot(marker)) ?? '').includes('life-claude args:'), 15_000, w)
      })
      // The quit ended the session (the test-hooks build answers end) and saved its screen.
      await withApp(w, async (h) => {
        const repo = await (async () => {
          await lifeUntil('stopped · app closed', async () => (await hostedOf(h, w, marker))?.stopReason === 'app closed', 60_000, w)
          return (await lifeRepo(h, w))!
        })()
        writeLifeTranscript(w, repo.path, sessionId)
        await lifeUntil('resume ok on the Board', async () => (await hostedOf(h, w, marker))?.resume === 'ok', 30_000, w)
        await openTerminalTab(h, w, repo.id)

        const bar = h.page.locator('.stop-bar')
        await lifeUntil('the stop bar with Resume', async () => (await bar.getByRole('button', { name: 'Resume' }).count()) === 1, 30_000, w)
        expect(await bar.getByRole('button').allInnerTexts()).toEqual(['Resume', 'Dismiss'])
        // Under the bar: the saved screen, faded, with the fake's own output.
        const saved = h.page.locator('.term.faded.saved')
        await lifeUntil('the saved screen', async () => (await saved.count()) === 1 && (await saved.innerText()).includes('life-claude args:'), 30_000, w)

        await bar.getByRole('button', { name: 'Resume' }).click()
        await lifeUntil('the resumed fake in xterm', async () => (await screen(h.page)).includes('"--resume"'), 30_000, w)
        await lifeUntil('the stop bar gone', async () => (await bar.count()) === 0, 15_000, w)
        // Live: keys reach the session and its answer shows.
        await h.page.locator('.term').first().click()
        await h.page.keyboard.type('again')
        await h.page.keyboard.press('Enter')
        await lifeUntil('the echo', async () => (await screen(h.page)).includes('got:again'), 15_000, w)
        expect(lifeStarts(w).at(-1)!.args.slice(0, 2)).toEqual(['--resume', sessionId])
      })
    })
  }, RUN_MS)

  test("can't resume", async () => {
    await inWorld((w) =>
      withApp(w, async (h) => {
        const { marker, repoId } = await lifeSession(h, w)
        await testHooks(h).kill(marker)
        await lifeUntil('the session ended', async () => (await hostedOf(h, w, marker))?.state === 'ended', 15_000, w)
        // No transcript: the Board reads no conversation, and the route says so.
        await lifeUntil('no conversation on the Board', async () => (await hostedOf(h, w, marker))?.resume === 'no conversation', 15_000, w)
        expect(await postAction(h, 'resume-session', { repoId, marker })).toEqual({ status: 409, body: { error: "can't resume: no conversation" } })
        await openTerminalTab(h, w, repoId)
        const bar = h.page.locator('.stop-bar')
        await lifeUntil("Can't resume on the stop bar", async () => (await bar.locator('.status').innerText()) === "Can't resume", 15_000, w)
        expect(await bar.innerText()).toContain('The session file is gone.')
        expect(await bar.getByRole('button').allInnerTexts()).toEqual(['Dismiss'])
        expect(lifeStarts(w)).toHaveLength(1)
      }),
    )
  }, RUN_MS)

  test.runIf(LINUX)('host banner', async () => {
    await inWorld((w) =>
      withApp(w, async (h) => {
        await lifeUntil('the test hook', () => testHooks(h).ready(), 60_000, w)
        await lifeUntil('the host', async () => ((await testHooks(h).hostPid()) ?? 0) > 0, 30_000, w)
        const host = (await testHooks(h).hostPid())!
        const banner = h.page.locator('.host-banner')
        expect(await banner.count()).toBe(0)
        process.kill(host, 'SIGSTOP')
        try {
          // The starter calls the host unresponsive after 11 s with no beat.
          await lifeUntil('the banner', async () => (await banner.count()) === 1 && (await banner.isVisible()), 30_000, w)
          expect(await banner.innerText()).toContain('Terminals are not responding.')
          expect(await banner.innerText()).toContain('Your sessions may still run. The app keeps trying.')
        } finally {
          process.kill(host, 'SIGCONT')
        }
        await lifeUntil('the banner gone', async () => (await banner.count()) === 0, 30_000, w)
        expect(await testHooks(h).hostPid()).toBe(host)
      }),
    )
  }, RUN_MS)
})
