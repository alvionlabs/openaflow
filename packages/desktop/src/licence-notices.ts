// THIRD-PARTY-NOTICES.txt: each package whose code ships, with its name, version, and licence text. A bundle's
// list comes from its esbuild metafile, so a removed dependency leaves the notices. The web build's list is the web
// package's production closure: extra packages are fine, and a missed one isn't.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { APP_NAME } from './shell-config.ts'

export type BundleMeta = { workingDir: string; metafile: { inputs: Record<string, unknown>; outputs: Record<string, unknown> } }
export type NoticeExtra = { title: string; text: string }

type Manifest = { name?: string; version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }

const MODULES = 'node_modules/'
const LICENCE_FILE = /^(licen[cs]e|copying)(\.|-|$)/i
const RULE = '='.repeat(80)

// The LICENSE file of github.com/xtermjs/xterm.js. The npm packages say `"license": "MIT"` and ship no licence file.
const XTERM_LICENCE = `Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`

/** For a package that ships no licence file. Each entry says where its text comes from. */
export const LICENCE_OVERRIDES: Record<string, string> = {
  // Its package.json says `"license": "MIT"` and names the author. It ships no licence file, so this is the MIT text.
  'lazy-val': `MIT License

Copyright (c) Vladimir Krivosheev

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  '@xterm/headless': XTERM_LICENCE,
  '@xterm/addon-serialize': XTERM_LICENCE,
}

const readManifest = (root: string) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest

/** The package folder of each input under node_modules. Only `inputs` are in the bundle. */
export function packageRootsFromMetafile(meta: BundleMeta): string[] {
  const roots = new Set<string>()
  for (const input of Object.keys(meta.metafile.inputs)) {
    // `<define:…>` is esbuild's own, and `(disabled):…` is a file it left out.
    if (input.startsWith('<') || input.startsWith('(')) continue
    const at = input.lastIndexOf(MODULES)
    if (at === -1) continue
    const parts = input.slice(at + MODULES.length).split('/')
    const name = parts[0]!.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)
    roots.add(resolve(meta.workingDir, input.slice(0, at + MODULES.length), ...name))
  }
  return [...roots]
}

/** Node's own walk up the folders: each one's node_modules, from the package's real path. */
function resolveDependency(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync.native(candidate)
    if (dirname(dir) === dir) return undefined
  }
}

/**
 * A bundle's packages: those inside it, from the metafile, and those it requires from outside (node-pty), resolved
 * from the bundle's package folder, where the package ships them.
 */
export function bundleRoots(meta: BundleMeta, packageDir: string): string[] {
  const roots = new Set(packageRootsFromMetafile(meta))
  const outputs = Object.values(meta.metafile.outputs) as { imports?: { path: string; external?: boolean }[] }[]
  for (const output of outputs) {
    for (const { path, external } of output.imports ?? []) {
      if (external !== true || isBuiltin(path)) continue
      const parts = path.split('/')
      const name = (path.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/')
      const found = resolveDependency(realpathSync.native(packageDir), name)
      if (found === undefined) throw new Error(`${name}, an external import of a bundle in ${packageDir}, is not installed`)
      roots.add(found)
    }
  }
  return [...roots]
}

/** Every package a package needs in production. A workspace package is walked and not listed. */
export function productionClosure(pkgDir: string): string[] {
  const seen = new Set<string>()
  const listed: string[] = []
  const walk = (dir: string) => {
    if (seen.has(dir)) return
    seen.add(dir)
    if (dir.includes('node_modules')) listed.push(dir)
    const manifest = readManifest(dir)
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const found = resolveDependency(dir, name)
      if (found === undefined) throw new Error(`${name}, a dependency of ${manifest.name ?? dir}, is not installed`)
      walk(found)
    }
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      const found = resolveDependency(dir, name)
      if (found !== undefined) walk(found)
    }
  }
  walk(realpathSync.native(pkgDir))
  return listed
}

function licenceText(root: string): string | undefined {
  const files = readdirSync(root)
    .filter((name) => LICENCE_FILE.test(name) && statSync(join(root, name)).isFile())
    .sort()
  const text = files.map((name) => readFileSync(join(root, name), 'utf8').trim()).filter((t) => t !== '')
  return text.length > 0 ? text.join('\n\n') : undefined
}

export function renderNotices(o: { roots: string[]; overrides: Record<string, string>; extras: NoticeExtra[] }): string {
  const entries = new Map<string, string>()
  const missing: string[] = []
  for (const root of o.roots) {
    const { name = root, version = 'unknown' } = readManifest(root)
    const title = `${name} ${version}`
    if (entries.has(title)) continue
    const text = licenceText(root) ?? o.overrides[name]
    if (text === undefined) missing.push(title)
    else entries.set(title, text)
  }
  if (missing.length > 0) throw new Error(`no licence file and no override for: ${missing.sort().join(', ')}`)

  const sections = [
    ...[...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([title, text]) => ({ title, text })),
    ...o.extras,
  ]
  const body = sections.map(({ title, text }) => `${RULE}\n${title}\n${RULE}\n\n${text}\n`).join('\n')
  return `${APP_NAME} includes the third-party software named below.\n\n${body}`
}
