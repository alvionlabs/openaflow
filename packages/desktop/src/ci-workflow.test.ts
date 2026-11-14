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
})
