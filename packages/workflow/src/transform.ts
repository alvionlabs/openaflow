// Turns a claude-pod checkout into the plugin the app bundles: only the five plugin parts, with every `pod-docs` renamed
// to the workflow's state folder, in file text and in paths. The output is all or nothing: it builds in a temp folder
// beside `dist/claude-pod`, checks the result, and only then renames it into place and writes the stamp.

import { isUtf8 } from 'node:buffer'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tagVersion } from './lock.ts'

/** The parts of claude-pod that make the plugin. Nothing else is copied. */
export const PARTS = ['.claude-plugin', 'skills', 'agents', 'docs', 'LICENSE'] as const
export const OLD_STATE = 'pod-docs'
export const STATE_PATH = '.openaflow/workflows/claude-pod/state'
/** The template state, inside the plugin, after the rename. */
export const TEMPLATE = `skills/init/scaffold/${STATE_PATH}`
export const OUT_NAME = 'claude-pod'
export const STAMP_NAME = 'claude-pod.stamp.json'

const OLD_BYTES = Buffer.from(OLD_STATE)

/** Each `pod-docs` in UTF-8 text becomes the state path. Other bytes are copied as they are. */
export function renameText(bytes: Buffer): Buffer {
  if (!isUtf8(bytes) || !bytes.includes(OLD_BYTES)) return bytes
  return Buffer.from(bytes.toString('utf8').replaceAll(OLD_STATE, STATE_PATH), 'utf8')
}

/** In a `/`-separated relative path, each segment `pod-docs` becomes the four segments of the state path. */
export function renamePath(rel: string): string {
  return rel
    .split('/')
    .map((segment) => (segment === OLD_STATE ? STATE_PATH : segment))
    .join('/')
}

/** Walks `dir` and returns each file's `/`-separated path. Refuses links and anything that is no file or folder. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`a link is not copied: ${rel}`)
    if (entry.isDirectory()) out.push(rel + '/', ...(await listFiles(join(dir, entry.name), rel)))
    else if (entry.isFile()) out.push(rel)
    else throw new Error(`not a file or folder: ${rel}`)
  }
  return out
}

/** Each output file whose path or bytes still hold `pod-docs`. Case-sensitive, as the rename is. */
export async function findLeftovers(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const rel of await listFiles(dir)) {
    if (rel.includes(OLD_STATE)) found.push(rel)
    else if (!rel.endsWith('/') && (await readFile(join(dir, rel))).includes(OLD_BYTES)) found.push(rel)
  }
  return found
}

async function copyPart(srcDir: string, outDir: string, part: string, tag: string): Promise<void> {
  const from = join(srcDir, part)
  const info = await lstat(from).catch(() => undefined)
  const what = part === 'LICENSE' ? 'LICENSE' : `${part}/`
  if (info?.isSymbolicLink()) throw new Error(`a link is not copied: ${part}`)
  if (info === undefined || (part === 'LICENSE' ? !info.isFile() : !info.isDirectory())) {
    throw new Error(`${what} is missing in claude-pod ${tag}`)
  }
  const files = part === 'LICENSE' ? [part] : [`${part}/`, ...(await listFiles(from, part))]
  for (const srcRel of files) {
    const target = join(outDir, renamePath(srcRel))
    if (srcRel.endsWith('/')) {
      await mkdir(target, { recursive: true })
      continue
    }
    const source = join(srcDir, srcRel)
    const mode = (await stat(source)).mode & 0o777
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(target, renameText(await readFile(source)), { flag: 'wx', mode })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`two files become one after the rename: ${renamePath(srcRel)}`)
      }
      throw err
    }
  }
}

async function checkOutput(outDir: string, tag: string): Promise<void> {
  const leftovers = await findLeftovers(outDir)
  if (leftovers.length > 0) throw new Error(`pod-docs is left in: ${leftovers.join(', ')}`)
  const want = tagVersion(tag)
  let version: unknown
  try {
    version = (JSON.parse(await readFile(join(outDir, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown })
      .version
  } catch {
    throw new Error('.claude-plugin/plugin.json is missing or is not JSON')
  }
  if (version !== want) {
    throw new Error(`plugin.json version ${JSON.stringify(version)} differs from the tag's version ${want}`)
  }
  const template = await stat(join(outDir, TEMPLATE)).catch(() => undefined)
  if (template === undefined || !template.isDirectory()) throw new Error(`the template state is missing: ${TEMPLATE}`)
}

/**
 * Builds `<distDir>/claude-pod` from the claude-pod checkout in `srcDir`, then writes `<distDir>/claude-pod.stamp.json`
 * with `lockText`. It first removes the old output and stamp, so a failure leaves neither.
 */
export async function transformPlugin(o: { srcDir: string; distDir: string; lockText: string; tag: string }): Promise<void> {
  const out = join(o.distDir, OUT_NAME)
  const stamp = join(o.distDir, STAMP_NAME)
  await rm(stamp, { force: true })
  await rm(out, { recursive: true, force: true })
  await mkdir(o.distDir, { recursive: true })
  const temp = await mkdtemp(join(o.distDir, `.${OUT_NAME}.tmp-`))
  try {
    for (const part of PARTS) await copyPart(o.srcDir, temp, part, o.tag)
    await checkOutput(temp, o.tag)
    await rename(temp, out)
  } catch (err) {
    await rm(temp, { recursive: true, force: true })
    throw err
  }
  const stampTemp = `${stamp}.tmp`
  await writeFile(stampTemp, o.lockText)
  await rename(stampTemp, stamp)
}
