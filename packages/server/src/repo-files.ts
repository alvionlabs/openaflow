import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { RepoFiles } from '@openaflow/model'

/** Larger files are skipped: a pod doc is never this big, and the board keeps every doc in memory. */
export const MAX_DOC_BYTES = 5 * 1024 * 1024

/** A workflow folder name under `.openaflow/workflows/`. A folder with another name is not a workflow. */
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The state files of one folder (`pod-docs`, or a workflow's `state`), read with their text. */
const singleFiles = (state: string) => [`${state}/README.md`, `${state}/handoff-queue.md`, `${state}/decisions.md`]
const mdFolders = (state: string) => [`${state}/plans`, `${state}/plans/archive`, `${state}/sprints`, `${state}/sprints/archive`]
/** Research reports: the model uses only their names, so they are keyed with `''` and never read. */
const researchFolder = (state: string) => `${state}/research`

/**
 * The docs `buildRepoModel` needs, keyed by repo-relative path with `/`.
 *
 * When `<repo>/.openaflow` is a folder whose real path is inside the repo's, the repo is set up: the keys are the
 * marker `.openaflow/` (`''`), and for each folder of `.openaflow/workflows/` that meets the name rule (real path
 * inside the repo too) the marker `.openaflow/workflows/<name>/` (`''`), its `workflow.json` with its text, and the
 * state files of `.openaflow/workflows/<name>/state`. No `pod-docs/` file is read then. Else (`.openaflow` missing,
 * a file, or a link out of the repo) the state files of `pod-docs` are read.
 *
 * The state files of a folder: its README, handoff queue, and decisions (for a staging merge target), the `.md` files
 * directly in its plan and sprint folders and their `archive/`, and the research reports directly in `research/`
 * (for the flow's Research step), keyed with `''`. Nothing else is read, and every file is opened read-only. A missing
 * repo folder throws; a missing doc or folder is left out, and so is a doc whose real path, after every link on the
 * way (a symlink or junction on the file or a folder above it), is outside the repo's real path, one that is not a
 * plain file, and one over the size limit. Links that stay inside the repo still work.
 */
export async function readRepoFiles(repoPath: string): Promise<RepoFiles> {
  if (!(await stat(repoPath)).isDirectory()) throw new Error(`not a directory: ${repoPath}`)
  // Resolved once, so a repo registered through a link still reads its own docs.
  const repoReal = await realpath(repoPath)
  const files: RepoFiles = {}
  if (!(await isDirInside(repoReal, path.join(repoPath, '.openaflow')))) {
    await readState(repoPath, repoReal, 'pod-docs', files)
    return files
  }
  files['.openaflow/'] = ''
  for (const name of await workflowNames(repoPath, repoReal)) {
    const folder = `.openaflow/workflows/${name}`
    files[`${folder}/`] = ''
    const json = await readDoc(repoReal, path.join(repoPath, ...folder.split('/'), 'workflow.json'), true)
    if (json !== undefined) files[`${folder}/workflow.json`] = json
    await readState(repoPath, repoReal, `${folder}/state`, files)
  }
  return files
}

/** Adds the state files of `state` (a repo-relative folder) to `files`. */
async function readState(repoPath: string, repoReal: string, state: string, files: RepoFiles): Promise<void> {
  const keys = singleFiles(state)
  for (const folder of mdFolders(state)) keys.push(...(await mdFilesIn(repoPath, folder)))
  for (const key of keys) {
    const text = await readDoc(repoReal, path.join(repoPath, ...key.split('/')), true)
    if (text !== undefined) files[key] = text
  }
  for (const key of await mdFilesIn(repoPath, researchFolder(state))) {
    if ((await readDoc(repoReal, path.join(repoPath, ...key.split('/')), false)) !== undefined) files[key] = ''
  }
}

/** The names of `.openaflow/workflows/*` that meet the name rule and are folders whose real path is inside the repo, sorted. */
async function workflowNames(repoPath: string, repoReal: string): Promise<string[]> {
  const dir = path.join(repoPath, '.openaflow', 'workflows')
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => WORKFLOW_NAME.test(n)).sort()
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) if (await isDirInside(repoReal, path.join(dir, name))) out.push(name)
  return out
}

async function isDirInside(repoReal: string, p: string): Promise<boolean> {
  try {
    const real = await realpath(p)
    return isInside(repoReal, real) && (await stat(real)).isDirectory()
  } catch {
    return false
  }
}

async function mdFilesIn(repoPath: string, folder: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(repoPath, ...folder.split('/')), { withFileTypes: true })
    // Plain files only: a folder or a symlink named `x.md` is left out.
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => `${folder}/${e.name}`)
      .sort()
  } catch {
    return []
  }
}

/** Whether `real` is inside `root`, both real paths. `relative` keeps `C:\x-other` out of `C:\x` and ignores case on win32. */
function isInside(root: string, real: string): boolean {
  const rel = path.relative(root, real)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * The file's text (`read`), or `''` when it passes the checks unread; `undefined` when it is missing, outside the
 * repo, not a plain file, or over the size limit.
 */
async function readDoc(repoReal: string, file: string, read: boolean): Promise<string | undefined> {
  let handle
  try {
    const real = await realpath(file)
    if (!isInside(repoReal, real)) return undefined
    // The real path is opened, so the checked path is the one read.
    handle = await open(real, 'r')
  } catch {
    return undefined
  }
  try {
    // Size is checked on the open handle, so a file swapped after listing can't slip past it.
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_DOC_BYTES) return undefined
    return read ? await handle.readFile('utf8') : ''
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}
