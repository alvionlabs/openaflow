// Git for the workflow build and bump: one runner that every git call goes through, so tests can count the calls.

import { execFile } from 'node:child_process'

export type Git = (args: string[], o?: { cwd?: string }) => Promise<string>

export const GIT_MISSING = 'git not found: the workflow build needs git'

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
          reject(new Error(`git ${args[0] ?? ''} failed: ${why}`))
        },
      )
    })
}
