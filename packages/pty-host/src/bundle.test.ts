import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { bundlePtyHost } from '../scripts/build.ts'

describe('bundlePtyHost', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'openaflow-pty-host-bundle-')))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('the bundle keeps node-pty outside and imports no electron', async () => {
    const outfile = join(dir, 'pty-host.cjs')
    const { externalImports } = await bundlePtyHost({ outfile })

    // node-pty loads its native binary from its own folder, so it stays a real package beside the bundle.
    expect(externalImports.filter((name) => !isBuiltin(name))).toEqual(['node-pty'])
    const text = readFileSync(outfile, 'utf8')
    expect(text).toMatch(/require\("node-pty"\)/)
    expect(text).not.toMatch(/require\("electron"\)/)
    expect(text).not.toMatch(/^\s*import\s.+from\s/m)
    // The headless terminal and its serializer are inside.
    expect(text).toContain('SerializeAddon')
    expect(text).toContain('parentPort')

    // The notices read the bundle's packages from this file.
    const meta = JSON.parse(readFileSync(`${outfile}.meta.json`, 'utf8')) as { workingDir: string; metafile: { inputs: Record<string, unknown> } }
    expect(existsSync(meta.workingDir)).toBe(true)
    const inputs = Object.keys(meta.metafile.inputs)
    expect(inputs.some((i) => i.includes('node_modules/@xterm/headless/'))).toBe(true)
    expect(inputs.some((i) => i.includes('node_modules/@xterm/addon-serialize/'))).toBe(true)
    expect(inputs.some((i) => i.includes('node-pty'))).toBe(false)
  }, 60_000)

  test('nothing under the pty host imports electron', () => {
    const src = join(import.meta.dirname, '..')
    for (const file of ['src/protocol.ts', 'src/service.ts', 'src/host-entry.ts', 'scripts/build.ts']) {
      expect(readFileSync(join(src, file), 'utf8'), file).not.toMatch(/from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/)
    }
  })
})
