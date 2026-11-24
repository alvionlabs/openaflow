import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { bump, runBumpCli, tagCommit } from './bump.ts'
import { createGit, type Git } from './fetch.ts'
import { formatLock } from './lock.ts'

const here = dirname(fileURLToPath(import.meta.url))
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const BUMP_SCRIPT = join(here, '..', 'scripts', 'bump.ts')
const REPO = 'https://github.com/iamphduc/claude-pod.git'
const OLD = 'a'.repeat(40)

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim()

/** A local repo with a lightweight tag v1.0.0 and an annotated tag v1.1.0, on two commits. */
const fixtureRepo = async (root: string) => {
  const dir = join(root, 'src-repo')
  await mkdir(dir)
  git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'a.txt'), 'one')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'one')
  git(dir, 'tag', 'v1.0.0')
  const first = git(dir, 'rev-parse', 'HEAD')
  await writeFile(join(dir, 'a.txt'), 'two')
  git(dir, 'commit', '-q', '-am', 'two')
  git(dir, 'tag', '-a', 'v1.1.0', '-m', 'release')
  return {
    dir,
    first,
    second: git(dir, 'rev-parse', 'HEAD'),
    tagObject: git(dir, 'rev-parse', 'v1.1.0'),
  }
}

let root: string
let lockPath: string
const lockText = formatLock({ repo: REPO, tag: 'v0.1.0', commit: OLD })

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-bump-')))
  await mkdir(join(root, 'pkg'))
  lockPath = join(root, 'pkg', 'workflow.lock.json')
  await writeFile(lockPath, lockText)
  await writeFile(join(root, 'pkg', 'other.txt'), 'keep')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const runCli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', TSX, BUMP_SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 })

describe('bump', () => {
  test('bump writes the peeled commit', async () => {
    const fx = await fixtureRepo(root)
    expect(fx.tagObject).not.toBe(fx.second)
    const lock = await bump({ lockPath, tag: 'v1.1.0', repo: fx.dir })
    expect(lock).toEqual({ repo: REPO, tag: 'v1.1.0', commit: fx.second })
    expect(await readFile(lockPath, 'utf8')).toBe(formatLock({ repo: REPO, tag: 'v1.1.0', commit: fx.second }))
    // a lightweight tag has no peeled line
    await bump({ lockPath, tag: 'v1.0.0', repo: fx.dir })
    expect(JSON.parse(await readFile(lockPath, 'utf8')).commit).toBe(fx.first)
    // only the lock changed: no temp file left, the other file kept
    expect((await readdir(join(root, 'pkg'))).sort()).toEqual(['other.txt', 'workflow.lock.json'])
    expect(await readFile(join(root, 'pkg', 'other.txt'), 'utf8')).toBe('keep')
  })

  test('tagCommit matches the exact tag, and the peeled line wins in any order', () => {
    const a = '1'.repeat(40)
    const b = '2'.repeat(40)
    expect(tagCommit(`${b}\trefs/tags/v1.0.0^{}\n${a}\trefs/tags/v1.0.0\n`, 'v1.0.0')).toBe(b)
    expect(tagCommit(`${a}\trefs/tags/v1.0.0\n${b}\trefs/tags/v1.0.0^{}\n`, 'v1.0.0')).toBe(b)
    expect(tagCommit(`${a}\trefs/tags/v1.0.0\r\n`, 'v1.0.0')).toBe(a)
    expect(tagCommit(`${a}\trefs/tags/v1.0.00\n${a}\trefs/tags/xv1.0.0\n`, 'v1.0.0')).toBeUndefined()
    expect(tagCommit(`${'AB'.repeat(20)}\trefs/tags/v1.0.0\n`, 'v1.0.0')).toBeUndefined()
    expect(tagCommit('', 'v1.0.0')).toBeUndefined()
  })

  test('unknown tag keeps the lock', async () => {
    const fx = await fixtureRepo(root)
    await expect(bump({ lockPath, tag: 'v9.9.9', repo: fx.dir })).rejects.toThrow('unknown tag v9.9.9')
    const cli = runCli('v9.9.9', '--lock', lockPath, '--repo', fx.dir)
    expect(cli.status).toBe(1)
    expect(cli.stderr).toContain('unknown tag v9.9.9')
    expect(await readFile(lockPath, 'utf8')).toBe(lockText)
    expect((await readdir(join(root, 'pkg'))).sort()).toEqual(['other.txt', 'workflow.lock.json'])
  })

  test('a repo git cannot reach exits 1 and keeps the lock', async () => {
    const errors: string[] = []
    const code = await runBumpCli(['v1.0.0', '--lock', lockPath, '--repo', join(root, 'nothing')], {
      defaultLock: lockPath,
      error: (l) => errors.push(l),
      log: () => {},
    })
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('git ls-remote failed')
    expect(await readFile(lockPath, 'utf8')).toBe(lockText)
  })

  test('bad tag runs no git', async () => {
    const spy = vi.fn<Git>(createGit())
    for (const tag of ['main', 'v1.2', '1.2.3', 'v1.2.3^{}', '--upload-pack=x', 'v1.2.3 ', '']) {
      await expect(bump({ lockPath, tag, git: spy })).rejects.toThrow('bad tag')
    }
    const errors: string[] = []
    const code = await runBumpCli(['refs/tags/v1.0.0'], { defaultLock: lockPath, git: spy, error: (l) => errors.push(l) })
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('bad tag')
    expect(spy).not.toHaveBeenCalled()
    expect(await readFile(lockPath, 'utf8')).toBe(lockText)
  })

  test('the CLI refuses no tag, a second tag, or an option with no value', async () => {
    for (const argv of [[], ['v1.0.0', 'v1.1.0'], ['v1.0.0', '--lock'], ['v1.0.0', '--force']]) {
      const errors: string[] = []
      expect(await runBumpCli(argv, { defaultLock: lockPath, error: (l) => errors.push(l) })).toBe(1)
      expect(errors.join('\n')).toContain('usage: pnpm bump-workflow <tag>')
    }
    expect(await readFile(lockPath, 'utf8')).toBe(lockText)
  })

  test('cli bumps a temp lock', async () => {
    const fx = await fixtureRepo(root)
    const cli = runCli('v1.1.0', '--lock', lockPath, '--repo', fx.dir)
    expect(cli.stderr).toBe('')
    expect(cli.status).toBe(0)
    expect(cli.stdout).toContain(`bumped the workflow lock to v1.1.0 (${fx.second})`)
    expect(await readFile(lockPath, 'utf8')).toBe(formatLock({ repo: REPO, tag: 'v1.1.0', commit: fx.second }))
    // pnpm may pass a leading `--`
    expect(runCli('--', 'v1.0.0', '--lock', lockPath, '--repo', fx.dir).status).toBe(0)
    expect(JSON.parse(await readFile(lockPath, 'utf8')).commit).toBe(fx.first)
  })
})
