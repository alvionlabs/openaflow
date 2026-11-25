// `pnpm bump-workflow <tag>`: points the lock at another claude-pod tag. It reads the tag's commit with
// `git ls-remote` and writes only the lock. A bad tag is refused before git runs; an unknown tag leaves the lock as it was.

import { rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { COMMIT_RULE, formatLock, isTag, readLock, type Lock } from './lock.ts'
import { createGit, type Git } from './fetch.ts'

/**
 * The commit a tag names in `git ls-remote` output. For an annotated tag the peeled `^{}` line wins.
 * Undefined when the output has no line for that exact tag.
 */
export function tagCommit(lsRemote: string, tag: string): string | undefined {
  let direct: string | undefined
  let peeled: string | undefined
  for (const line of lsRemote.split(/\r?\n/)) {
    const [sha, ref, ...rest] = line.split('\t')
    if (sha === undefined || ref === undefined || rest.length > 0 || !COMMIT_RULE.test(sha)) continue
    if (ref === `refs/tags/${tag}^{}`) peeled = sha
    else if (ref === `refs/tags/${tag}`) direct = sha
  }
  return peeled ?? direct
}

/**
 * Sets the lock's tag and commit. `repo` replaces the lock's repo as the git source only (tests use local repos);
 * the lock keeps its own repo. Throws on a bad tag (before any git call), a bad lock, or an unknown tag.
 */
export async function bump(o: { lockPath: string; tag: string; repo?: string; git?: Git }): Promise<Lock> {
  if (!isTag(o.tag)) throw new Error(`bad tag "${o.tag}": a tag looks like v1.2.3`)
  const lock = await readLock(o.lockPath)
  const source = o.repo ?? lock.repo
  const git = o.git ?? createGit()
  const out = await git(['ls-remote', source, `refs/tags/${o.tag}`, `refs/tags/${o.tag}^{}`])
  const commit = tagCommit(out, o.tag)
  if (commit === undefined) throw new Error(`unknown tag ${o.tag} in ${source}`)
  const next: Lock = { repo: lock.repo, tag: o.tag, commit }
  const temp = `${o.lockPath}.tmp-${randomBytes(4).toString('hex')}`
  await writeFile(temp, formatLock(next))
  await rename(temp, o.lockPath)
  return next
}

const USAGE = 'usage: pnpm bump-workflow <tag> [--lock <path>] [--repo <git url or path>]'

/** The bump command line. Returns the exit code: 0 on a bump, 1 on any refusal. */
export async function runBumpCli(
  argv: string[],
  o: { defaultLock: string; git?: Git; log?: (line: string) => void; error?: (line: string) => void },
): Promise<number> {
  const log = o.log ?? ((line: string) => console.log(line))
  const error = o.error ?? ((line: string) => console.error(line))
  let tag: string | undefined
  let lockPath = o.defaultLock
  let repo: string | undefined
  const args = argv[0] === '--' ? argv.slice(1) : argv
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--lock' || arg === '--repo') {
      const value = args[++i]
      if (value === undefined || value === '') {
        error(`bump failed: ${arg} needs a value\n${USAGE}`)
        return 1
      }
      if (arg === '--lock') lockPath = value
      else repo = value
    } else if (tag === undefined && !arg.startsWith('--')) {
      tag = arg
    } else {
      error(`bump failed: unexpected argument "${arg}"\n${USAGE}`)
      return 1
    }
  }
  if (tag === undefined) {
    error(`bump failed: no tag\n${USAGE}`)
    return 1
  }
  try {
    const lock = await bump({ lockPath, tag, ...(repo === undefined ? {} : { repo }), ...(o.git ? { git: o.git } : {}) })
    log(`bumped the workflow lock to ${lock.tag} (${lock.commit})`)
    return 0
  } catch (err) {
    error(`bump failed: ${(err as Error).message}`)
    return 1
  }
}
