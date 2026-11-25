// `pnpm package [--version=<x.y.z>] [--output=<dir>] [--test-feed] [--test-hooks]`: builds, writes the licence notices,
// then packages. On Windows: the installer, its blockmap, latest.yml, and win-unpacked. On Linux: the x64 AppImage,
// latest-linux.yml, and linux-unpacked. Any other system stops with an error. It always passes `publish: never`, and
// it signs nothing.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch, build, Platform } from 'electron-builder'
import { builderOptions, packageTarget, parsePackageArgs, requireWorkflowDist } from '../src/build-config.ts'
import { bundleDesktop } from '../src/bundle-desktop.ts'
import { bundleRoots, LICENCE_OVERRIDES, packageRootsFromMetafile, productionClosure, renderNotices, workflowNotice, type BundleMeta } from '../src/licence-notices.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(pkg, '..', '..')
const server = join(pkg, '..', 'server')
const web = join(pkg, '..', 'web')
const ptyHost = join(pkg, '..', 'pty-host')
const workflowDist = join(pkg, '..', 'workflow', 'dist', 'claude-pod')

const readMeta = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as BundleMeta

function writeNotices(): string {
  const text = renderNotices({
    roots: [
      ...packageRootsFromMetafile(readMeta(join(server, 'dist', 'app.meta.json'))),
      ...packageRootsFromMetafile(readMeta(join(pkg, 'dist', 'main.cjs.meta.json'))),
      ...bundleRoots(readMeta(join(ptyHost, 'dist', 'pty-host.cjs.meta.json')), ptyHost),
      ...productionClosure(web),
    ],
    overrides: LICENCE_OVERRIDES,
    extras: [
      { title: 'Geist (font)', text: readFileSync(join(web, 'public', 'fonts', 'geist-OFL.txt'), 'utf8').trim() },
      { title: 'Geist Mono (font)', text: readFileSync(join(web, 'public', 'fonts', 'geist-mono-OFL.txt'), 'utf8').trim() },
      workflowNotice(workflowDist),
    ],
  })
  const file = join(pkg, 'dist', 'THIRD-PARTY-NOTICES.txt')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

// A bad flag, or a system with no target, stops here, before anything builds.
let picked: ReturnType<typeof packageTarget>
let parsed: ReturnType<typeof parsePackageArgs>
try {
  parsed = parsePackageArgs(process.argv.slice(2))
  picked = packageTarget(process.platform)
} catch (err) {
  console.error(`openaflow: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
const { testFeed = false, testHooks = false, ...args } = parsed
const targets = picked.platform === 'win32' ? Platform.WINDOWS.createTarget(picked.target, Arch.x64) : Platform.LINUX.createTarget(picked.target, Arch.x64)

const built = spawnSync('pnpm -w run build', { cwd: root, shell: true, stdio: 'inherit', windowsHide: true })
if (built.status !== 0) process.exit(built.status ?? 1)

try {
  requireWorkflowDist(workflowDist)
} catch (err) {
  console.error(`openaflow: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

// No signing, also on a machine that has a certificate.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[name]

const mainBundle = { entry: join(pkg, 'src', 'main.ts'), outfile: join(pkg, 'dist', 'main.cjs') }
const testBuild = testFeed || testHooks
if (testBuild) await bundleDesktop({ ...mainBundle, testFeed, testHooks })
try {
  const files = await build({
    ...builderOptions({ noticesFile: writeNotices(), ...args }),
    targets,
  })
  console.log(`openaflow: packaged, and published nothing:\n${files.join('\n')}`)
} finally {
  // dist/main.cjs never stays a test build.
  if (testBuild) await bundleDesktop(mainBundle)
}
