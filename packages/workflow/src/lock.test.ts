import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { formatLock, LockError, parseLock, readLock, tagVersion } from './lock.ts'

const GOOD = {
  repo: 'https://github.com/iamphduc/claude-pod.git',
  tag: 'v0.11.10',
  commit: '80bd2f78127a287b3de6432ed54b84c9e0edb805',
}

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-lock-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const fieldOf = (text: string): string => {
  try {
    parseLock(text)
  } catch (err) {
    if (err instanceof LockError) {
      expect(err.message).toContain(err.field)
      return err.field
    }
    throw err
  }
  return 'accepted'
}

describe('lock', () => {
  test('readLock reads a good lock', async () => {
    const path = join(root, 'workflow.lock.json')
    await writeFile(path, formatLock(GOOD))
    expect(await readLock(path)).toEqual(GOOD)
  })

  test('readLock refuses a bad field', async () => {
    const bad = (patch: Record<string, unknown>) => JSON.stringify({ ...GOOD, ...patch })
    // repo: not https, credentials, white space, no path, not a string
    expect(fieldOf(bad({ repo: 'http://github.com/iamphduc/claude-pod.git' }))).toBe('repo')
    expect(fieldOf(bad({ repo: 'git@github.com:iamphduc/claude-pod.git' }))).toBe('repo')
    expect(fieldOf(bad({ repo: 'https://user:pw@github.com/x.git' }))).toBe('repo')
    expect(fieldOf(bad({ repo: 'https://github.com/a b.git' }))).toBe('repo')
    expect(fieldOf(bad({ repo: 'https://github.com' }))).toBe('repo')
    expect(fieldOf(bad({ repo: '--upload-pack=x' }))).toBe('repo')
    expect(fieldOf(bad({ repo: 1 }))).toBe('repo')
    // tag: no v, leading zero, a fourth part, a suffix
    expect(fieldOf(bad({ tag: '0.11.10' }))).toBe('tag')
    expect(fieldOf(bad({ tag: 'v01.1.1' }))).toBe('tag')
    expect(fieldOf(bad({ tag: 'v1.2.3.4' }))).toBe('tag')
    expect(fieldOf(bad({ tag: 'v1.2.3-rc1' }))).toBe('tag')
    expect(fieldOf(bad({ tag: 'v1.2.3\n' }))).toBe('tag')
    // commit: upper case, short, long
    expect(fieldOf(bad({ commit: GOOD.commit.toUpperCase() }))).toBe('commit')
    expect(fieldOf(bad({ commit: GOOD.commit.slice(0, 39) }))).toBe('commit')
    expect(fieldOf(bad({ commit: `${GOOD.commit}0` }))).toBe('commit')
    // missing and extra keys
    expect(fieldOf(JSON.stringify({ repo: GOOD.repo, tag: GOOD.tag }))).toBe('commit')
    expect(fieldOf(bad({ branch: 'main' }))).toBe('branch')
    // not an object
    expect(fieldOf('[]')).toBe('lock')
    expect(fieldOf('{')).toBe('lock')
    // the edges that pass
    expect(fieldOf(bad({ tag: 'v0.0.0' }))).toBe('accepted')
    expect(fieldOf(bad({ tag: 'v10.200.3000' }))).toBe('accepted')
  })

  test('readLock refuses a bad lock file', async () => {
    const path = join(root, 'workflow.lock.json')
    await writeFile(path, JSON.stringify({ ...GOOD, commit: 'abc' }))
    await expect(readLock(path)).rejects.toThrow(/commit/)
  })

  test('formatLock writes the keys in order, 2-space JSON, a final newline', async () => {
    const text = formatLock({ commit: GOOD.commit, tag: GOOD.tag, repo: GOOD.repo })
    expect(text).toBe(
      `{\n  "repo": "${GOOD.repo}",\n  "tag": "${GOOD.tag}",\n  "commit": "${GOOD.commit}"\n}\n`,
    )
    const lockFile = await readFile(new URL('../workflow.lock.json', import.meta.url), 'utf8')
    expect(formatLock(parseLock(lockFile))).toBe(lockFile)
  })

  test('tagVersion drops the v and refuses a bad tag', () => {
    expect(tagVersion('v0.11.10')).toBe('0.11.10')
    expect(() => tagVersion('0.11.10')).toThrow(/tag/)
  })
})
