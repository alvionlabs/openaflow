import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MAX_DOC_BYTES, readRepoFiles } from './repo-files.ts'

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'openaflow-d1-repo-'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

async function put(rel: string, text: string | Buffer): Promise<void> {
  const full = join(repo, ...rel.split('/'))
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, text)
}

describe('reads only pod docs', () => {
  test('reads the listed files with "/" keys and leaves the rest out', async () => {
    const wanted = [
      'pod-docs/README.md',
      'pod-docs/handoff-queue.md',
      'pod-docs/plans/board-read.md',
      'pod-docs/plans/archive/old-plan.md',
      'pod-docs/sprints/server-runs.md',
      'pod-docs/sprints/archive/bootstrap-model.md',
      // The decisions (for the staging merge target) and the research reports (for the flow's Research step).
      'pod-docs/decisions.md',
      'pod-docs/research/folder-picker.md',
    ]
    for (const rel of wanted) await put(rel, `# ${rel}\n`)

    const unwanted = [
      'README.md',
      'pod-docs/features.md',
      'pod-docs/codebase-structure.md',
      'pod-docs/known-issues/x.md',
      'pod-docs/plans/notes.txt',
      'pod-docs/plans/draft.MD.bak',
      'pod-docs/plans/deep/inner.md',
      'pod-docs/plans/archive/deeper/inner.md',
      'pod-docs/sprints/archive/2025/x.md',
      'pod-docs/sprints/x.markdown',
      'docs/plans/x.md',
      'pod-docs/research/folder-picker.html',
      'pod-docs/research/archive/old.md',
    ]
    for (const rel of unwanted) await put(rel, 'nope')
    // A folder named like a doc is not a doc.
    await mkdir(join(repo, 'pod-docs', 'sprints', 'folder.md'))

    const files = await readRepoFiles(repo)
    expect(Object.keys(files).sort()).toEqual([...wanted].sort())
    // Research reports are keyed by name only (see 'research names only').
    for (const rel of wanted) expect(files[rel]).toBe(rel.startsWith('pod-docs/research/') ? '' : `# ${rel}\n`)
  })

  test('over-size files are left out; a file at the limit is read', async () => {
    await put('pod-docs/README.md', '# readme\n')
    await put('pod-docs/plans/at-limit.md', Buffer.alloc(MAX_DOC_BYTES, 'a'))
    await put('pod-docs/sprints/too-big.md', Buffer.alloc(MAX_DOC_BYTES + 1, 'a'))
    expect(MAX_DOC_BYTES).toBe(5 * 1024 * 1024)
    const files = await readRepoFiles(repo)
    expect(Object.keys(files).sort()).toEqual(['pod-docs/README.md', 'pod-docs/plans/at-limit.md'])
    expect(files['pod-docs/plans/at-limit.md']).toHaveLength(MAX_DOC_BYTES)
  })

  test('a repo without pod-docs gives {} and a missing repo throws', async () => {
    expect(await readRepoFiles(repo)).toEqual({})
    await put('pod-docs/plans/a.md', 'a')
    expect(await readRepoFiles(repo)).toEqual({ 'pod-docs/plans/a.md': 'a' })
    await expect(readRepoFiles(join(repo, 'gone'))).rejects.toThrow()
  })

  test('reading leaves every file and folder as it was', async () => {
    await put('pod-docs/README.md', '# readme\n')
    await put('pod-docs/plans/a.md', 'a')
    const before = await Promise.all(['pod-docs', 'pod-docs/README.md', 'pod-docs/plans/a.md'].map((r) => stat(join(repo, r))))
    await readRepoFiles(repo)
    const after = await Promise.all(['pod-docs', 'pod-docs/README.md', 'pod-docs/plans/a.md'].map((r) => stat(join(repo, r))))
    expect(after.map((s) => [s.mtimeMs, s.size])).toEqual(before.map((s) => [s.mtimeMs, s.size]))
  })
})

describe('links that point outside the repo', () => {
  let outside: string

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), 'openaflow-d1-outside-'))
  })

  afterEach(async () => {
    // `rm` doesn't follow links, so a junction left in `repo` never empties `outside`.
    await rm(outside, { recursive: true, force: true })
  })

  async function putOutside(rel: string, text: string): Promise<string> {
    const full = join(outside, ...rel.split('/'))
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, text)
    return full
  }

  /** A folder link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
  async function linkFolder(target: string, rel: string): Promise<void> {
    const at = join(repo, ...rel.split('/'))
    await mkdir(join(at, '..'), { recursive: true })
    await symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir')
  }

  /** A file symlink, or false when this machine won't make one (Windows without admin rights or developer mode). */
  async function linkFile(target: string, rel: string): Promise<boolean> {
    const at = join(repo, ...rel.split('/'))
    await mkdir(join(at, '..'), { recursive: true })
    try {
      await symlink(target, at, 'file')
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return false
      throw err
    }
  }

  test('a linked pod-docs/ folder pointing outside: its docs are skipped', async () => {
    await putOutside('docs/README.md', 'secret readme')
    await putOutside('docs/handoff-queue.md', 'secret queue')
    await putOutside('docs/plans/x.md', 'secret plan')
    await linkFolder(join(outside, 'docs'), 'pod-docs')
    expect(await readRepoFiles(repo)).toEqual({})
  })

  test('a linked plans/ or archive/ folder pointing outside: its docs are skipped, the rest read', async () => {
    await put('pod-docs/README.md', '# readme\n')
    await putOutside('plans/x.md', 'secret plan')
    await putOutside('archive/y.md', 'secret sprint')
    await linkFolder(join(outside, 'plans'), 'pod-docs/plans')
    await linkFolder(join(outside, 'archive'), 'pod-docs/sprints/archive')
    expect(await readRepoFiles(repo)).toEqual({ 'pod-docs/README.md': '# readme\n' })
  })

  test('a linked research/ folder pointing outside: its reports are skipped', async () => {
    await put('pod-docs/README.md', '# readme\n')
    const outside = await mkdtemp(join(tmpdir(), 'openaflow-research-out-'))
    try {
      await writeFile(join(outside, 'secret.md'), 'outside')
      await mkdir(join(repo, 'pod-docs'), { recursive: true })
      await symlink(outside, join(repo, 'pod-docs', 'research'), 'junction')
      const files = await readRepoFiles(repo)
      expect(Object.keys(files)).toEqual(['pod-docs/README.md'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a linked doc file pointing outside is skipped', async (ctx) => {
    const target = await putOutside('secret.md', 'secret')
    if (!(await linkFile(target, 'pod-docs/README.md'))) {
      ctx.skip('this machine cannot make file symlinks (Windows without admin rights or developer mode)')
    }
    await linkFile(target, 'pod-docs/handoff-queue.md')
    expect(await readRepoFiles(repo)).toEqual({})
  })

  test('a folder linked to another place inside the repo is still read', async () => {
    await put('shared-plans/x.md', 'inside plan')
    await linkFolder(join(repo, 'shared-plans'), 'pod-docs/plans')
    expect(await readRepoFiles(repo)).toEqual({ 'pod-docs/plans/x.md': 'inside plan' })
  })

  test('a doc file linked to another place inside the repo is still read', async (ctx) => {
    await put('docs/readme-source.md', 'inside readme')
    if (!(await linkFile(join(repo, 'docs', 'readme-source.md'), 'pod-docs/README.md'))) {
      ctx.skip('this machine cannot make file symlinks (Windows without admin rights or developer mode)')
    }
    expect(await readRepoFiles(repo)).toEqual({ 'pod-docs/README.md': 'inside readme' })
  })

  test('a repo reached through a link still reads its own docs', async () => {
    await put('pod-docs/README.md', '# readme\n')
    const via = join(outside, 'via')
    await symlink(repo, via, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await readRepoFiles(via)).toEqual({ 'pod-docs/README.md': '# readme\n' })
  })

  test('a sibling folder whose name starts with the repo name counts as outside', async () => {
    // `C:\x` vs `C:\x-other`: a plain prefix check would let this through.
    const sibling = `${repo}-other`
    await mkdir(join(sibling, 'plans'), { recursive: true })
    await writeFile(join(sibling, 'plans', 'x.md'), 'sibling plan')
    try {
      await linkFolder(join(sibling, 'plans'), 'pod-docs/plans')
      expect(await readRepoFiles(repo)).toEqual({})
    } finally {
      await rm(sibling, { recursive: true, force: true })
    }
  })
})

describe('workflow state folders', () => {
  // Every path here comes from the resolved temp root (pod-docs/known-issues/temp-paths-resolve-differently.md).
  let base: string
  let repoDir: string

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'openaflow-s1-repo-')))
    repoDir = join(base, 'repo')
    await mkdir(repoDir)
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  async function write(rel: string, text: string | Buffer, root = repoDir): Promise<void> {
    const full = join(root, ...rel.split('/'))
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, text)
  }

  const linkDir = (target: string, at: string) => symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir')

  /** Every doc of the state file set, under `state`, each holding its own path. */
  const STATE_DOCS = ['README.md', 'handoff-queue.md', 'decisions.md', 'plans/p.md', 'plans/archive/old.md', 'sprints/s.md', 'sprints/archive/olds.md']

  /** `root` is the repo unless a test builds a folder out of it, under `base`. */
  async function putState(state: string, root = repoDir): Promise<void> {
    for (const rel of STATE_DOCS) await write(`${state}/${rel}`, `# ${state}/${rel}\n`, root)
    await write(`${state}/research/r.md`, '# report\n', root)
  }

  test('reads workflow state folders', async () => {
    await putState('.openaflow/workflows/claude-pod/state')
    await putState('.openaflow/workflows/other-2/state')
    await write('.openaflow/workflows/claude-pod/workflow.json', '{"source":"claude-pod","version":"0.11.10"}\n')
    // Outside the state file set: not read.
    for (const rel of ['features.md', 'plans/deep/x.md', 'research/archive/old.md', 'research/r.html', 'notes.txt']) {
      await write(`.openaflow/workflows/claude-pod/state/${rel}`, 'nope')
    }
    await write('.openaflow/workflows/claude-pod/other.json', 'nope')
    await write('.openaflow/notes.md', 'nope')
    // pod-docs is not read once .openaflow is a folder.
    await write('pod-docs/README.md', 'pod docs: 2\n')
    await write('pod-docs/plans/old.md', 'old')

    const files = await readRepoFiles(repoDir)
    const expected: Record<string, string> = {
      '.openaflow/': '',
      '.openaflow/workflows/claude-pod/': '',
      '.openaflow/workflows/claude-pod/workflow.json': '{"source":"claude-pod","version":"0.11.10"}\n',
      '.openaflow/workflows/other-2/': '',
    }
    for (const name of ['claude-pod', 'other-2']) {
      const state = `.openaflow/workflows/${name}/state`
      for (const rel of STATE_DOCS) expected[`${state}/${rel}`] = `# ${state}/${rel}\n`
      expected[`${state}/research/r.md`] = ''
    }
    expect(files).toEqual(expected)
  })

  test('reads workflow state folders: an empty or name-less .openaflow gives only its marker', async () => {
    await write('pod-docs/README.md', 'pod docs: 2\n')
    await mkdir(join(repoDir, '.openaflow'))
    expect(await readRepoFiles(repoDir)).toEqual({ '.openaflow/': '' })
    await mkdir(join(repoDir, '.openaflow', 'workflows', 'Bad'), { recursive: true })
    expect(await readRepoFiles(repoDir)).toEqual({ '.openaflow/': '' })
    // A workflow folder with no state and no workflow.json still counts.
    await mkdir(join(repoDir, '.openaflow', 'workflows', 'empty'))
    expect(await readRepoFiles(repoDir)).toEqual({ '.openaflow/': '', '.openaflow/workflows/empty/': '' })
  })

  test('reads workflow state folders: a workflow.json over the limit or linked out is left out, and the marker stays', async (ctx) => {
    await write('.openaflow/workflows/big/workflow.json', Buffer.alloc(MAX_DOC_BYTES + 1, ' '))
    await write('secret.json', '{"source":"claude-pod"}', base)
    try {
      await mkdir(join(repoDir, '.openaflow', 'workflows', 'linked'), { recursive: true })
      await symlink(join(base, 'secret.json'), join(repoDir, '.openaflow', 'workflows', 'linked', 'workflow.json'), 'file')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip('this machine cannot make file symlinks')
      throw err
    }
    expect(await readRepoFiles(repoDir)).toEqual({
      '.openaflow/': '',
      '.openaflow/workflows/big/': '',
      '.openaflow/workflows/linked/': '',
    })
  })

  test('pod-docs fallback', async () => {
    await write('pod-docs/README.md', 'pod docs: 2\n')
    await write('pod-docs/plans/p.md', 'plan')
    const podDocs = { 'pod-docs/README.md': 'pod docs: 2\n', 'pod-docs/plans/p.md': 'plan' }
    // No .openaflow.
    expect(await readRepoFiles(repoDir)).toEqual(podDocs)

    // .openaflow as a file.
    await write('.openaflow', 'not a folder')
    expect(await readRepoFiles(repoDir)).toEqual(podDocs)
    await rm(join(repoDir, '.openaflow'))

    // .openaflow as a link to a folder out of the repo, which holds a full workflow.
    await putState('out/.openaflow/workflows/claude-pod/state', base)
    await linkDir(join(base, 'out', '.openaflow'), join(repoDir, '.openaflow'))
    expect(await readRepoFiles(repoDir)).toEqual(podDocs)
    await rm(join(repoDir, '.openaflow'))

    // The same folder in the repo is read, and pod-docs is not.
    await putState('.openaflow/workflows/claude-pod/state')
    const files = await readRepoFiles(repoDir)
    expect(files['.openaflow/']).toBe('')
    expect(files['.openaflow/workflows/claude-pod/state/plans/p.md']).toBe('# .openaflow/workflows/claude-pod/state/plans/p.md\n')
    expect(Object.keys(files).filter((k) => k.startsWith('pod-docs/'))).toEqual([])
  })

  test('pod-docs fallback: a .openaflow link that stays inside the repo counts', async () => {
    await putState('kept/workflows/claude-pod/state')
    await linkDir(join(repoDir, 'kept'), join(repoDir, '.openaflow'))
    const files = await readRepoFiles(repoDir)
    expect(files['.openaflow/']).toBe('')
    expect(files['.openaflow/workflows/claude-pod/state/README.md']).toBe('# kept/workflows/claude-pod/state/README.md\n')
  })

  test('skips bad workflow names', async () => {
    const good = ['a', '0', 'claude-pod', 'x-', 'a'.repeat(64)]
    const bad = ['Claude-pod', '-x', 'x.y', '.hidden', 'a'.repeat(65), 'with space', 'x_y']
    for (const name of [...good, ...bad]) await write(`.openaflow/workflows/${name}/state/README.md`, name)
    // A file named like a workflow is not one.
    await write('.openaflow/workflows/file-name', 'x')
    const files = await readRepoFiles(repoDir)
    const expected: Record<string, string> = { '.openaflow/': '' }
    for (const name of good) {
      expected[`.openaflow/workflows/${name}/`] = ''
      expected[`.openaflow/workflows/${name}/state/README.md`] = name
    }
    expect(files).toEqual(expected)
  })

  test('skips bad workflow names: a workflow folder linked out of the repo is no workflow', async () => {
    await putState('out/state', base)
    await mkdir(join(repoDir, '.openaflow', 'workflows'), { recursive: true })
    await linkDir(join(base, 'out'), join(repoDir, '.openaflow', 'workflows', 'outside'))
    // A workflow folder linked to another place inside the repo still counts.
    await write('inner/state/README.md', 'inner')
    await linkDir(join(repoDir, 'inner'), join(repoDir, '.openaflow', 'workflows', 'inside'))
    expect(await readRepoFiles(repoDir)).toEqual({
      '.openaflow/': '',
      '.openaflow/workflows/inside/': '',
      '.openaflow/workflows/inside/state/README.md': 'inner',
    })
  })

  test('state link outside the repo', async (ctx) => {
    const state = '.openaflow/workflows/claude-pod/state'
    await write(`${state}/README.md`, 'pod docs: 2\n')
    await putState('out', base)
    // A linked folder of the state set, and a linked research folder.
    await mkdir(join(repoDir, ...state.split('/'), 'sprints'), { recursive: true })
    await linkDir(join(base, 'out', 'plans'), join(repoDir, ...state.split('/'), 'plans'))
    await linkDir(join(base, 'out', 'sprints', 'archive'), join(repoDir, ...state.split('/'), 'sprints', 'archive'))
    await linkDir(join(base, 'out', 'research'), join(repoDir, ...state.split('/'), 'research'))
    // A whole linked state folder of a second workflow.
    await mkdir(join(repoDir, '.openaflow', 'workflows', 'second'), { recursive: true })
    await linkDir(join(base, 'out'), join(repoDir, '.openaflow', 'workflows', 'second', 'state'))
    const expected = {
      '.openaflow/': '',
      '.openaflow/workflows/claude-pod/': '',
      [`${state}/README.md`]: 'pod docs: 2\n',
      '.openaflow/workflows/second/': '',
    }
    expect(await readRepoFiles(repoDir)).toEqual(expected)

    // A linked state file.
    try {
      await symlink(join(base, 'out', 'handoff-queue.md'), join(repoDir, ...state.split('/'), 'handoff-queue.md'), 'file')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip('this machine cannot make file symlinks')
      throw err
    }
    expect(await readRepoFiles(repoDir)).toEqual(expected)
  })

  test('research names only', async () => {
    await write('pod-docs/research/a.md', '# a report\n')
    await write('pod-docs/research/big.md', Buffer.alloc(MAX_DOC_BYTES + 1, 'a'))
    await mkdir(join(repoDir, 'pod-docs', 'research', 'folder.md'))
    expect(await readRepoFiles(repoDir)).toEqual({ 'pod-docs/research/a.md': '' })

    const state = '.openaflow/workflows/claude-pod/state'
    await write(`${state}/research/b.md`, '# b report\n')
    await write(`${state}/research/big.md`, Buffer.alloc(MAX_DOC_BYTES + 1, 'a'))
    expect(await readRepoFiles(repoDir)).toEqual({
      '.openaflow/': '',
      '.openaflow/workflows/claude-pod/': '',
      [`${state}/research/b.md`]: '',
    })
  })
})
