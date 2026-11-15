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

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> }
type Job = { 'runs-on'?: string; needs?: string | string[]; permissions?: Record<string, string>; env?: unknown; steps?: Step[] }
type Workflow = { name?: string; on?: Record<string, { tags?: string[]; branches?: string[] }>; permissions?: unknown; env?: unknown; jobs?: Record<string, Job> }

const text = read('release.yml')
const flow = (parse(text) ?? {}) as Workflow
const stepsOf = (job: string) => flow.jobs?.[job]?.steps ?? []
const allSteps = () => Object.keys(flow.jobs ?? {}).flatMap(stepsOf)
const indexOfRun = (steps: Step[], pattern: RegExp) => steps.findIndex((s) => pattern.test(s.run ?? ''))
const BUILDS = ['build', 'build-linux'] as const
const uploadPaths = (job: string) =>
  String(stepsOf(job).find((s) => s.uses?.startsWith('actions/upload-artifact@'))?.with?.path ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort()

/** GitHub's filter glob, as far as this file uses it: `[0-9]+` repeats and the rest is literal. */
const matchesGlob = (glob: string, ref: string) => new RegExp(`^${glob.replaceAll('.', '\\.')}$`).test(ref)

describe('release.yml', () => {
  test('runs on a version tag only', () => {
    expect(flow.name).toBe('release')
    expect(Object.keys(flow.on ?? {})).toEqual(['push'])
    expect(Object.keys(flow.on?.push ?? {})).toEqual(['tags'])
    const globs = flow.on?.push?.tags ?? []
    expect(globs).toHaveLength(1)
    const matches = (ref: string) => globs.some((glob) => matchesGlob(glob, ref))
    expect(matches('v1.2.3')).toBe(true)
    expect(matches('v10.20.30')).toBe(true)
    for (const ref of ['v1.2', 'v1.2.3-beta', 'v1.2.3.4', '1.2.3', 'vx.y.z']) expect(matches(ref), ref).toBe(false)
  })

  test('each job runs on its system, with Node 22, and pnpm from packageManager', () => {
    expect(Object.keys(flow.jobs ?? {}).sort()).toEqual(['build', 'build-linux', 'publish'])
    expect(flow.jobs?.build?.['runs-on']).toBe('windows-latest')
    expect(flow.jobs?.['build-linux']?.['runs-on']).toBe('ubuntu-latest')
    expect(flow.jobs?.publish?.['runs-on']).toBe('windows-latest')
    for (const job of BUILDS) {
      const build = stepsOf(job)
      const node = build.find((s) => s.uses?.startsWith('actions/setup-node@'))
      expect(node?.with?.['node-version'], job).toBe(22)
      const pnpm = build.find((s) => s.uses?.startsWith('pnpm/action-setup@'))
      expect(pnpm, job).toBeDefined()
      expect(pnpm?.with?.version, job).toBeUndefined()
      expect(indexOfRun(build, /pnpm install --frozen-lockfile/), job).toBeGreaterThanOrEqual(0)
    }
  })

  test('actions are pinned', () => {
    const lines = text.split('\n').filter((l) => /^\s*(?:-\s*)?uses:/.test(l))
    expect(lines.length).toBeGreaterThanOrEqual(5)
    for (const line of lines) expect(line).toMatch(/uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/)
  })

  test('no dependency cache', () => {
    for (const job of BUILDS) {
      const node = stepsOf(job).find((s) => s.uses?.startsWith('actions/setup-node@'))
      // setup-node can turn on its own cache from the packageManager field unless this is false.
      expect(node?.with?.['package-manager-cache'], job).toBe(false)
      expect(node?.with?.cache, job).toBeUndefined()
      const pnpm = stepsOf(job).find((s) => s.uses?.startsWith('pnpm/action-setup@'))
      expect(pnpm?.with?.cache ?? false, job).toBe(false)
    }
    expect(allSteps().filter((s) => s.uses?.startsWith('actions/cache'))).toEqual([])
  })

  test('checkout keeps no credentials', () => {
    for (const job of BUILDS) {
      const checkouts = stepsOf(job).filter((s) => s.uses?.startsWith('actions/checkout@'))
      expect(checkouts, job).toHaveLength(1)
      expect(checkouts[0]?.with?.['persist-credentials'], job).toBe(false)
    }
    expect(allSteps().filter((s) => s.uses?.startsWith('actions/checkout@'))).toHaveLength(2)
  })

  test('least-privilege token', () => {
    expect(flow.permissions).toEqual({})
    expect(flow.jobs?.build?.permissions).toEqual({ contents: 'read' })
    expect(flow.jobs?.['build-linux']?.permissions).toEqual({ contents: 'read' })
    expect(flow.jobs?.publish?.permissions).toEqual({ contents: 'write' })
    // The token is on one step only: the one that makes the release.
    const tokened = allSteps().filter((s) => /github\.token|secrets\./.test(JSON.stringify(s)))
    expect(tokened).toHaveLength(1)
    expect(tokened[0]?.run).toMatch(/gh release create/)
    expect(stepsOf('publish')).toContain(tokened[0])
    expect(flow.env).toBeUndefined()
    expect(flow.jobs?.publish?.env).toBeUndefined()
    expect(flow.jobs?.build?.env).toBeUndefined()
    expect(flow.jobs?.['build-linux']?.env).toBeUndefined()
  })

  test('publish waits for both checks', () => {
    expect([...(flow.jobs?.publish?.needs ?? [])].sort()).toEqual(['build', 'build-linux'])
    const steps = stepsOf('publish')
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.filter((s) => s.uses?.startsWith('actions/checkout@'))).toEqual([])
    // No code from the repo: only the download and gh itself.
    expect(steps.filter((s) => /\bpnpm\b|\bnode\b|\btsx\b/.test(s.run ?? ''))).toEqual([])
  })

  test('build checks and never publishes', () => {
    for (const job of BUILDS) expect(stepsOf(job).filter((s) => /gh release|--publish|GH_TOKEN|GITHUB_TOKEN/.test(JSON.stringify(s))), job).toEqual([])
    const build = stepsOf('build')
    const tag = indexOfRun(build, /release:check "--tag=\$env:TAG"/)
    const verify = indexOfRun(build, /^pnpm verify$/m)
    const pack = indexOfRun(build, /^pnpm package$/m)
    const check = indexOfRun(build, /^pnpm release:check packages\/desktop\/release$/m)
    const upload = build.findIndex((s) => s.uses?.startsWith('actions/upload-artifact@'))
    expect(tag).toBeGreaterThanOrEqual(0)
    expect(verify).toBeGreaterThan(tag)
    expect(pack).toBeGreaterThan(verify)
    expect(check).toBeGreaterThan(pack)
    expect(upload).toBeGreaterThan(check)
    expect(build.filter((s) => /gh release|--publish|GH_TOKEN|GITHUB_TOKEN/.test(JSON.stringify(s)))).toEqual([])
    // The tag reaches the shell through env, never pasted into a script.
    expect(build[tag]?.env?.TAG).toBe('${{ github.ref_name }}')
    expect(allSteps().filter((s) => (s.run ?? '').includes('${{'))).toEqual([])
  })

  test('only the three named files are uploaded, and a missing one fails', () => {
    const upload = stepsOf('build').find((s) => s.uses?.startsWith('actions/upload-artifact@'))
    expect(upload?.with?.['if-no-files-found']).toBe('error')
    expect(uploadPaths('build')).toEqual(['packages/desktop/release/latest.yml', 'packages/desktop/release/openaflow-setup-*.exe', 'packages/desktop/release/openaflow-setup-*.exe.blockmap'])
  })

  test('a tag also builds Linux', () => {
    const job = flow.jobs?.['build-linux']
    expect(job?.['runs-on']).toBe('ubuntu-latest')
    const steps = stepsOf('build-linux')
    const tag = indexOfRun(steps, /^pnpm release:check "--tag=\$TAG"$/m)
    const verify = indexOfRun(steps, /^pnpm verify$/m)
    const pack = indexOfRun(steps, /^pnpm package$/m)
    // Electron's sandbox needs unprivileged user namespaces, which AppArmor limits on Ubuntu 24.04.
    const sysctl = indexOfRun(steps, /^sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0$/m)
    const check = indexOfRun(steps, /^xvfb-run -a pnpm release:check packages\/desktop\/release$/m)
    const upload = steps.findIndex((s) => s.uses?.startsWith('actions/upload-artifact@'))
    const order = [tag, verify, pack, sysctl, check, upload]
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(steps[tag]?.env?.TAG).toBe('${{ github.ref_name }}')
    const install = steps[indexOfRun(steps, /pnpm install --frozen-lockfile/)]
    expect(install?.env?.ELECTRON_SKIP_BINARY_DOWNLOAD).toBe('1')

    // It uploads the AppImage and latest-linux.yml only, under its own name.
    const up = steps[upload]
    expect(up?.with?.['if-no-files-found']).toBe('error')
    expect(uploadPaths('build-linux')).toEqual(['packages/desktop/release/latest-linux.yml', 'packages/desktop/release/openaflow-*-x86_64.AppImage'])
    const names = BUILDS.map((j) => stepsOf(j).find((s) => s.uses?.startsWith('actions/upload-artifact@'))?.with?.name)
    expect(names).toEqual(['release-files-windows', 'release-files-linux'])

    // publish takes both builds' files into one folder, and needs all five.
    const download = stepsOf('publish').filter((s) => s.uses?.startsWith('actions/download-artifact@'))
    expect(download).toHaveLength(1)
    expect(download[0]?.with).toEqual({ pattern: 'release-files-*', 'merge-multiple': true, path: 'release-files' })
    const create = stepsOf('publish').find((s) => /gh release create/.test(s.run ?? ''))
    expect(create?.run).toMatch(/if \(\$files\.Count -ne 5\) \{ throw "expected 5 files/)

    // Every action, the new job's too, stays pinned to a commit.
    const uses = steps.filter((s) => s.uses !== undefined)
    expect(uses.length).toBeGreaterThanOrEqual(4)
    for (const line of text.split('\n').filter((l) => /^\s*(?:-\s*)?uses:/.test(l))) expect(line).toMatch(/uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/)
  })

  test('a normal release', () => {
    const create = stepsOf('publish').find((s) => /gh release create/.test(s.run ?? ''))
    expect(create?.run).toMatch(/gh release create "\$env:TAG"/)
    // --verify-tag: a release never makes a tag of its own.
    expect(create?.run).toMatch(/--verify-tag/)
    expect(create?.env?.GH_TOKEN).toBe('${{ github.token }}')
    for (const step of allSteps()) expect(JSON.stringify(step)).not.toMatch(/--draft|--prerelease|--clobber|draft:|prerelease:/)
  })
})
