// `pnpm --filter @openaflow/pty-host build`: the pty host in dist/pty-host.cjs. The headless terminal is inside;
// node-pty stays outside, because it loads its native binary from its own package folder. The host runs in an
// Electron utilityProcess, which is Node: nothing here imports `electron`.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')

export async function bundlePtyHost(o: { outfile: string }): Promise<{ externalImports: string[] }> {
  await mkdir(dirname(o.outfile), { recursive: true })
  const result = await build({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['node-pty'],
    logLevel: 'warning',
    entryPoints: [join(pkg, 'src', 'host-entry.ts')],
    outfile: o.outfile,
    metafile: true,
  })
  // `pnpm package` reads the bundle's packages from this, for the notices.
  await writeFile(`${o.outfile}.meta.json`, JSON.stringify({ workingDir: process.cwd(), metafile: result.metafile }))
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
  return { externalImports: [...new Set(imports.filter((i) => i.external).map((i) => i.path))].sort() }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outfile = join(pkg, 'dist', 'pty-host.cjs')
  await bundlePtyHost({ outfile })
  console.log(`openaflow: bundled the pty host in ${outfile}`)
}
