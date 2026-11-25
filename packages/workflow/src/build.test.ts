import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { build } from '../scripts/build.ts'
import { formatLock } from './lock.ts'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim()

const put = async (dir: string, rel: string, content = '') => {
  const path = join(dir, ...rel.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-build-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('build', () => {
  test('build writes dist and stamp', async () => {
    const src = join(root, 'claude-pod-src')
    await put(src, '.claude-plugin/plugin.json', JSON.stringify({ name: 'pod', version: '0.11.10' }))
    await put(src, 'skills/init/SKILL.md', 'Copy scaffold/pod-docs to pod-docs.\n')
    await put(src, 'skills/init/scaffold/pod-docs/README.md', '# docs\n')
    await put(src, 'agents/engineer.md', 'engineer\n')
    await put(src, 'docs/how.md', 'how\n')
    await put(src, 'LICENSE', 'MIT\n')
    await put(src, 'README.md', 'not shipped\n')
    git(src, 'init', '-q', '-b', 'main')
    git(src, 'add', '.')
    git(src, 'commit', '-q', '-m', 'release')
    git(src, 'tag', 'v0.11.10')
    const lockText = formatLock({
      repo: 'https://github.com/iamphduc/claude-pod.git',
      tag: 'v0.11.10',
      commit: git(src, 'rev-parse', 'HEAD'),
    })
    const lockPath = join(root, 'workflow.lock.json')
    await writeFile(lockPath, lockText)
    const distDir = join(root, 'dist')

    expect(await build({ lockPath, distDir, repo: src })).toBe('built')
    expect((await readdir(distDir)).sort()).toEqual(['claude-pod', 'claude-pod.stamp.json'])
    expect(await readFile(join(distDir, 'claude-pod.stamp.json'), 'utf8')).toBe(lockText)
    expect((await readdir(join(distDir, 'claude-pod'))).sort()).toEqual(['.claude-plugin', 'LICENSE', 'agents', 'docs', 'skills'])
    expect(await readFile(join(distDir, 'claude-pod/skills/init/SKILL.md'), 'utf8')).toBe(
      'Copy scaffold/.openaflow/workflows/claude-pod/state to .openaflow/workflows/claude-pod/state.\n',
    )
    expect(
      await readFile(join(distDir, 'claude-pod/skills/init/scaffold/.openaflow/workflows/claude-pod/state/README.md'), 'utf8'),
    ).toBe('# docs\n')

    // a second build is current: the source repo can be gone
    await rm(src, { recursive: true, force: true })
    expect(await build({ lockPath, distDir, repo: src })).toBe('current')
  })

  test('a bad lock fails before git', async () => {
    const lockPath = join(root, 'workflow.lock.json')
    await writeFile(lockPath, '{"repo":"https://x.example/r.git","tag":"v1.0.0","commit":"nope"}')
    await expect(build({ lockPath, distDir: join(root, 'dist'), git: () => Promise.reject(new Error('git ran')) })).rejects.toThrow(
      'commit',
    )
  })
})
