import { existsSync, readFileSync } from 'node:fs'
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
  test('verify stays free of packaging', () => {
    const steps = ci().jobs?.verify?.steps ?? []
    const install = steps.find((s) => /pnpm install/.test(s.run ?? ''))
    expect(install?.env?.ELECTRON_SKIP_BINARY_DOWNLOAD).toBe('1')
    expect(steps.some((s) => s.run === 'pnpm verify')).toBe(true)
    expect(steps.filter((s) => /package|test:install|release:check|electron-builder/.test(s.run ?? ''))).toEqual([])
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts.verify).not.toMatch(/package|test:install|release:check/)
  })

  test('verify on both systems', () => {
    const flow = ci()
    // Today's triggers: every pull request, and a push to pod-staging.
    expect(Object.keys(flow.on ?? {}).sort()).toEqual(['pull_request', 'push'])
    expect(flow.on?.push).toEqual({ branches: ['pod-staging'] })
    const job = flow.jobs?.verify
    // The Windows check keeps its name, so a required check on the branch still finds it.
    expect(job?.name).toBe('verify (${{ matrix.os }})')
    expect(job?.['runs-on']).toBe('${{ matrix.os }}')
    expect(job?.strategy?.['fail-fast']).toBe(false)
    expect(job?.strategy?.matrix?.os).toEqual(['windows-latest', 'ubuntu-latest'])
    const steps = job?.steps ?? []
    // Only pnpm verify: no display, no Electron binary, no sysctl.
    expect(steps.filter((s) => s.run !== undefined).map((s) => s.run)).toEqual(['pnpm install --frozen-lockfile', 'pnpm verify'])
    expect(steps.filter((s) => s.if !== undefined)).toEqual([])
  })

  test('pty proof jobs', () => {
    const flow = ci()
    // Today's triggers: every pull request, and a push to pod-staging.
    expect(Object.keys(flow.on ?? {}).sort()).toEqual(['pull_request', 'push'])
    expect(flow.on?.push).toEqual({ branches: ['pod-staging'] })

    const job = flow.jobs?.['pty-proof']
    expect(job?.name).toBe('pty proof (${{ matrix.os }})')
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

    const unpackaged = steps[at(/test:electron real-pty-proof/, false)]
    const packaged = steps[at(/test:electron real-pty-proof/, true)]
    for (const step of [unpackaged, packaged]) expect(step?.run).toBe('${{ matrix.display }} pnpm test:electron real-pty-proof')
    expect(packaged?.env?.OPENAFLOW_PACKAGED_APP).toBe('${{ github.workspace }}/${{ matrix.app }}')

    const order = [at(/pnpm install/), at(/electron\/install\.js/), at(/^pnpm build$/), at(/real-pty-proof/, false), at(/^pnpm package --test-hooks$/), at(/real-pty-proof/, true)]
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(at(/sysctl/)).toBeLessThan(at(/real-pty-proof/, false))

    // A test-hooks build never leaves the runner.
    expect(steps.filter((s) => /upload-artifact|release:check|gh release/.test(`${s.uses ?? ''} ${s.run ?? ''}`))).toEqual([])
  })
})
