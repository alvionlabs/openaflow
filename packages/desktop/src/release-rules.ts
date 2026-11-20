// The plain rules of a release: the tag, the size of the installer and of the AppImage, the update files, and no test build.
// `scripts/release-check.ts` runs them. The rules are in pod-docs/sprints/installer-and-updates.md.

import { createHash } from 'node:crypto'
import { parse } from 'yaml'

// Measured on 2026-11-03: openaflow-setup-0.1.0.exe is 121,692,606 bytes. The floor is 80% of that, and the ceiling is
// 130%. Measure again and change both when the app gains or loses something large.
export const INSTALLER_FLOOR_BYTES = 97_354_085
export const INSTALLER_CEILING_BYTES = 158_200_388
// Measured on 2026-11-14: openaflow-0.1.0-x86_64.AppImage is 125,831,231 bytes. Same rule: 80% and 130%.
export const APPIMAGE_FLOOR_BYTES = 100_664_985
export const APPIMAGE_CEILING_BYTES = 163_580_600

const TEST_FEED_TEXT = 'OPENAFLOW_UPDATE_TEST'
const TEST_HOOKS_TEXT = '__openaflowTest'
const RELEASE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/
const INSTALLER = /^openaflow-setup-.*\.exe$/
const APPIMAGE = /^openaflow-.*-x86_64\.AppImage$/

/** Answers the version. Throws unless the tag is exactly `v<major>.<minor>.<patch>` and equals the package version. */
export function tagVersion(tag: string, packageVersion: string): string {
  const version = RELEASE_TAG.exec(tag)?.[1]
  if (version === undefined) throw new Error(`bad tag ${JSON.stringify(tag)}: use v<major>.<minor>.<patch>, digits only, with no leading zero`)
  if (version !== packageVersion) throw new Error(`the tag ${tag} doesn't match the version ${packageVersion} in packages/desktop/package.json`)
  return version
}

function checkBetween(what: string, bytes: number, floor: number, ceiling: number): void {
  if (bytes < floor) throw new Error(`the ${what} is ${bytes} bytes, below the floor of ${floor}`)
  if (bytes > ceiling) throw new Error(`the ${what} is ${bytes} bytes, above the ceiling of ${ceiling}`)
}

export function checkSize(bytes: number): void {
  checkBetween('installer', bytes, INSTALLER_FLOOR_BYTES, INSTALLER_CEILING_BYTES)
}

export function checkAppImageSize(bytes: number): void {
  checkBetween('AppImage', bytes, APPIMAGE_FLOOR_BYTES, APPIMAGE_CEILING_BYTES)
}

type UpdateFile = { path?: unknown; sha512?: unknown; files?: unknown }

function readUpdateFile(yml: string, label: string): UpdateFile {
  let value: unknown
  try {
    value = parse(yml)
  } catch {
    throw new Error(`${label} is unreadable YAML`)
  }
  if (typeof value !== 'object' || value === null) throw new Error(`${label} is unreadable YAML: it holds no fields`)
  return value as UpdateFile
}

/**
 * Checks the top-level fields and the `files` entry, because the updater downloads from `files`. `label` is the file's
 * name: `latest.yml` for the installer, `latest-linux.yml` for the AppImage.
 */
export function checkUpdateFile(yml: string, installerBytes: Uint8Array, name: string, label = 'latest.yml'): void {
  const update = readUpdateFile(yml, label)
  const sha512 = createHash('sha512').update(installerBytes).digest('base64')
  if (update.path !== name) throw new Error(`${label} has path ${String(update.path)}, not ${name}`)
  if (update.sha512 !== sha512) throw new Error(`${label} has a sha512 that doesn't match ${name}`)
  const files = Array.isArray(update.files) ? (update.files as { url?: unknown; sha512?: unknown; size?: unknown }[]) : []
  if (files.length !== 1) throw new Error(`${label} has ${files.length} entries in files, not 1`)
  const [file] = files
  if (file?.url !== name) throw new Error(`${label} has files url ${String(file?.url)}, not ${name}`)
  if (file.sha512 !== sha512) throw new Error(`${label} has a files sha512 that doesn't match ${name}`)
  if (file.size !== installerBytes.length) throw new Error(`${label} has files size ${String(file.size)}, not ${installerBytes.length}`)
}

/** Only a `--test-feed` build may hold this text, and that build must never ship. */
export function checkNoTestFeed(mainCjs: string): void {
  if (mainCjs.includes(TEST_FEED_TEXT)) throw new Error(`main.cjs holds ${TEST_FEED_TEXT}: this is a test-feed build`)
}

/** Only a `--test-hooks` build may hold this name, and that build must never ship. */
export function checkNoTestHooks(mainCjs: string): void {
  if (mainCjs.includes(TEST_HOOKS_TEXT)) throw new Error(`main.cjs holds ${TEST_HOOKS_TEXT}: this is a test-hooks build`)
}

/** The output folder must hold one installer: with two, the check could pass one and the upload could take both. */
export function pickInstaller(names: string[]): string {
  const installers = names.filter((name) => INSTALLER.test(name))
  const [only] = installers
  if (only === undefined) throw new Error('no installer in the output folder: run pnpm package first')
  if (installers.length > 1) throw new Error(`more than one installer in the output folder: ${installers.join(', ')}`)
  return only
}


/** The output folder must hold one x64 AppImage, for the same reason as one installer. */
export function pickAppImage(names: string[]): string {
  const images = names.filter((name) => APPIMAGE.test(name))
  const [only] = images
  if (only === undefined) throw new Error('no AppImage in the output folder: run pnpm package first')
  if (images.length > 1) throw new Error(`more than one AppImage in the output folder: ${images.join(', ')}`)
  return only
}
