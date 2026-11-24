import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createGit, fetchSource, GIT_MISSING, prepareWorkflow, type Git } from './fetch.ts'
import { formatLock, type Lock } from './lock.ts'
import { STAMP_NAME } from './transform.ts'

const REPO = 'https://github.com/iamphduc/claude-pod.git'

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

/** A local claude-pod repo with an annotated tag v1.2.3 on its first commit and a second commit after it. */
const fixtureRepo = async (root: string) => {
  const dir = join(root, 'claude-pod-src')
  await put(dir, '.claude-plugin/plugin.json', JSON.stringify({ name: 'pod', version: '1.2.3' }))
  await put(dir, 'skills/init/SKILL.md', 'Write pod-docs/README.md.\n')
  await put(dir, 'skills/init/scaffold/pod-docs/README.md', '# docs\n')
  await put(dir, 'agents/engineer.md', 'engineer\n')
  await put(dir, 'docs/how.md', 'how\n')
  await put(dir, 'LICENSE', 'MIT\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'one')
  git(dir, 'tag', '-a', 'v1.2.3', '-m', 'release')
  const tagged = git(dir, 'rev-parse', 'HEAD')
  await put(dir, 'docs/how.md', 'later\n')
  git(dir, 'commit', '-q', '-am', 'two')
  return { dir, tagged, later: git(dir, 'rev-parse', 'HEAD') }
}

let root: string
let dist: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-fetch-')))
  dist = join(root, 'dist')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const lockAt = (commit: string): Lock => ({ repo: REPO, tag: 'v1.2.3', commit })
const ls = (dir: string) => readdir(dir).then((names) => names.sort(), () => [] as string[])

describe('fetch', () => {
  test('fetches the locked commit', async () => {
    const fx = await fixtureRepo(root)
    const into = join(root, 'clone')
    await fetchSource({ lock: lockAt(fx.tagged), into, repo: fx.dir, git: createGit() })
    expect(await readFile(join(into, 'docs/how.md'), 'utf8').catch(() => 'no clone')).toBe('how\n')
    expect(git(into, 'rev-parse', 'HEAD')).toBe(fx.tagged)
  })

  test('moved tag fails', async () => {
    const fx = await fixtureRepo(root)
    git(fx.dir, 'tag', '-f', '-a', 'v1.2.3', '-m', 'moved', fx.later)
    const into = join(root, 'clone')
    await expect(fetchSource({ lock: lockAt(fx.tagged), into, repo: fx.dir, git: createGit() })).rejects.toThrow(
      `tag v1.2.3 is at commit ${fx.later}, but the lock pins commit ${fx.tagged}`,
    )
    // the build: an old output and stamp go too, and no temp clone stays
    await put(dist, 'claude-pod/.claude-plugin/plugin.json', '{}')
    await put(dist, STAMP_NAME, 'old lock')
    const tempRoot = join(root, 'temp')
    await mkdir(tempRoot)
    await expect(
      prepareWorkflow({ lockText: formatLock(lockAt(fx.tagged)), distDir: dist, repo: fx.dir, tempRoot }),
    ).rejects.toThrow(fx.later)
    expect(await ls(dist)).toEqual([])
    expect(await ls(tempRoot)).toEqual([])
  })

  test('an unknown tag fails with git’s words', async () => {
    const fx = await fixtureRepo(root)
    await expect(
      fetchSource({ lock: { ...lockAt(fx.tagged), tag: 'v9.9.9' }, into: join(root, 'c'), repo: fx.dir, git: createGit() }),
    ).rejects.toThrow('git clone failed')
  })

  test('stamp skips the fetch', async () => {
    const fx = await fixtureRepo(root)
    const lockText = formatLock(lockAt(fx.tagged))
    const spy = vi.fn<Git>(createGit())

    expect(await prepareWorkflow({ lockText, distDir: dist, repo: fx.dir, git: spy })).toBe('built')
    expect(spy).toHaveBeenCalled()
    expect(await readFile(join(dist, STAMP_NAME), 'utf8')).toBe(lockText)

    // the stamp equals the lock: no git call
    spy.mockClear()
    expect(await prepareWorkflow({ lockText, distDir: dist, repo: fx.dir, git: spy })).toBe('current')
    expect(spy).not.toHaveBeenCalled()

    // another stamp: fetch again
    await writeFile(join(dist, STAMP_NAME), lockText.replace('v1.2.3', 'v1.2.2'))
    expect(await prepareWorkflow({ lockText, distDir: dist, repo: fx.dir, git: spy })).toBe('built')
    expect(spy).toHaveBeenCalled()

    // the stamp equals the lock, but plugin.json is gone: fetch again
    spy.mockClear()
    await rm(join(dist, 'claude-pod', '.claude-plugin', 'plugin.json'))
    expect(await prepareWorkflow({ lockText, distDir: dist, repo: fx.dir, git: spy })).toBe('built')
    expect(spy).toHaveBeenCalled()
  })

  test('git missing', async () => {
    const fx = await fixtureRepo(root)
    const empty = join(root, 'empty-bin')
    await mkdir(empty)
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') env[k] = v
    env.PATH = empty
    const noGit = createGit({ env })
    await expect(
      prepareWorkflow({ lockText: formatLock(lockAt(fx.tagged)), distDir: dist, repo: fx.dir, git: noGit }),
    ).rejects.toThrow(GIT_MISSING)
    expect(GIT_MISSING).toBe('git not found: the workflow build needs git')
    expect(await ls(dist)).toEqual([])
  })
})
