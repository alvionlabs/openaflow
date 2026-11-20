import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { stringify } from 'yaml'
import {
  APPIMAGE_CEILING_BYTES,
  APPIMAGE_FLOOR_BYTES,
  checkAppImageSize,
  checkNoTestFeed,
  checkNoTestHooks,
  checkSize,
  checkUpdateFile,
  INSTALLER_CEILING_BYTES,
  INSTALLER_FLOOR_BYTES,
  pickAppImage,
  pickInstaller,
  tagVersion,
} from './release-rules.ts'

describe('tagVersion', () => {
  test('tag matches the package version', () => {
    expect(tagVersion('v1.2.3', '1.2.3')).toBe('1.2.3')
    expect(tagVersion('v10.0.20', '10.0.20')).toBe('10.0.20')
    expect(tagVersion('v0.1.0', '0.1.0')).toBe('0.1.0')
    expect(() => tagVersion('v1.2.4', '1.2.3')).toThrow(/v1\.2\.4.*1\.2\.3/)
    for (const bad of ['v1.2', 'v1.2.3-beta', '1.2.3', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'V1.2.3', 'v1.2.3 ', '']) {
      expect(() => tagVersion(bad, bad.replace(/^v/, '')), JSON.stringify(bad)).toThrow(/tag/)
    }
  })
})

describe('checkSize', () => {
  test('installer size limits', () => {
    expect(INSTALLER_FLOOR_BYTES).toBeGreaterThan(0)
    expect(INSTALLER_CEILING_BYTES).toBeGreaterThan(INSTALLER_FLOOR_BYTES)
    expect(() => checkSize(INSTALLER_FLOOR_BYTES)).not.toThrow()
    expect(() => checkSize(INSTALLER_CEILING_BYTES)).not.toThrow()
    expect(() => checkSize(INSTALLER_FLOOR_BYTES - 1)).toThrow(/below/)
    expect(() => checkSize(INSTALLER_CEILING_BYTES + 1)).toThrow(/above/)
  })
})

describe('checkUpdateFile', () => {
  const name = 'openaflow-setup-1.2.3.exe'
  const bytes = Buffer.from('the installer')
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const file = { url: name, sha512, size: bytes.length }
  const good = { version: '1.2.3', files: [file], path: name, sha512, releaseDate: '2026-11-03T00:00:00.000Z' }

  test('update file matches the installer', () => {
    expect(() => checkUpdateFile(stringify(good), bytes, name)).not.toThrow()
    expect(() => checkUpdateFile(stringify({ ...good, path: 'other.exe' }), bytes, name)).toThrow(/path/)
    expect(() => checkUpdateFile(stringify({ ...good, sha512: 'd3Jvbmc=' }), bytes, name)).toThrow(/sha512/)
    expect(() => checkUpdateFile('{ not: [yaml', bytes, name)).toThrow(/YAML/)
    expect(() => checkUpdateFile('just text', bytes, name)).toThrow(/YAML/)
  })

  // The updater downloads from `files`, not from the top-level `path`.
  test('the files entry the updater reads also matches', () => {
    expect(() => checkUpdateFile(stringify({ ...good, files: [] }), bytes, name)).toThrow(/files/)
    expect(() => checkUpdateFile(stringify({ ...good, files: undefined }), bytes, name)).toThrow(/files/)
    expect(() => checkUpdateFile(stringify({ ...good, files: [{ ...file, url: 'other.exe' }] }), bytes, name)).toThrow(/files/)
    expect(() => checkUpdateFile(stringify({ ...good, files: [{ ...file, sha512: 'd3Jvbmc=' }] }), bytes, name)).toThrow(/files/)
    expect(() => checkUpdateFile(stringify({ ...good, files: [{ ...file, size: 1 }] }), bytes, name)).toThrow(/files/)
  })
})

describe('checkNoTestFeed', () => {
  test('the test feed text in main.cjs fails', () => {
    expect(() => checkNoTestFeed('const a = 1')).not.toThrow()
    expect(() => checkNoTestFeed('const a = process.env.OPENAFLOW_UPDATE_TEST_FEED')).toThrow(/OPENAFLOW_UPDATE_TEST/)
  })
})

describe('checkNoTestHooks', () => {
  test('no test hooks in a release', () => {
    expect(() => checkNoTestHooks('const a = 1')).not.toThrow()
    expect(() => checkNoTestHooks('globalThis.__openaflowTest = { terminals }')).toThrow(/__openaflowTest.*test-hooks build/)
    expect(() => checkNoTestHooks('g.__openaflowTest ??= {}')).toThrow(/__openaflowTest/)
  })
})

describe('pickInstaller', () => {
  test('exactly one installer counts', () => {
    const name = 'openaflow-setup-1.2.3.exe'
    expect(pickInstaller([name, `${name}.blockmap`, 'latest.yml', 'builder-debug.yml', 'win-unpacked', '__uninstaller-nsis-openaflow.exe'])).toBe(name)
    expect(() => pickInstaller(['latest.yml'])).toThrow(/no installer/)
    // The name before the rename is not this app's installer.
    expect(() => pickInstaller(['pod-board-setup-1.2.3.exe', 'latest.yml'])).toThrow(/no installer/)
    expect(() => pickInstaller([name, 'openaflow-setup-1.2.4.exe'])).toThrow(/openaflow-setup-1\.2\.3\.exe.*openaflow-setup-1\.2\.4\.exe/)
  })
})

describe('the AppImage', () => {
  test('AppImage limits', () => {
    // Measured on 2026-11-14: 125,831,231 bytes. 80% and 130% of that.
    expect(APPIMAGE_FLOOR_BYTES).toBe(100_664_985)
    expect(APPIMAGE_CEILING_BYTES).toBe(163_580_600)
    expect(() => checkAppImageSize(125_831_231)).not.toThrow()
    expect(() => checkAppImageSize(APPIMAGE_FLOOR_BYTES)).not.toThrow()
    expect(() => checkAppImageSize(APPIMAGE_CEILING_BYTES)).not.toThrow()
    expect(() => checkAppImageSize(APPIMAGE_FLOOR_BYTES - 1)).toThrow(/AppImage is \d+ bytes, below the floor/)
    expect(() => checkAppImageSize(APPIMAGE_CEILING_BYTES + 1)).toThrow(/AppImage is \d+ bytes, above the ceiling/)
    expect(() => checkAppImageSize(0)).toThrow(/below/)
  })

  test('exactly one x64 AppImage counts', () => {
    const name = 'openaflow-1.2.3-x86_64.AppImage'
    expect(pickAppImage([name, 'latest-linux.yml', 'builder-debug.yml', 'linux-unpacked'])).toBe(name)
    expect(() => pickAppImage(['latest-linux.yml', 'linux-unpacked'])).toThrow(/no AppImage/)
    // Another arch, or electron-builder's default name, is not this release's file.
    expect(() => pickAppImage(['openaflow-1.2.3-arm64.AppImage'])).toThrow(/no AppImage/)
    expect(() => pickAppImage(['OpenAFlow-1.2.3.AppImage'])).toThrow(/no AppImage/)
    expect(() => pickAppImage([name, 'openaflow-1.2.4-x86_64.AppImage'])).toThrow(/more than one AppImage.*1\.2\.3.*1\.2\.4/)
  })

  test('latest-linux.yml is checked as latest.yml is, and its errors name it', () => {
    const name = 'openaflow-1.2.3-x86_64.AppImage'
    const bytes = Buffer.from('the AppImage')
    const sha512 = createHash('sha512').update(bytes).digest('base64')
    const good = { version: '1.2.3', files: [{ url: name, sha512, size: bytes.length, blockMapSize: 1234 }], path: name, sha512, releaseDate: '2026-11-14T00:00:00.000Z' }
    expect(() => checkUpdateFile(stringify(good), bytes, name, 'latest-linux.yml')).not.toThrow()
    expect(() => checkUpdateFile(stringify({ ...good, sha512: 'd3Jvbmc=' }), bytes, name, 'latest-linux.yml')).toThrow(/^latest-linux\.yml has a sha512/)
    expect(() => checkUpdateFile(stringify({ ...good, files: [{ ...good.files[0], sha512: 'd3Jvbmc=' }] }), bytes, name, 'latest-linux.yml')).toThrow(/^latest-linux\.yml has a files sha512/)
    expect(() => checkUpdateFile('{ not: [yaml', bytes, name, 'latest-linux.yml')).toThrow(/^latest-linux\.yml is unreadable/)
    // The Windows file keeps its name by default.
    expect(() => checkUpdateFile(stringify({ ...good, sha512: 'd3Jvbmc=' }), bytes, name)).toThrow(/^latest\.yml has a sha512/)
  })
})
