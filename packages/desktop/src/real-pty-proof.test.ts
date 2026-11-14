import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { StartSpec } from '@openaflow/pty-host/protocol'
import { launchHarness, packagedApp } from '../test/electron-harness.ts'
import type { TestTerminals } from './test-hooks-main.ts'

// node-pty in the real Electron app: the pty host's utilityProcess loads it, starts a program in a pty, and its
// screen comes back through the test hook. With OPENAFLOW_PACKAGED_APP, the same check runs on a
// `pnpm package --test-hooks` build. `pnpm test:electron real-pty-proof` runs this after `pnpm build`.

const WIN = process.platform === 'win32'
const RUN_MS = 180_000
const MODE = packagedApp() === undefined ? 'unpackaged' : 'packaged'

type Hooked = typeof globalThis & { __openaflowTest?: { terminals?: TestTerminals } }

describe.runIf(process.env.OPENAFLOW_REAL_ELECTRON === '1' && (process.platform === 'linux' || WIN))(`real pty proof (${MODE})`, () => {
  test('node-pty runs in the Electron app', async () => {
    const h = await launchHarness()
    try {
      const health = await fetch(`http://127.0.0.1:${h.port}/api/health`)
      expect(await health.json()).toEqual({ ok: true })

      // The hook appears once the host is forked, after the server's ready.
      const until = Date.now() + 60_000
      while (!(await h.app.evaluate(() => (globalThis as Hooked).__openaflowTest?.terminals !== undefined))) {
        if (Date.now() > until) throw new Error('no test hook: is this a --test-hooks build?')
        await new Promise((r) => setTimeout(r, 100))
      }

      // The word comes from the env, so the screen shows the program's output, not its command line.
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const spec: StartSpec = WIN
        ? { id: 'proof-1', program: join(systemRoot, 'System32', 'cmd.exe'), args: ['/d', '/c', 'echo pty-proof-%PROOF_WORD%'], cwd: tmpdir(), env: { SystemRoot: systemRoot, PROOF_WORD: 'works' }, cols: 80, rows: 24 }
        : { id: 'proof-1', program: '/bin/sh', args: ['-c', 'echo "pty-proof-$PROOF_WORD"'], cwd: tmpdir(), env: { PATH: '/usr/bin:/bin', PROOF_WORD: 'works' }, cols: 80, rows: 24 }
      const { pid } = await h.app.evaluate((_e, s) => (globalThis as Hooked).__openaflowTest!.terminals!.start(s), spec)
      expect(pid).toBeGreaterThan(0)

      let text: string | null = null
      const end = Date.now() + 30_000
      while (!text?.includes('pty-proof-works')) {
        if (Date.now() > end) throw new Error(`no output on the screen: ${JSON.stringify(text)}`)
        await new Promise((r) => setTimeout(r, 200))
        text = await h.app.evaluate((_e, id) => (globalThis as Hooked).__openaflowTest!.terminals!.snapshot(id), spec.id)
      }
      expect(text).toContain('pty-proof-works')

      // The host is its own process, not the main one.
      const hostPid = await h.app.evaluate(() => (globalThis as Hooked).__openaflowTest!.terminals!.hostPid())
      expect(hostPid).toBeGreaterThan(0)
      expect(hostPid).not.toBe(h.app.process().pid)
    } finally {
      await h.close()
    }
  }, RUN_MS)
})
