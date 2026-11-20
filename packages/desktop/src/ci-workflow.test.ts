import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (name: string) => {
  const file = join(ROOT, '.github', 'workflows', name)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

type Step = { name?: string; uses?: string; run?: string; if?: string; shell?: string; 'working-directory'?: string; with?: Record<string, unknown>; env?: Record<string, unknown> }
type Job = { name?: string; 'runs-on'?: string; strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> }; steps?: Step[] }
type Workflow = { on?: Record<string, { branches?: string[] } | null>; jobs?: Record<string, Job> }

const ci = () => parse(read('pod-ci.yml')) as Workflow

describe('pod-ci.yml', () => {
  test('unit stays free of packaging', () => {
    const steps = ci().jobs?.unit?.steps ?? []
    const install = steps.find((s) => /pnpm install/.test(s.run ?? ''))
    expect(install?.env?.ELECTRON_SKIP_BINARY_DOWNLOAD).toBe('1')
    expect(steps.some((s) => s.run === 'pnpm verify')).toBe(true)
    expect(steps.filter((s) => /package|test:install|release:check|electron-builder/.test(s.run ?? ''))).toEqual([])
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts.verify).not.toMatch(/package|test:install|release:check/)
  })

  test('unit on both systems', () => {
    const flow = ci()
    // CI runs on PRs into pod-staging or main (the sprint-end check, the final plan PR, the staging PR) and on a
    // push to pod-staging; a wave PR into the plan branch runs none (pod-docs/decisions.md, 2026-11-17).
    expect(Object.keys(flow.on ?? {}).sort()).toEqual(['pull_request', 'push'])
    expect(flow.on?.pull_request).toEqual({ branches: ['pod-staging', 'main'] })
    expect(flow.on?.push).toEqual({ branches: ['pod-staging'] })
    const job = flow.jobs?.unit
    expect(job?.name).toBe('unit (${{ matrix.os }})')
    expect(job?.['runs-on']).toBe('${{ matrix.os }}')
    expect(job?.strategy?.['fail-fast']).toBe(false)
    expect(job?.strategy?.matrix?.os).toEqual(['windows-latest', 'ubuntu-latest'])
    const steps = job?.steps ?? []
    // Only pnpm verify: no display, no Electron binary, no sysctl.
    expect(steps.filter((s) => s.run !== undefined).map((s) => s.run)).toEqual(['pnpm install --frozen-lockfile', 'pnpm verify'])
    expect(steps.filter((s) => s.if !== undefined)).toEqual([])
  })

  test('e2e jobs', () => {
    const flow = ci()
    // CI runs on PRs into pod-staging or main (the sprint-end check, the final plan PR, the staging PR) and on a
    // push to pod-staging; a wave PR into the plan branch runs none (pod-docs/decisions.md, 2026-11-17).
    expect(Object.keys(flow.on ?? {}).sort()).toEqual(['pull_request', 'push'])
    expect(flow.on?.pull_request).toEqual({ branches: ['pod-staging', 'main'] })
    expect(flow.on?.push).toEqual({ branches: ['pod-staging'] })
    // The e2e jobs took over the pty proof's.
    expect(flow.jobs?.['pty-proof']).toBeUndefined()

    const job = flow.jobs?.e2e
    expect(job?.name).toBe('e2e (${{ matrix.os }})')
    expect(job?.['runs-on']).toBe('${{ matrix.os }}')
    expect(job?.strategy?.['fail-fast']).toBe(false)
    const include = (job?.strategy?.matrix?.include ?? []) as { os: string; display: string; app: string }[]
    expect(include.map((m) => m.os)).toEqual(['windows-latest', 'ubuntu-latest'])
    const windows = include.find((m) => m.os === 'windows-latest')!
    const ubuntu = include.find((m) => m.os === 'ubuntu-latest')!
    expect(windows.display).toBe('')
    expect(ubuntu.display).toBe('xvfb-run -a')
    expect(windows.app.replaceAll('\\', '/')).toBe('packages/desktop/release/win-unpacked/OpenAFlow.exe')
    expect(ubuntu.app).toBe('packages/desktop/release/linux-unpacked/openaflow')

    const steps = job?.steps ?? []
    const at = (pattern: RegExp, packaged?: boolean) =>
      steps.findIndex((s) => pattern.test(s.run ?? '') && (packaged === undefined || (s.env?.OPENAFLOW_PACKAGED_APP !== undefined) === packaged))
    const install = steps[at(/pnpm install --frozen-lockfile/)]
    // This job needs Electron's binary, which pnpm's skipped install script would fetch.
    expect(install?.env?.ELECTRON_SKIP_BINARY_DOWNLOAD).toBeUndefined()
    const electron = steps[at(/node node_modules\/electron\/install\.js/)]
    expect(electron?.['working-directory']).toBe('packages/desktop')
    const sysctl = steps[at(/sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/)]
    expect(sysctl?.if).toBe("runner.os == 'Linux'")

    // One file a step: vitest runs files side by side, and three Electron apps at once make the timings flaky.
    // real-start runs Electron's own binary on dist/main.cjs, so it has no packaged run. `real-terminal.test`, since
    // `pnpm test:electron` runs every file whose name holds the word, and `real-terminal` is in `real-terminal-tab`.
    // real-quit and real-resume (session-life §10): both unpackaged, then real-resume on the packaged build too.
    // real-folder-bridge and real-settings (settings §9): unpackaged only.
    const unpackaged = ['real-start', 'real-pty-proof', 'real-terminal.test', 'real-session', 'real-terminal-tab', 'real-quit', 'real-resume', 'real-folder-bridge', 'real-settings'].map((name) => at(new RegExp(`test:electron ${name}$`), false))
    const packaged = ['real-pty-proof', 'real-terminal.test', 'real-session', 'real-resume'].map((name) => at(new RegExp(`test:electron ${name}$`), true))
    expect([...unpackaged, ...packaged].every((i) => i >= 0), JSON.stringify({ unpackaged, packaged })).toBe(true)
    expect(at(/test:electron real-start/, true)).toBe(-1)
    expect(at(/test:electron real-terminal-tab/, true)).toBe(-1)
    expect(at(/test:electron real-quit/, true)).toBe(-1)
    expect(at(/test:electron real-folder-bridge/, true)).toBe(-1)
    expect(at(/test:electron real-settings/, true)).toBe(-1)
    for (const i of [...unpackaged, ...packaged]) expect(steps[i]?.run).toMatch(/^\$\{\{ matrix\.display \}\} pnpm test:electron real-[a-z-]+(\.test)?$/)
    // Each step's name picks exactly one file.
    const files = new Set(readdirSync(join(ROOT, 'packages', 'desktop', 'src')).filter((f) => /^real-.*\.test\.ts$/.test(f)))
    for (const s of steps) {
      const name = /test:electron (\S+)$/.exec(s.run ?? '')?.[1]
      if (name !== undefined) expect([...files].filter((f) => f.includes(name)), s.run).toHaveLength(1)
    }
    for (const i of packaged) expect(steps[i]?.env?.OPENAFLOW_PACKAGED_APP).toBe('${{ github.workspace }}/${{ matrix.app }}')
    // Only the named files: `pnpm test:electron` with no name would also run the Windows-only proofs.
    expect(steps.filter((s) => /test:electron\s*$/.test(s.run ?? ''))).toEqual([])

    const order = [at(/pnpm install/), at(/electron\/install\.js/), at(/^pnpm build$/), ...unpackaged, at(/^pnpm package --test-hooks$/), ...packaged]
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(at(/sysctl/)).toBeLessThan(Math.min(...unpackaged))

    // A test-hooks build never leaves the runner.
    expect(steps.filter((s) => /upload-artifact|release:check|gh release/.test(`${s.uses ?? ''} ${s.run ?? ''}`))).toEqual([])
  })
})
