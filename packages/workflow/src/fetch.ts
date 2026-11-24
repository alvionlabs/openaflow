// Fetches the locked claude-pod tag for the workflow build. Every git call of the build and of bump goes through one
// runner, so tests can count the calls.

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLock, type Lock } from './lock.ts'
import { OUT_NAME, STAMP_NAME, transformPlugin } from './transform.ts'

export type Git = (args: string[], o?: { cwd?: string }) => Promise<string>

export const GIT_MISSING = 'git not found: the workflow build needs git'

/** The git subcommand in `args`, past each `-c <name=value>`. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++
    else return args[i] as string
  }
  return ''
}

/** Runs `git` from PATH with no prompt. A missing git throws `GIT_MISSING`; a failed call names its subcommand. */
export function createGit(o: { env?: NodeJS.ProcessEnv } = {}): Git {
  const env = { ...(o.env ?? process.env), GIT_TERMINAL_PROMPT: '0' }
  return (args, call = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd: call.cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err === null) return resolve(stdout)
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(GIT_MISSING))
          const why = stderr.trim() || err.message
          reject(new Error(`git ${subcommand(args)} failed: ${why}`))
        },
      )
    })
}

/** True when the stamp holds exactly `lockText` and the built plugin's `plugin.json` is there: no git call is needed. */
export async function isCurrent(o: { distDir: string; lockText: string }): Promise<boolean> {
  const stamp = await readFile(join(o.distDir, STAMP_NAME), 'utf8').catch(() => undefined)
  if (stamp !== o.lockText) return false
  const plugin = await stat(join(o.distDir, OUT_NAME, '.claude-plugin', 'plugin.json')).catch(() => undefined)
  return plugin?.isFile() === true
}

/**
 * Clones the lock's tag shallow into `into` and checks that it is the locked commit. `repo` replaces the lock's repo as
 * the git source only (tests use local repos).
 */
export async function fetchSource(o: { lock: Lock; into: string; repo?: string; git: Git }): Promise<void> {
  await o.git(['--version'])
  const source = o.repo ?? o.lock.repo
  await o.git([
    '-c', 'advice.detachedHead=false',
    '-c', 'core.autocrlf=false',
    'clone', '--quiet', '--depth', '1', '--branch', o.lock.tag, '--', source, o.into,
  ])
  const head = (await o.git(['rev-parse', 'HEAD'], { cwd: o.into })).trim()
  if (head !== o.lock.commit) {
    throw new Error(`tag ${o.lock.tag} is at commit ${head}, but the lock pins commit ${o.lock.commit}`)
  }
}

/**
 * The workflow build: with a current stamp it does nothing and makes no git call. Else it removes the old output,
 * clones the locked tag into a temp folder, and builds `<distDir>/claude-pod` and its stamp from it.
 */
export async function prepareWorkflow(o: {
  lockText: string
  distDir: string
  repo?: string
  git?: Git
  /** Where the temp clone goes; the OS temp folder by default. */
  tempRoot?: string
}): Promise<'current' | 'built'> {
  const lock = parseLock(o.lockText)
  if (await isCurrent(o)) return 'current'
  await rm(join(o.distDir, STAMP_NAME), { force: true })
  await rm(join(o.distDir, OUT_NAME), { recursive: true, force: true })
  const work = await mkdtemp(join(o.tempRoot ?? tmpdir(), 'openaflow-workflow-'))
  try {
    const srcDir = join(work, OUT_NAME)
    await fetchSource({ lock, into: srcDir, git: o.git ?? createGit(), ...(o.repo === undefined ? {} : { repo: o.repo }) })
    await transformPlugin({ srcDir, distDir: o.distDir, lockText: o.lockText, tag: lock.tag })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  return 'built'
}
