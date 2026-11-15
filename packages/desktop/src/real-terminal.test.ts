import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { describe, expect, test } from 'vitest'
import type { HostToWindow, StartSpec } from '@openaflow/pty-host/protocol'
import { DESKTOP, launchHarness, packagedApp, type Harness } from '../test/electron-harness.ts'
import type { TestTerminals } from './test-hooks-main.ts'

// The terminal from a window's side, in the real Electron app. Sessions start through the test hook with
// test/fixtures/numbered.mjs. The page's code below connects with `window.openaflow.connectTerminals()`, takes the
// port, sends `resize` then `attach`, and acks each `data`. What the window got is drawn in a headless terminal
// here, as the page's terminal would draw it. With OPENAFLOW_PACKAGED_APP, only `packaged` runs, on that build.
// `pnpm test:electron real-terminal` runs this after `pnpm build`. The rules are in pod-docs/sprints/host-core.md.

const WIN = process.platform === 'win32'
const PACKAGED = packagedApp() !== undefined
const RUN_MS = 180_000
const FIXTURE = join(DESKTOP, 'test', 'fixtures', 'numbered.mjs')
/** One size for every session and window here, so a replay draws the same as the live stream. */
const SIZE = { cols: 100, rows: 30 }

type Hooked = typeof globalThis & { __openaflowTest?: { terminals?: TestTerminals } }
/** One message as the page got it, with the page's clock. */
type Got = HostToWindow & { at: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const spec = (id: string): StartSpec => ({
  id,
  program: process.execPath,
  args: [FIXTURE],
  cwd: tmpdir(),
  env: WIN ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : { PATH: '/usr/bin:/bin' },
  ...SIZE,
})

// --- The app's side, through the test hook ---

const hooks = (h: Harness) => ({
  start: (s: StartSpec) => h.app.evaluate((_e, s) => (globalThis as Hooked).__openaflowTest!.terminals!.start(s), s),
  list: () => h.app.evaluate(() => (globalThis as Hooked).__openaflowTest!.terminals!.list()),
  kill: (id: string) => h.app.evaluate((_e, id) => (globalThis as Hooked).__openaflowTest!.terminals!.kill(id), id),
  snapshot: (id: string) => h.app.evaluate((_e, id) => (globalThis as Hooked).__openaflowTest!.terminals!.snapshot(id), id),
  hostPid: () => h.app.evaluate(() => (globalThis as Hooked).__openaflowTest!.terminals!.hostPid()),
})

const desktopLog = (h: Harness) => {
  const file = join(h.dir, 'shell', 'desktop.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** Every failed wait shows the log and what the page got, so one CI run shows the whole picture. */
async function until(what: string, ok: () => boolean | Promise<boolean>, ms: number, h: Harness, page?: Page): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    if (await ok()) return
    if (Date.now() > end) {
      const got = page ? await pageGot(page).catch((err: unknown) => `(no page messages: ${String(err)})`) : '(no page)'
      throw new Error(`timed out waiting for ${what}\npage got: ${JSON.stringify(got).slice(-4_000)}\ndesktop.log:\n${desktopLog(h)}`)
    }
    await sleep(100)
  }
}

/** Waits for the hook, then starts a session. Records its pid so a lost session can be ended by its own ID. */
async function startSession(h: Harness, id: string, pids: number[]): Promise<number> {
  await until('the test hook (is this a --test-hooks build?)', () => h.app.evaluate(() => (globalThis as Hooked).__openaflowTest?.terminals !== undefined), 60_000, h)
  const { pid } = await hooks(h).start(spec(id))
  pids.push(pid)
  return pid
}

const endPids = (pids: number[]) => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

// --- The window's side: plain page code, as the Terminal tab will do it ---

type PageTerm = { got: Got[]; states: string[]; port?: MessagePort }
type PageWindow = Window & {
  __term?: PageTerm
  openaflow: { connectTerminals(): Promise<void>; onTerminalHost(fn: (state: string) => void): () => void }
}

/** Runs in the page. Takes a port, then sends `resize` before `attach` (the replay is drawn at the current size). */
const pageConnect = async (a: { id?: string; cols: number; rows: number }) => {
  const w = window as unknown as PageWindow
  if (w.__term === undefined) {
    const term: PageTerm = { got: [], states: [] }
    w.__term = term
    w.openaflow.onTerminalHost((state) => term.states.push(state))
  }
  const term = w.__term
  // Set before the call: the port's message comes before the call resolves.
  const port = new Promise<MessagePort>((resolve) => {
    const on = (e: MessageEvent) => {
      if ((e.data as { type?: unknown } | null)?.type !== 'openaflow:terminal-port') return
      w.removeEventListener('message', on)
      resolve(e.ports[0]!)
    }
    w.addEventListener('message', on)
  })
  await w.openaflow.connectTerminals()
  const p = await port
  p.onmessage = (e: MessageEvent) => {
    const m = e.data as HostToWindow
    term.got.push({ ...m, at: Date.now() })
    // Only `data` counts toward the host's unacked total; a `replay` never does.
    if (m.type === 'data') p.postMessage({ type: 'ack', id: m.id, chars: m.data.length })
  }
  term.port = p
  if (a.id !== undefined) {
    p.postMessage({ type: 'resize', id: a.id, cols: a.cols, rows: a.rows })
    p.postMessage({ type: 'attach', id: a.id })
  }
}

/** Connects the page and attaches to `id`. Retries while a load replaces the page's world. */
async function connect(page: Page, id?: string): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await page.waitForLoadState('domcontentloaded')
      // A new page world has no `__term`, so the old one's messages are gone with it.
      await page.evaluate(pageConnect, { id, ...SIZE })
      return
    } catch (err) {
      if (tries >= 5 || !/context was destroyed|navigat|Target closed|has been closed/i.test(String(err))) throw err
      await sleep(500)
    }
  }
}

const pageGot = (page: Page) => page.evaluate(() => (window as unknown as PageWindow).__term?.got ?? [])
const pageStates = (page: Page) => page.evaluate(() => (window as unknown as PageWindow).__term?.states ?? [])
const pagePost = (page: Page, m: unknown) => page.evaluate((m) => (window as unknown as PageWindow).__term!.port!.postMessage(m), m)

// --- Drawing what the window got ---

type HeadlessTerminal = {
  write(data: string, done: () => void): void
  buffer: { active: { length: number; getLine(y: number): { translateToString(trimRight: boolean): string } | undefined } }
  dispose(): void
}
// The host's own headless terminal: the desktop package bundles no xterm of its own.
const { Terminal } = createRequire(join(DESKTOP, '..', 'pty-host', 'package.json'))('@xterm/headless') as {
  Terminal: new (o: { cols: number; rows: number; scrollback: number; allowProposedApi: boolean }) => HeadlessTerminal
}

/** The window's screen and scrollback after its `replay` and `data`, in order, as plain lines. */
async function draw(got: Got[]): Promise<string[]> {
  const term = new Terminal({ ...SIZE, scrollback: 20_000, allowProposedApi: true })
  try {
    for (const m of got) {
      if (m.type !== 'replay' && m.type !== 'data') continue
      await new Promise<void>((done) => term.write(m.data, done))
    }
    const lines: string[] = []
    const buffer = term.buffer.active
    for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
    return lines
  } finally {
    term.dispose()
  }
}

/** The fixture's line numbers on the window's screen, top to bottom. */
const numbers = (lines: string[]) => lines.flatMap((l) => /^line (\d+)$/.exec(l.trim())?.[1] ?? []).map(Number)
const lastNumber = async (page: Page) => numbers(await draw(await pageGot(page))).at(-1) ?? 0

/** Every line from 1 shows once and in order. */
function expectEveryLineOnce(nums: number[]): void {
  expect(nums.length).toBeGreaterThan(0)
  const wrong = nums.findIndex((n, i) => n !== i + 1)
  expect(wrong, `line numbers out of order at ${wrong}: ${nums.slice(Math.max(0, wrong - 3), wrong + 3).join(', ')}`).toBe(-1)
}

/** Exactly one `replay`, and it came first. */
function expectOneReplayFirst(got: Got[]): void {
  expect(got.filter((m) => m.type === 'replay').length, JSON.stringify(got.map((m) => m.type))).toBe(1)
  expect(got[0]?.type).toBe('replay')
}

// --- The checks ---

async function echoCheck(h: Harness, pids: number[]): Promise<void> {
  const id = 'echo-1'
  await startSession(h, id, pids)
  await connect(h.page, id)
  await until('line 3 in the window', async () => (await lastNumber(h.page)) >= 3, 15_000, h, h.page)

  // The fixture answers a line it reads with `got:<line>`: the pty's own echo of the keys can't pass this.
  await pagePost(h.page, { type: 'input', id, data: 'hello-window\r' })
  await until('got:hello-window in the window', async () => (await draw(await pageGot(h.page))).some((l) => l.trim() === 'got:hello-window'), 15_000, h, h.page)

  // The kill reaches the program on every system, and the window hears its exit.
  await hooks(h).kill(id)
  await until('the exit in the window', async () => (await pageGot(h.page)).some((m) => m.type === 'exit'), 15_000, h, h.page)
  const session = (await hooks(h).list()).find((s) => s.id === id)
  expect(session?.live).toBe(false)
}

async function reloadCheck(h: Harness, pids: number[]): Promise<void> {
  const id = 'reload-1'
  await startSession(h, id, pids)
  await connect(h.page, id)
  await until('line 10 in the window', async () => (await lastNumber(h.page)) >= 10, 15_000, h, h.page)
  const before = await lastNumber(h.page)

  await h.page.reload()
  await connect(h.page, id)
  // Lines go on: the program ran through the reload, and the window gets them live.
  await until(`a line past ${before + 10}`, async () => (await lastNumber(h.page)) > before + 10, 15_000, h, h.page)
  const got = await pageGot(h.page)
  expectOneReplayFirst(got)
  expectEveryLineOnce(numbers(await draw(got)))
}

describe.runIf(process.env.OPENAFLOW_REAL_ELECTRON === '1' && (process.platform === 'linux' || WIN))(`real terminal (${PACKAGED ? 'packaged' : 'unpackaged'})`, () => {
  test.runIf(!PACKAGED)('input from the window echoes back', async () => {
    const pids: number[] = []
    const h = await launchHarness()
    try {
      expect(await h.app.evaluate(({ app }) => app.isPackaged)).toBe(false)
      await echoCheck(h, pids)
    } finally {
      await h.close()
      endPids(pids)
    }
  }, RUN_MS)

  test.runIf(!PACKAGED)('a reload replays once and in order', async () => {
    const pids: number[] = []
    const h = await launchHarness()
    try {
      await reloadCheck(h, pids)
    } finally {
      await h.close()
      endPids(pids)
    }
  }, RUN_MS)

  test.runIf(PACKAGED)('packaged', async () => {
    const pids: number[] = []
    const h = await launchHarness()
    try {
      // The packaged build answers, not Electron's own binary on the bundles.
      expect(await h.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
      await echoCheck(h, pids)
      await reloadCheck(h, pids)
    } finally {
      await h.close()
      endPids(pids)
    }
  }, RUN_MS)
})
