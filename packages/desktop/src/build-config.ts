// What `pnpm package` asks electron-builder for. The rules are in pod-docs/sprints/installer-and-updates.md and
// pod-docs/feature-details/desktop.md. No `electron` import: this runs under Node.

import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Configuration } from 'electron-builder'
import manifest from '../package.json' with { type: 'json' }
import { APP_ID, APP_NAME } from './shell-config.ts'
import { RELEASE_REPO } from './update-flow.ts'

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE_PTY_LINK = join(PACKAGE_DIR, '..', 'pty-host', 'node_modules', 'node-pty')

/**
 * The packaged app's `name`. It sets the install folder and the updater's cache folder, and NSIS's
 * `--delete-app-data` removes `%APPDATA%\<name>`, so it must never be the server's config folder, `openaflow-server`.
 */
const PACKAGED_NAME = 'openaflow'

/** electron-builder derives the cache folder's name from the packaged name. */
export const UPDATER_CACHE_DIR = `${PACKAGED_NAME}-updater`
export const EXE_NAME = `${APP_NAME}.exe`
/** electron-builder writes it beside the AppImage, because the config has a publish provider. The updater reads it. */
export const LINUX_UPDATE_FILE = 'latest-linux.yml'
/** x64 only, so the name says x86_64, as AppImage names do. */
export const appImageName = (version: string): string => `${PACKAGED_NAME}-${version}-x86_64.AppImage`

export type PackageTarget = { platform: 'win32'; target: 'nsis' } | { platform: 'linux'; target: 'AppImage' }

/** What `pnpm package` builds on this system. Any system but Windows and Linux stops here, before anything builds. */
export function packageTarget(platform: NodeJS.Platform): PackageTarget {
  if (platform === 'win32') return { platform, target: 'nsis' }
  if (platform === 'linux') return { platform, target: 'AppImage' }
  throw new Error(`pnpm package builds on Windows and Linux only, not ${platform}`)
}

export type BuildOptions = {
  /** The generated THIRD-PARTY-NOTICES.txt. */
  noticesFile: string
  /** Default: `version` in the desktop package.json. Edits no file. */
  version?: string
  /** Default: `release` in the desktop package, which git ignores. */
  output?: string
  /** node-pty's real folder, which electron-builder copies. Default: the real path of the pty host's node_modules/node-pty, which pnpm links. */
  nodePtyDir?: string
  /** Default: this machine's. */
  platform?: 'win32' | 'linux'
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function checkVersion(version: string): void {
  if (!VERSION.test(version)) throw new Error(`bad version ${JSON.stringify(version)}: use <major>.<minor>.<patch>, digits only, with no leading zero`)
}

export type PackageArgs = { version?: string; output?: string; testFeed?: true; testHooks?: true }

export function parsePackageArgs(argv: string[]): PackageArgs {
  const out: PackageArgs = {}
  for (const arg of argv) {
    if (arg === '--') continue
    if (arg.startsWith('--version=')) {
      out.version = arg.slice('--version='.length)
      checkVersion(out.version)
    } else if (arg.startsWith('--output=')) {
      out.output = arg.slice('--output='.length)
      if (out.output === '') throw new Error('--output needs a folder')
    } else if (arg === '--test-feed') {
      out.testFeed = true
    } else if (arg === '--test-hooks') {
      out.testHooks = true
    } else {
      throw new Error(`unknown flag ${arg}: pnpm package takes --version=<x.y.z>, --output=<dir>, --test-feed, and --test-hooks`)
    }
  }
  return out
}

/** node-pty's files in the package: no build sources, no other platform's binaries, no debug symbols. */
function nodePtyFilter(platform: 'win32' | 'linux'): string[] {
  return ['package.json', 'LICENSE', 'lib/**/*.js', '!lib/**/*.test.js', `prebuilds/${platform}-x64/**/*`, '!**/*.pdb']
}

export function buildConfig(o: BuildOptions): Configuration {
  const version = o.version ?? manifest.version
  checkVersion(version)
  const platform = o.platform ?? packageTarget(process.platform).platform
  return {
    appId: APP_ID,
    productName: APP_NAME,
    electronVersion: manifest.devDependencies.electron,
    directories: { output: o.output ?? 'release', buildResources: 'build' },
    extraMetadata: { name: PACKAGED_NAME, version, main: 'dist/main.cjs' },
    // The app holds no node_modules: every dependency is inside a bundle. The preload is the window's, beside main.cjs.
    files: ['dist/main.cjs', 'dist/preload.cjs', 'assets/**/*', 'package.json', '!node_modules/**/*'],
    extraResources: [
      { from: '../server/dist/app', to: 'server' },
      { from: o.noticesFile, to: 'THIRD-PARTY-NOTICES.txt' },
      // Outside the asar: a native .node file can't load from inside one. The bundle finds node_modules/node-pty beside it.
      { from: '../pty-host/dist/pty-host.cjs', to: 'pty-host/pty-host.cjs' },
      { from: o.nodePtyDir ?? realpathSync.native(NODE_PTY_LINK), to: 'pty-host/node_modules/node-pty', filter: nodePtyFilter(platform) },
      // Outside the asar: claude reads the plugin folder, and runs its script, by path.
      { from: '../hooks-plugin/plugin', to: 'hooks-plugin' },
    ],
    npmRebuild: false,
    nodeGypRebuild: false,
    forceCodeSigning: false,
    win: {
      target: [{ target: packageTarget('win32').target, arch: ['x64'] }],
      icon: 'assets/icon.ico',
      // Unsigned on purpose: the GitHub account is the trust boundary.
      verifyUpdateCodeSignature: false,
    },
    // electron-builder fills release/linux-unpacked first, then makes the AppImage from it. The pty proof uses the folder.
    linux: { target: [{ target: packageTarget('linux').target, arch: ['x64'] }], executableName: PACKAGED_NAME, category: 'Development' },
    appImage: { artifactName: `${PACKAGED_NAME}-\${version}-x86_64.\${ext}` },
    nsis: {
      oneClick: true,
      perMachine: false,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      shortcutName: APP_NAME,
      // A normal install opens the app. A silent one (an install proof, which has temp env only for its own start) doesn't,
      // and the update path's silent install starts its one new copy through --force-run. build-config.test.ts holds this.
      runAfterFinish: true,
      deleteAppDataOnUninstall: false,
      installerIcon: 'assets/icon.ico',
      uninstallerIcon: 'assets/icon.ico',
      // No spaces: GitHub rewrites them in asset names, which would break latest.yml.
      artifactName: 'openaflow-setup-${version}.${ext}',
      include: 'build/installer.nsh',
    },
    publish: { provider: 'github', owner: RELEASE_REPO.owner, repo: RELEASE_REPO.repo, releaseType: 'release' },
  }
}

export function builderOptions(o: BuildOptions): { projectDir: string; publish: 'never'; config: Configuration } {
  return { projectDir: PACKAGE_DIR, publish: 'never', config: buildConfig(o) }
}
