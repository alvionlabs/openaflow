// `pnpm --filter @openaflow/workflow build` (part of `pnpm build`): the bundled claude-pod plugin in
// dist/claude-pod, with dist/claude-pod.stamp.json. Wiring only: the logic is in src/fetch.ts and src/transform.ts.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareWorkflow, type Git } from '../src/fetch.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')

export async function build(
  o: { lockPath?: string; distDir?: string; repo?: string; git?: Git } = {},
): Promise<'current' | 'built'> {
  const lockText = await readFile(o.lockPath ?? join(pkg, 'workflow.lock.json'), 'utf8')
  return prepareWorkflow({
    lockText,
    distDir: o.distDir ?? join(pkg, 'dist'),
    ...(o.repo === undefined ? {} : { repo: o.repo }),
    ...(o.git === undefined ? {} : { git: o.git }),
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await build()
    console.log(
      result === 'current'
        ? 'openaflow: the workflow plugin is current (dist/claude-pod matches the lock)'
        : `openaflow: built the workflow plugin in ${join(pkg, 'dist', 'claude-pod')}`,
    )
  } catch (err) {
    console.error(`openaflow: workflow build failed: ${(err as Error).message}`)
    process.exitCode = 1
  }
}
