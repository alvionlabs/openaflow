// `pnpm bump-workflow <tag>` (root) → `pnpm --filter @openaflow/workflow bump <tag>`. Wiring only: the logic is in
// src/bump.ts.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBumpCli } from '../src/bump.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
process.exitCode = await runBumpCli(process.argv.slice(2), { defaultLock: join(pkg, 'workflow.lock.json') })
