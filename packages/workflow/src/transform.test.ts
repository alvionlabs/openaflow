import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findLeftovers, renamePath, renameText, STAMP_NAME, transformPlugin } from './transform.ts'

const LOCK_TEXT = '{ "lock": "text" }\n'
const STATE = '.openaflow/workflows/claude-pod/state'

let root: string
let src: string
let dist: string

const put = async (rel: string, content: string | Buffer = '') => {
  const path = join(src, ...rel.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** A claude-pod checkout in miniature: the five parts, plus the parts that must not ship. */
const goodSource = async () => {
  await put('.claude-plugin/plugin.json', JSON.stringify({ name: 'pod', version: '1.2.3' }))
  await put('.claude-plugin/marketplace.json', '{}')
  await put('skills/init/SKILL.md', 'Copy scaffold/pod-docs/ to pod-docs/. Keep POD-DOCS and Pod-docs.\n')
  await put('skills/init/scaffold/pod-docs/README.md', '# pod-docs\n')
  await put('skills/init/scaffold/pod-docs/plans/.gitkeep')
  await put('skills/init/scaffold/pod-docs/sprints/archive/.gitkeep')
  await put('agents/engineer.md', 'Read pod-docs/codebase-structure.md and pod-docs/features.md.\n')
  await put('docs/how.md', 'docs\n')
  await put('LICENSE', 'MIT License\n')
  await put('README.md', 'pod-docs readme\n')
  await put('CHANGELOG.md', 'log\n')
  await put('evals/case.md', 'eval\n')
  await put('pod-flow/flow.md', 'flow\n')
  await put('.github/workflows/ci.yml', 'ci\n')
  await put('.gitignore', 'x\n')
}

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
  }
  return out.sort()
}

/** Lists a folder; a missing folder reads as empty, so a missing output fails on the assertion. */
const ls = (dir: string) => readdir(dir).then((names) => names.sort(), () => [] as string[])

const build = (tag = 'v1.2.3') => transformPlugin({ srcDir: src, distDir: dist, lockText: LOCK_TEXT, tag })

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-transform-')))
  src = join(root, 'src')
  dist = join(root, 'dist')
  await mkdir(src)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('transform', () => {
  test('copies only the plugin parts', async () => {
    await goodSource()
    await build()
    expect(await ls(dist)).toEqual(['claude-pod', STAMP_NAME])
    expect(await ls(join(dist, 'claude-pod'))).toEqual(['.claude-plugin', 'LICENSE', 'agents', 'docs', 'skills'])
    expect(await walk(join(dist, 'claude-pod'))).toEqual([
      '.claude-plugin/marketplace.json',
      '.claude-plugin/plugin.json',
      'LICENSE',
      'agents/engineer.md',
      'docs/how.md',
      `skills/init/SKILL.md`,
      `skills/init/scaffold/${STATE}/README.md`,
      `skills/init/scaffold/${STATE}/plans/.gitkeep`,
      `skills/init/scaffold/${STATE}/sprints/archive/.gitkeep`,
    ])
    expect(await readFile(join(dist, STAMP_NAME), 'utf8')).toBe(LOCK_TEXT)
    expect(await readFile(join(dist, 'claude-pod', 'LICENSE'), 'utf8')).toBe('MIT License\n')
  })

  test('renames text and paths', async () => {
    await goodSource()
    await build()
    const out = join(dist, 'claude-pod')
    expect(await readFile(join(out, 'skills/init/SKILL.md'), 'utf8')).toBe(
      `Copy scaffold/${STATE}/ to ${STATE}/. Keep POD-DOCS and Pod-docs.\n`,
    )
    expect(await readFile(join(out, 'agents/engineer.md'), 'utf8')).toBe(
      `Read ${STATE}/codebase-structure.md and ${STATE}/features.md.\n`,
    )
    expect(await readFile(join(out, `skills/init/scaffold/${STATE}/README.md`), 'utf8')).toBe(`# ${STATE}\n`)
    expect(renamePath('a/pod-docs/b/pod-docs')).toBe(`a/${STATE}/b/${STATE}`)
    expect(renamePath('a/pod-docs-old/Pod-docs/xpod-docs')).toBe('a/pod-docs-old/Pod-docs/xpod-docs')
    // UTF-8 text with other characters keeps them; bytes that are no UTF-8 stay as they are
    expect(renameText(Buffer.from('é pod-docs ✓')).toString('utf8')).toBe(`é ${STATE} ✓`)
    const binary = Buffer.from([0xff, 0xfe, ...Buffer.from('pod-docs')])
    expect(renameText(binary).equals(binary)).toBe(true)
  })

  test('leftover fails the build', async () => {
    await goodSource()
    await put('skills/old/pod-docs-old.md', 'old\n')
    await put('docs/logo.bin', Buffer.from([0xff, 0x00, ...Buffer.from('see pod-docs')]))
    await expect(build()).rejects.toThrow('pod-docs is left in: docs/logo.bin, skills/old/pod-docs-old.md')
    await expect(readdir(dist)).resolves.toEqual([])
  })

  test('findLeftovers names each file and folder by path and by bytes', async () => {
    await put('a/pod-docsy/file.md', 'clean')
    await put('b/text.md', 'says pod-docs')
    await put('c/clean.md', 'POD-DOCS is another word')
    expect(await findLeftovers(src)).toEqual(['a/pod-docsy/', 'a/pod-docsy/file.md', 'b/text.md'])
  })

  test('bad source fails', async () => {
    await goodSource()
    await expect(build('v1.2.4')).rejects.toThrow(`plugin.json version "1.2.3" differs from the tag's version 1.2.4`)

    await put('.claude-plugin/plugin.json', '{ not json')
    await expect(build()).rejects.toThrow('.claude-plugin/plugin.json is missing or is not JSON')
    await put('.claude-plugin/plugin.json', JSON.stringify({ name: 'pod', version: '1.2.3' }))

    await rm(join(src, 'skills/init/scaffold'), { recursive: true })
    await expect(build()).rejects.toThrow(`the template state is missing: skills/init/scaffold/${STATE}`)
    await put('skills/init/scaffold/pod-docs/README.md', '# readme\n')

    await rm(join(src, 'LICENSE'))
    await expect(build()).rejects.toThrow('LICENSE is missing in claude-pod v1.2.3')
    await mkdir(join(src, 'LICENSE'))
    await expect(build()).rejects.toThrow('LICENSE is missing in claude-pod v1.2.3')
    await rm(join(src, 'LICENSE'), { recursive: true })
    await put('LICENSE', 'MIT\n')

    await rm(join(src, 'agents'), { recursive: true })
    await expect(build()).rejects.toThrow('agents/ is missing in claude-pod v1.2.3')
    await put('agents/engineer.md', 'x\n')

    await build()
    expect(await readdir(dist)).toContain('claude-pod')
  })

  test('a link or two files that become one fail', async () => {
    await goodSource()
    await writeFile(join(root, 'outside.md'), 'outside\n')
    // Windows without Developer Mode can't make a link: that part is proved on Linux and macOS.
    const linked = await symlink(join(root, 'outside.md'), join(src, 'skills', 'link.md'), 'file').then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (process.platform === 'win32' && err.code === 'EPERM') return false
        throw err
      },
    )
    if (linked) {
      await expect(build()).rejects.toThrow('a link is not copied: skills/link.md')
      await rm(join(src, 'skills', 'link.md'))
    }

    await put(`skills/init/scaffold/${STATE}/README.md`, 'twin\n')
    await expect(build()).rejects.toThrow(`two files become one after the rename: skills/init/scaffold/${STATE}/README.md`)
    await expect(readdir(dist)).resolves.toEqual([])
  })

  test('output is all or nothing', async () => {
    await goodSource()
    await put('docs/stale.md', 'stale\n')
    await build()
    expect(await ls(join(dist, 'claude-pod', 'docs'))).toEqual(['how.md', 'stale.md'])

    // a failed build removes the old output and stamp, and leaves no temp folder
    await put('.claude-plugin/plugin.json', JSON.stringify({ name: 'pod', version: '9.9.9' }))
    await expect(build()).rejects.toThrow('differs')
    await expect(readdir(dist)).resolves.toEqual([])

    // a rerun leaves no stale file
    await put('.claude-plugin/plugin.json', JSON.stringify({ name: 'pod', version: '1.2.3' }))
    await rm(join(src, 'docs/stale.md'))
    await build()
    expect(await walk(join(dist, 'claude-pod'))).not.toContain('docs/stale.md')
    expect((await readdir(dist)).sort()).toEqual(['claude-pod', STAMP_NAME])
  })
})
