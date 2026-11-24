import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createWorkflowResolver } from './workflow-resolver.ts'

// Every path comes from the resolved temp root (pod-docs/known-issues/temp-paths-resolve-differently.md).
let base: string
let root: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'openaflow-s1-workflows-')))
  root = join(base, 'workflows')
  await mkdir(root)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

/** Writes `<folder>/.claude-plugin/plugin.json`. */
async function plugin(folder: string, json: unknown): Promise<void> {
  await mkdir(join(folder, '.claude-plugin'), { recursive: true })
  await writeFile(join(folder, '.claude-plugin', 'plugin.json'), typeof json === 'string' ? json : JSON.stringify(json))
}

const TEMPLATE = ['skills', 'init', 'scaffold', '.openaflow', 'workflows', 'claude-pod', 'state']

describe('workflow resolver', () => {
  test('bundled version', async () => {
    await plugin(join(root, 'claude-pod'), { name: 'pod', version: '0.11.10' })
    const dir = join(root, 'claude-pod')
    expect(createWorkflowResolver({ root }).bundled()).toEqual({
      source: 'claude-pod',
      version: '0.11.10',
      dir,
      template: join(dir, ...TEMPLATE),
    })

    // An unset or empty root, or a relative one: no bundle.
    expect(createWorkflowResolver({ root: undefined }).bundled()).toBeUndefined()
    expect(createWorkflowResolver({ root: '' }).bundled()).toBeUndefined()
    // The relative root names the same real folder from the working folder.
    expect(createWorkflowResolver({ root: relative(process.cwd(), root) }).bundled()).toBeUndefined()
    // A root with no claude-pod, or no plugin.json in it.
    expect(createWorkflowResolver({ root: join(base, 'none') }).bundled()).toBeUndefined()
    await mkdir(join(base, 'empty', 'claude-pod'), { recursive: true })
    expect(createWorkflowResolver({ root: join(base, 'empty') }).bundled()).toBeUndefined()
  })

  test('bundled version: a bad plugin.json or version gives no bundle', async () => {
    const bad: unknown[] = [
      'not json',
      '[]',
      'null',
      '"0.1.0"',
      {},
      { version: 1 },
      { version: '' },
      { version: 'v0.1.0' },
      { version: '0.1' },
      { version: '0.1.0.1' },
      { version: '01.1.0' },
      { version: '0.01.0' },
      { version: '0.1.00' },
      { version: '0.1.0-beta' },
      { version: ' 0.1.0' },
      { version: '0.1.0\n' },
    ]
    for (const [i, json] of bad.entries()) {
      const r = join(base, `bad-${i}`)
      await plugin(join(r, 'claude-pod'), json)
      expect(createWorkflowResolver({ root: r }).bundled(), JSON.stringify(json)).toBeUndefined()
    }
    for (const version of ['0.0.0', '10.20.30']) {
      const r = join(base, `good-${version}`)
      await plugin(join(r, 'claude-pod'), { version })
      expect(createWorkflowResolver({ root: r }).bundled()?.version).toBe(version)
    }
    // plugin.json as a folder.
    await mkdir(join(base, 'dir', 'claude-pod', '.claude-plugin', 'plugin.json'), { recursive: true })
    expect(createWorkflowResolver({ root: join(base, 'dir') }).bundled()).toBeUndefined()
  })

  test('bundled version: plugin.json is read once and the result kept', async () => {
    await plugin(join(root, 'claude-pod'), { version: '1.0.0' })
    const resolver = createWorkflowResolver({ root })
    expect(resolver.bundled()?.version).toBe('1.0.0')
    await plugin(join(root, 'claude-pod'), { version: '2.0.0' })
    expect(resolver.bundled()?.version).toBe('1.0.0')
    expect(resolver.forRepo(undefined)?.version).toBe('1.0.0')

    // A missing bundle is kept too.
    const other = join(base, 'later')
    const missing = createWorkflowResolver({ root: other })
    expect(missing.bundled()).toBeUndefined()
    await plugin(join(other, 'claude-pod'), { version: '1.0.0' })
    expect(missing.bundled()).toBeUndefined()
    expect(missing.forRepo([{ source: 'claude-pod' }])).toBeUndefined()
  })

  test('forRepo', async () => {
    await plugin(join(root, 'claude-pod'), { version: '0.11.10' })
    const resolver = createWorkflowResolver({ root })
    const bundle = resolver.bundled()
    expect(bundle).toBeDefined()

    // The first known source.
    expect(resolver.forRepo([{ source: 'claude-pod' }])).toEqual(bundle)
    expect(resolver.forRepo([{ source: 'other' }, { source: 'claude-pod' }])).toEqual(bundle)
    // No source, no workflows, or undefined: the default, claude-pod.
    expect(resolver.forRepo([{}])).toEqual(bundle)
    expect(resolver.forRepo([{ source: undefined }])).toEqual(bundle)
    expect(resolver.forRepo([{ source: 'other' }, {}])).toEqual(bundle)
    expect(resolver.forRepo([])).toEqual(bundle)
    expect(resolver.forRepo(undefined)).toEqual(bundle)
    // Only unknown sources.
    expect(resolver.forRepo([{ source: 'other' }])).toBeUndefined()
    expect(resolver.forRepo([{ source: 'other' }, { source: 'Claude-Pod' }])).toBeUndefined()
    for (const source of ['', 'constructor', 'toString', '__proto__', 'claude-pod/', ' claude-pod']) {
      expect(resolver.forRepo([{ source }]), source).toBeUndefined()
    }

    // A source is never joined into a path: a valid plugin at <root>/../x, or one beside claude-pod, is never found.
    await plugin(join(base, 'x'), { version: '9.9.9' })
    await plugin(join(root, 'claude-pod', 'inner'), { version: '9.9.9' })
    for (const source of ['../x', '..', 'claude-pod/inner', 'claude-pod/../claude-pod', join(base, 'x')]) {
      expect(resolver.forRepo([{ source }]), source).toBeUndefined()
    }
    const noBundle = createWorkflowResolver({ root: join(base, 'none') })
    expect(noBundle.forRepo([{ source: '../x' }])).toBeUndefined()

    // No bundle: nothing, whatever the workflows.
    expect(noBundle.forRepo(undefined)).toBeUndefined()
    expect(noBundle.forRepo([{ source: 'claude-pod' }])).toBeUndefined()
  })
})
