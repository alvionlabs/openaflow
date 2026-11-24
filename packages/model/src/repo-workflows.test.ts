import { describe, expect, it } from 'vitest'
import { repoWorkflows } from './repo-workflows.ts'
import type { RepoFiles } from './run-model.ts'

// Every snapshot is built inline: test/no-io.test.ts scans this folder, so no file reads here.

const KEY = '.openaflow/'
const folder = (name: string) => `.openaflow/workflows/${name}/`
const json = (name: string) => `.openaflow/workflows/${name}/workflow.json`
const state = (name: string) => `.openaflow/workflows/${name}/state`

describe('repoWorkflows', () => {
  it('legacy fallback', () => {
    const legacy = [{ name: 'pod-docs', stateDir: 'pod-docs', legacy: true }]
    expect(repoWorkflows({})).toStrictEqual(legacy)
    expect(repoWorkflows({ 'pod-docs/README.md': '# pod docs\n\npod docs: 2\n' })).toStrictEqual(legacy)
    // Folder and workflow.json keys without the `.openaflow/` key are not a signal: S1 adds them only with it.
    expect(repoWorkflows({ [folder('claude-pod')]: '', [json('claude-pod')]: '{"source":"claude-pod"}' })).toStrictEqual(legacy)
  })

  it('one per folder', () => {
    const files: RepoFiles = {
      [KEY]: '',
      [folder('zeta')]: '',
      [folder('claude-pod')]: '',
      [folder('alpha-2')]: '',
      'pod-docs/README.md': '# pod docs\n\npod docs: 2\n',
    }
    // Sorted by name, each with its state folder; the pod-docs files give no legacy workflow.
    expect(repoWorkflows(files)).toStrictEqual([
      { name: 'alpha-2', stateDir: state('alpha-2') },
      { name: 'claude-pod', stateDir: state('claude-pod') },
      { name: 'zeta', stateDir: state('zeta') },
    ])
    // A folder named pod-docs is a normal workflow, not the legacy one.
    expect(repoWorkflows({ [KEY]: '', [folder('pod-docs')]: '' })).toStrictEqual([{ name: 'pod-docs', stateDir: state('pod-docs') }])
    // The key with no folder keys → no workflow at all, even with pod-docs files.
    expect(repoWorkflows({ [KEY]: '', 'pod-docs/README.md': 'x' })).toStrictEqual([])
    // A workflow.json or state file without its folder key is no workflow.
    expect(repoWorkflows({ [KEY]: '', [json('ghost')]: '{"source":"claude-pod"}', [`${state('ghost')}/README.md`]: 'x' })).toStrictEqual([])
    // Windows keys read the same.
    const back = Object.fromEntries(Object.entries(files).map(([k, v]) => [k.replaceAll('/', '\\'), v]))
    expect(repoWorkflows(back)).toStrictEqual(repoWorkflows(files))
    // A good workflow.json sets both fields.
    expect(repoWorkflows({ [KEY]: '', [folder('a')]: '', [json('a')]: '{ "source": "claude-pod", "version": "0.11.10", "extra": 1 }' })).toStrictEqual([
      { name: 'a', stateDir: state('a'), source: 'claude-pod', version: '0.11.10' },
    ])
    // Any source that meets the name rule is kept; known sources are checked later, by the resolver.
    expect(repoWorkflows({ [KEY]: '', [folder('a')]: '', [json('a')]: '{"source":"other-flow"}' })[0]?.source).toBe('other-flow')
  })

  it('bad workflow.json', () => {
    const one = (text: string | undefined) => {
      const files: RepoFiles = { [KEY]: '', [folder('a')]: '' }
      if (text !== undefined) files[json('a')] = text
      return repoWorkflows(files)[0]
    }
    const bare = { name: 'a', stateDir: state('a') }
    for (const text of [undefined, '', '{', 'not json', 'null', '[]', '["claude-pod"]', '"claude-pod"', '42', 'true', '{}']) {
      expect(one(text), String(text)).toStrictEqual(bare)
    }
    // Wrong types and values outside the rules.
    for (const source of [1, null, true, [], {}, '', 'Claude-Pod', '-pod', 'a/b', '../x', 'a'.repeat(65)]) {
      expect(one(JSON.stringify({ source })), JSON.stringify(source)).toStrictEqual(bare)
    }
    for (const version of [1, 1.2, null, [], '', '1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2.3-beta', ' 1.2.3', '1.2.3 ', 'x.y.z']) {
      expect(one(JSON.stringify({ version })), JSON.stringify(version)).toStrictEqual(bare)
    }
    // The two fields are read on their own: a bad version keeps a good source, and the other way round.
    expect(one('{"source":"claude-pod","version":"1.2"}')).toStrictEqual({ ...bare, source: 'claude-pod' })
    expect(one('{"source":"Bad","version":"0.0.0"}')).toStrictEqual({ ...bare, version: '0.0.0' })
    // Zeros alone are digits with no leading zero.
    expect(one('{"version":"10.0.20"}')).toStrictEqual({ ...bare, version: '10.0.20' })
  })

  it('name rule', () => {
    const names = (keys: string[]) => repoWorkflows(Object.fromEntries([[KEY, ''], ...keys.map((k) => [k, ''])])).map((w) => w.name)
    const max = `a${'b'.repeat(63)}`
    expect(max).toHaveLength(64)
    expect(names([folder(max), folder(`${max}c`)])).toEqual([max])
    expect(names([folder('0'), folder('a-'), folder('9-x')])).toEqual(['0', '9-x', 'a-'])
    for (const bad of ['-a', 'A', 'Claude-Pod', 'a_b', 'a.b', 'a b', '.hidden', '', 'é']) {
      expect(names([folder(bad)]), bad).toEqual([])
    }
    // Only a direct subfolder counts, and only its folder key (with the trailing slash).
    expect(names(['.openaflow/workflows/a/b/', '.openaflow/workflows/a', '.openaflow/workflows/', '.openaflow/other/a/', '.openaflow/workflows/a/state/'])).toEqual([])
  })
})
