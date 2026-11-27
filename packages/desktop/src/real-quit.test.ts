import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test, type TestContext } from 'vitest'
import {
  alive,
  desktopLog,
  endLifeProcesses,
  healthy,
  hostedOf,
  launchLife,
  LIFE_SIZE,
  lifeChildren,
  lifeChildrenUp,
  lifeDetails,
  lifeRepo,
  lifeSession,
  lifeStarts,
  lifeUntil,
  makeLifeWorld,
  packagedApp,
  portOpen,
  postAction,
  removeWithRetry,
  sleep,
  testHooks,
  type Harness,
  type LifeChild,
  type LifeWorld,
} from '../test/electron-harness.ts'

// The quit and the session ender in the real Electron app (sprint session-life §7, §8, §10): sessions start through
// the New session route with test/fixtures/life-claude.mjs as `claude`, which on request starts a detached child, and
// on Linux an env-cleared `setsid` child, each listening on 127.0.0.1. A test-hooks build never opens the native
// quit box: it answers `end`, or `cancel` once after `quit.answer('cancel')`. Unpackaged only. Temp folders only;
// never the real `claude`. `pnpm test:electron real-quit` runs this after `pnpm build`.

const WIN = process.platform === 'win32'
const LINUX = process.platform === 'linux'
const PACKAGED = packagedApp() !== undefined
const RUN_MS = 240_000
/** §10: a confirmed quit leaves nothing within 10 s. */
const GONE_MS = 10_000
/** A forced end of main also ends the server. Under Electron it ends with main; the parent watch (2 s polls) is the backup. */
const SERVER_AFTER_MAIN_MS = 15_000

/** Each pid gone and each child's port closed. */
const allGone = async (pids: number[], children: LifeChild[]) => pids.every((p) => !alive(p)) && (await Promise.all(children.map((c) => portOpen(c.port)))).every((open) => !open)

/** What still runs, for a failed check. */
const leftovers = async (pids: number[], children: LifeChild[]) =>
  JSON.stringify({ alive: pids.filter(alive), openPorts: (await Promise.all(children.map(async (c) => ((await portOpen(c.port)) ? c.port : 0)))).filter(Boolean) })

/** `/proc/<pid>/stat`'s ppid and process group (Linux). */
const procStat = (pid: number) => {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ')
  return { ppid: Number(rest[1]), pgid: Number(rest[2]) }
}

/**
 * Windows: waits until the session joined its job, so children start inside it. A child chain that ends before the
 * job's first walk can't be found by parent pid (pod-docs/handoff-queue.md, 2026-11-15, W1-fix); these cases test the
 * steady state.
 */
const sessionInJob = async (w: LifeWorld) => {
  if (WIN) await lifeUntil('the session in its job', async () => /session \S+ in a job after/.test(desktopLog(w)), 15_000, w)
}

/** Windows: how many conhost.exe processes `pid` owns, so how many consoles of its own it has. */
const ownConsoles = (pid: number) => {
  const query = `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid} and Name="conhost.exe"').Count`
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true })
  return Number(out.stdout.trim())
}

/**
 * Windows: each child's spawn time and main's job lines, printed after every test that ran a session, green or red, so
 * a run shows whether a child started before its session joined the job.
 */
function printJobLines(name: string, w: LifeWorld): void {
  if (!WIN) return
  const children = lifeChildren(w).map((c) => `${c.kind} child ${c.pid} spawned ${c.spawnedAt ? new Date(c.spawnedAt).toISOString() : '?'}`)
  if (children.length === 0) return
  const lines = desktopLog(w)
    .split('\n')
    .filter((l) => /\bjob\b|left \d+ processes|end failed/.test(l))
  process.stderr.write(`real-quit › ${name}: ${[...children, ...lines].join('\n  ')}\n`)
}

/** Runs `check` on a new world, and always ends the app, the fake's processes, and the folders. */
async function inWorld(ctx: TestContext, check: (w: LifeWorld) => Promise<void>): Promise<void> {
  const w = makeLifeWorld()
  try {
    await check(w)
  } finally {
    printJobLines(ctx.task.name, w)
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

describe.runIf(process.env.OPENAFLOW_REAL_ELECTRON === '1' && !PACKAGED && (LINUX || WIN))('real quit (unpackaged)', () => {
  test('no session, no question', async (ctx) => {
    await inWorld(ctx, (w) =>
      withApp(w, async (h) => {
        await lifeUntil('the repo on the Board', async () => (await lifeRepo(h, w)) !== undefined, 60_000, w)
        await lifeUntil('the test hook', () => testHooks(h).ready(), 60_000, w)
        await testHooks(h).quit()
        await lifeUntil('the app to quit', () => h.exited(), 15_000, w)
        expect(desktopLog(w)).not.toContain('quit asked about')
      }),
    )
  }, RUN_MS)

  test('cancel keeps everything', async (ctx) => {
    await inWorld(ctx, (w) =>
      withApp(w, async (h) => {
        const { marker } = await lifeSession(h, w)
        const [child] = await lifeChildrenUp(w, ['detached'])
        const fake = lifeStarts(w)[0]!.pid
        // The child runs before the quit, so a later end is the quit's.
        await sleep(2_000)
        expect(alive(child!.pid) && (await portOpen(child!.port)), `the child before the quit\n${await leftovers([fake, child!.pid], [child!])}\n${lifeDetails(w)}`).toBe(true)
        await testHooks(h).quitAnswer('cancel')
        await testHooks(h).quit()
        await lifeUntil('the quit answered cancel', () => desktopLog(w).includes('quit asked about 1 sessions: cancel'), 15_000, w)
        // Time for a wrong end to land.
        await sleep(3_000)
        expect(h.exited()).toBe(false)
        expect(await healthy(h)).toBe(true)
        expect(await hostedOf(h, w, marker), lifeDetails(w)).toMatchObject({ state: 'live' })
        const state = `${await leftovers([fake, child!.pid], [child!])}\n${lifeDetails(w)}`
        expect(alive(fake), `the fake\n${state}`).toBe(true)
        expect(alive(child!.pid), `the child\n${state}`).toBe(true)
        expect(await portOpen(child!.port), `the child's port\n${state}`).toBe(true)
      }),
    )
  }, RUN_MS)

  test('quit ends the session tree', async (ctx) => {
    await inWorld(ctx, (w) =>
      withApp(w, async (h) => {
        const { marker } = await lifeSession(h, w)
        const children = await lifeChildrenUp(w, ['detached'])
        const pids = [lifeStarts(w)[0]!.pid, ...children.map((c) => c.pid)]
        const at = Date.now()
        await testHooks(h).quit()
        await lifeUntil('the quit answered end', () => desktopLog(w).includes('quit asked about 1 sessions: end'), GONE_MS, w)
        await lifeUntil('no fake, no child, no open port', () => allGone(pids, children), Math.max(0, at + GONE_MS - Date.now()), w)
        // The host saved the screen before it ended the pty: the fake's own output.
        const screen = join(w.cfg, 'screens', `${marker}.txt`)
        await lifeUntil('the screen file', () => existsSync(screen), 15_000, w)
        expect(readFileSync(screen, 'utf8')).toContain('life-claude args:')
      }),
    )
  }, RUN_MS)

  test('quit ends an orphan', async (ctx) => {
    await inWorld(ctx, (w) =>
      withApp(w, async (h) => {
        await lifeSession(h, w)
        await sessionInJob(w)
        // The fake's child starts a grandchild, then ends: the grandchild runs on with no parent.
        const [orphan] = await lifeChildrenUp(w, ['orphan'])
        const middle = orphan!.ppid!
        expect(middle, JSON.stringify(orphan)).toBeGreaterThan(0)
        await lifeUntil('the middle child ended', async () => !alive(middle), 15_000, w)
        const fake = lifeStarts(w)[0]!.pid
        const pids = [fake, orphan!.pid]
        expect(alive(orphan!.pid) && (await portOpen(orphan!.port)), `the orphan before the quit\n${await leftovers(pids, [orphan!])}`).toBe(true)
        const at = Date.now()
        await testHooks(h).quit()
        await lifeUntil('the quit answered end', () => desktopLog(w).includes('quit asked about 1 sessions: end'), GONE_MS, w)
        await lifeUntil('no fake, no orphan, no open port', () => allGone(pids, [orphan!]), Math.max(0, at + GONE_MS - Date.now()), w).catch(async (err: Error) => {
          throw new Error(`${err.message}\nleft: ${await leftovers(pids, [orphan!])}`)
        })
      }),
    )
  }, RUN_MS)

  test('quit ends a child with its own console', async (ctx) => {
    if (!WIN) {
      process.stderr.write(`real-quit › own console: skipped, a new console window is Windows only (${process.platform})\n`)
      ctx.skip()
      return
    }
    await inWorld(ctx, (w) =>
      withApp(w, async (h) => {
        await lifeSession(h, w)
        await sessionInJob(w)
        const [child] = await lifeChildrenUp(w, ['console'])
        // Its own console: a conhost.exe whose parent is the child. A `detached` child has none.
        expect(ownConsoles(child!.pid), JSON.stringify(child)).toBeGreaterThan(0)
        const fake = lifeStarts(w)[0]!.pid
        const pids = [fake, child!.pid]
        const at = Date.now()
        await testHooks(h).quit()
        await lifeUntil('the quit answered end', () => desktopLog(w).includes('quit asked about 1 sessions: end'), GONE_MS, w)
        await lifeUntil('no fake, no console child, no open port', () => allGone(pids, [child!]), Math.max(0, at + GONE_MS - Date.now()), w).catch(async (err: Error) => {
          throw new Error(`${err.message}\nleft: ${await leftovers(pids, [child!])}`)
        })
      }),
    )
  }, RUN_MS)

  test('scope', async (ctx) => {
    const { skip } = ctx
    if (!LINUX) {
      process.stderr.write(`real-quit › scope: skipped, no systemd scope on ${process.platform}\n`)
      skip()
      return
    }
    await inWorld(ctx, (w) =>
      withApp(w, async (h) => {
        const { marker } = await lifeSession(h, w)
        const cgroup = lifeStarts(w)[0]!.cgroup ?? ''
        const unit = `openaflow-run-${marker}.scope`
        if (!cgroup.includes(unit)) {
          const line = /sessions run with no systemd scope: .*/.exec(desktopLog(w))?.[0]
          process.stderr.write(`real-quit › scope: skipped, the session is not in ${unit} (${line ?? `cgroup ${cgroup.trim() || 'unknown'}`})\n`)
          skip()
          return
        }
        const children = await lifeChildrenUp(w, ['detached', 'setsid'])
        const fake = lifeStarts(w)[0]!.pid
        const loose = children.find((c) => c.kind === 'setsid')!
        // Outside everything but the scope: not the fake's child, not in its group, and no OPENAFLOW_RUN.
        const stat = procStat(loose.pid)
        expect(stat.ppid).not.toBe(fake)
        expect(stat.pgid).not.toBe(procStat(fake).pgid)
        expect(readFileSync(`/proc/${loose.pid}/environ`, 'utf8')).not.toContain('OPENAFLOW_RUN=')
        expect(readFileSync(`/proc/${loose.pid}/cgroup`, 'utf8')).toContain(unit)

        const pids = [fake, ...children.map((c) => c.pid)]
        const at = Date.now()
        await testHooks(h).quit()
        await lifeUntil('the scope ended', () => allGone(pids, children), at + GONE_MS - Date.now(), w).catch(async (err: Error) => {
          throw new Error(`${err.message}\nleft: ${await leftovers(pids, children)}`)
        })
      }),
    )
  }, RUN_MS)

  test('host crash leftovers', async (ctx) => {
    await inWorld(ctx, (w) =>
      withApp(w, async (h) => {
        await lifeSession(h, w)
        const children = await lifeChildrenUp(w, ['detached'])
        const host = await testHooks(h).hostPid()
        expect(host).toBeGreaterThan(0)
        const at = Date.now()
        process.kill(host!, 'SIGKILL')
        await lifeUntil('the leftover child ended', () => allGone(children.map((c) => c.pid), children), at + GONE_MS - Date.now(), w)
        expect(await healthy(h)).toBe(true)
      }),
    )
  }, RUN_MS)

  test('host crash before the job', async (ctx) => {
    await inWorld(ctx, (w) =>
      withApp(w, async (h) => {
        await lifeUntil('the repo on the Board', async () => (await lifeRepo(h, w)) !== undefined, 60_000, w)
        await lifeUntil('the test hook', () => testHooks(h).ready(), 60_000, w)
        const host = await testHooks(h).hostPid()
        expect(host).toBeGreaterThan(0)
        // The fake starts its child first thing, and the crash comes as soon as the child is up. On Windows the
        // program then ends before the job helper's first assign (about 0.4 s), as in CI run 43779514743.
        writeFileSync(join(w.bin, 'early-gate'), JSON.stringify(['detached']))
        const answer = await postAction(h, 'new-session', { repoId: (await lifeRepo(h, w))!.id, skill: 'plain', text: '', ...LIFE_SIZE })
        expect(answer.status, JSON.stringify(answer)).toBe(200)
        const until = Date.now() + 15_000
        while (lifeChildren(w).length === 0) {
          if (Date.now() > until) throw new Error(`timed out waiting for the early child\n${lifeDetails(w)}`)
          await sleep(10)
        }
        const at = Date.now()
        process.kill(host!, 'SIGKILL')
        const children = lifeChildren(w)
        const pids = children.map((c) => c.pid)
        await lifeUntil('the leftover child ended', () => allGone(pids, children), at + GONE_MS - Date.now(), w).catch(async (err: Error) => {
          throw new Error(`${err.message}\nleft: ${await leftovers(pids, children)}`)
        })
        expect(await healthy(h)).toBe(true)
      }),
    )
  }, RUN_MS)

  test('app crash leftovers', async (ctx) => {
    await inWorld(ctx, async (w) => {
      let marker = ''
      let children: LifeChild[] = []
      await withApp(w, async (h) => {
        ;({ marker } = await lifeSession(h, w))
        children = await lifeChildrenUp(w, ['detached'])
        const owner = join(w.cfg, 'auto-continue-owner.json')
        await lifeUntil('the owner file', () => existsSync(owner), 15_000, w)
        const server = (JSON.parse(readFileSync(owner, 'utf8')) as { pid: number }).pid
        // Main's own pid, not Playwright's cmd.exe wrapper on Windows.
        const main = h.pid
        process.kill(main, 'SIGKILL')
        await lifeUntil('main gone', () => !alive(main), 20_000, w)
        const until = Date.now() + SERVER_AFTER_MAIN_MS
        while (alive(server) && Date.now() < until) await sleep(200)
        const serverOutlived = alive(server)
        if (serverOutlived) {
          // End it by its pid, so a failed check leaves no server holding the port and the owner file.
          try {
            process.kill(server, 'SIGKILL')
          } catch {
            // Gone meanwhile.
          }
        }
        expect(serverOutlived, `the server (pid ${server}) still ran ${SERVER_AFTER_MAIN_MS / 1000} s after main ended`).toBe(false)
      })
      // On Linux the detached child outlives the crash: the next start must end it. (On Windows main's job handle
      // may take it down with the app.)
      if (LINUX) expect(alive(children[0]!.pid), 'the child before the next start').toBe(true)

      await withApp(w, async (h) => {
        await lifeUntil('stopped · app closed', async () => (await hostedOf(h, w, marker))?.state === 'stopped', 60_000, w)
        expect(await hostedOf(h, w, marker)).toMatchObject({ state: 'stopped', stopReason: 'app closed' })
        const pids = children.map((c) => c.pid)
        await lifeUntil('the leftover child ended', () => allGone(pids, children), 20_000, w).catch(async (err: Error) => {
          throw new Error(`${err.message}\nleft: ${await leftovers(pids, children)}`)
        })
        // Nothing started again: one start of the fake, and the new host holds no session.
        expect(lifeStarts(w)).toHaveLength(1)
        await lifeUntil('the test hook', () => testHooks(h).ready(), 60_000, w)
        expect(await testHooks(h).list()).toEqual([])
      })
    })
  }, RUN_MS)
})
