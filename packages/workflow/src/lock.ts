// The workflow lock: which claude-pod release the app bundles. `packages/workflow/workflow.lock.json` holds exactly
// `{ "repo", "tag", "commit" }`, in that order, as 2-space JSON with a final newline.

import { readFile } from 'node:fs/promises'

export type Lock = { repo: string; tag: string; commit: string }

/** claude-pod tags its releases `v<version>`. */
export const TAG_RULE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const COMMIT_RULE = /^[0-9a-f]{40}$/

const KEYS = ['repo', 'tag', 'commit'] as const

export class LockError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
    this.name = 'LockError'
  }
}

export function isTag(tag: string): boolean {
  return TAG_RULE.test(tag)
}

/** A tag's version is the tag without the `v`. */
export function tagVersion(tag: string): string {
  if (!isTag(tag)) throw new LockError('tag', `bad tag "${tag}": a tag looks like v1.2.3`)
  return tag.slice(1)
}

/** An https git URL with a host, no user name or password, no query or fragment, and no white space. */
export function isRepoUrl(repo: string): boolean {
  if (/\s/.test(repo)) return false
  let url: URL
  try {
    url = new URL(repo)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname.length > 1
  )
}

/** Parses lock text. Throws a `LockError` that names the first bad field. */
export function parseLock(text: string): Lock {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new LockError('lock', 'the lock is not JSON')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new LockError('lock', 'the lock is not a JSON object')
  }
  const record = data as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(KEYS as readonly string[]).includes(key)) throw new LockError(key, `unknown key "${key}" in the lock`)
  }
  const { repo, tag, commit } = record
  if (typeof repo !== 'string' || !isRepoUrl(repo)) {
    throw new LockError('repo', 'bad repo in the lock: it must be an https git URL')
  }
  if (typeof tag !== 'string' || !isTag(tag)) throw new LockError('tag', 'bad tag in the lock: a tag looks like v1.2.3')
  if (typeof commit !== 'string' || !COMMIT_RULE.test(commit)) {
    throw new LockError('commit', 'bad commit in the lock: it must be 40 lowercase hex characters')
  }
  return { repo, tag, commit }
}

export async function readLock(path: string): Promise<Lock> {
  return parseLock(await readFile(path, 'utf8'))
}

/** The lock's file text: keys in order, 2-space JSON, a final newline. */
export function formatLock(lock: Lock): string {
  return `${JSON.stringify({ repo: lock.repo, tag: lock.tag, commit: lock.commit }, null, 2)}\n`
}
