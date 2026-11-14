// `pnpm test:electron [name…]`: the tests that start the real Electron binary. `pnpm verify` skips them. With names,
// only the `real-*.test.ts` files whose names hold one of them run. A name that matches no file fails.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(pkg, '..', '..')

const needed = [
  join(root, 'packages', 'server', 'dist', 'app', 'server.mjs'),
  join(root, 'packages', 'pty-host', 'dist', 'pty-host.cjs'),
  join(pkg, 'dist', 'main.cjs'),
  join(pkg, 'dist', 'preload.cjs'),
]
const missing = needed.filter((file) => !existsSync(file))
if (missing.length > 0) {
  console.error(`openaflow: no bundle at ${missing.join(', ')}. Run pnpm build first.`)
  process.exit(1)
}

const files = readdirSync(join(pkg, 'src')).filter((name) => /^real-.*\.test\.ts$/.test(name)).sort()
const names = process.argv.slice(2).filter((arg) => arg !== '--')
const unmatched = names.filter((name) => !files.some((file) => file.includes(name)))
if (unmatched.length > 0) {
  console.error(`openaflow: no real test file holds ${unmatched.join(', ')}. The files: ${files.join(', ')}`)
  process.exit(1)
}
const chosen = names.length === 0 ? files : files.filter((file) => names.some((name) => file.includes(name)))

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
const run = spawnSync(process.execPath, [vitest, 'run', ...chosen.map((file) => `packages/desktop/src/${file}`)], {
  cwd: root,
  env: { ...process.env, OPENAFLOW_REAL_ELECTRON: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
process.exit(run.status ?? 1)
