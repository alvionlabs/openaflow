// `pnpm release:check <output dir>`: checks a packaged build and starts it. It publishes nothing.
// Windows: the installer, then it installs it, starts it, and uninstalls it.
// Linux: the AppImage and latest-linux.yml, then it unpacks it to read it, starts it with temp folders, and ends it.
// `pnpm release:check --tag=<tag>` checks only the tag against the package version.
// Each failure exits non-zero and names its step.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile } from '@electron/asar'
import { LINUX_UPDATE_FILE } from '../src/build-config.ts'
import {
  appImagePlace,
  checkNoPodDocs,
  endAppImage,
  finishProof,
  launch,
  launchAppImage,
  machineState,
  missingParts,
  proofLastLine,
  proofPlace,
  refuseRealInstall,
  removeAppImagePlace,
  silentInstall,
  unpackAppImage,
  waitForHealth,
  withInstallLock,
} from '../src/install-check.ts'
import { checkAppImageSize, checkNoTestFeed, checkNoTestHooks, checkSize, checkUpdateFile, pickAppImage, pickInstaller, tagVersion } from '../src/release-rules.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Above the shared default: a runner's first start of an unsigned exe can be slow. */
const HEALTH_MS = 120_000

class StepError extends Error {}

/** Runs one step, and names the step in its failure. */
async function step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof StepError) throw err
    throw new StepError(`release check failed at ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** `OPENAFLOW_API_PORT` has no fallback, so a busy port would fail the start, or let another app answer the health check. */
const freePort = (wanted: number) =>
  new Promise<number>((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(wanted, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (address !== null && typeof address === 'object' ? done(address.port) : fail(new Error('no port'))))
    })
  })


/** Installs, reads the installed asar, starts the exe, and uninstalls in every case. */
async function installAndStart(installer: string): Promise<void> {
  const before = await machineState()
  await step('machine state', () => refuseRealInstall(before))
  const place = proofPlace(await step('port', () => freePort(Number(process.env.OPENAFLOW_PROOF_PORT ?? 0))))
  let failure: unknown
  let diff: string[] | undefined
  try {
    await step('install', () => silentInstall(installer, place))
    const mainCjs = () => extractFile(join(place.installDir, 'resources', 'app.asar'), join('dist', 'main.cjs')).toString('utf8')
    await step('test feed', () => checkNoTestFeed(mainCjs()))
    await step('test hooks', () => checkNoTestHooks(mainCjs()))
    await step('launch', () => launch(place))
    await step('health', () => waitForHealth(place, HEALTH_MS))
  } catch (err) {
    failure = err
  } finally {
    try {
      diff = await finishProof(place, before)
    } catch (err) {
      console.error(`release check failed at uninstall: ${err instanceof Error ? err.message : String(err)}`)
      failure ??= new StepError('release check failed at uninstall')
    }
  }
  if (failure !== undefined) throw failure
  if (diff !== undefined && diff.length > 0) throw new StepError(`release check failed at state diff: ${diff.join('; ')}`)
  console.log(proofLastLine(diff ?? []))
}

/** Unpacks the AppImage and reads it, then starts it with temp folders, waits for health, and ends it. */
async function startAppImage(file: string): Promise<void> {
  const place = appImagePlace(await step('port', () => freePort(Number(process.env.OPENAFLOW_PROOF_PORT ?? 0))))
  let failure: unknown
  let pid: number | undefined
  let left: number[] = []
  try {
    const resources = await step('unpack', () => unpackAppImage(file, place))
    const mainCjs = () => extractFile(join(resources, 'app.asar'), join('dist', 'main.cjs')).toString('utf8')
    await step('test feed', () => checkNoTestFeed(mainCjs()))
    await step('test hooks', () => checkNoTestHooks(mainCjs()))
    await step('resources', () => {
      const missing = missingParts(resources)
      if (missing.length > 0) throw new Error(`the AppImage lacks ${missing.join(', ')}`)
    })
    await step('pod-docs', () => checkNoPodDocs(resources))
    pid = (await step('launch', () => launchAppImage(file, place))).pid
    await step('health', () => waitForHealth(place, HEALTH_MS))
  } catch (err) {
    failure = err
  } finally {
    try {
      if (pid !== undefined) left = await endAppImage(pid, place)
    } finally {
      await removeAppImagePlace(place)
    }
  }
  if (failure !== undefined) throw failure
  if (left.length > 0) throw new StepError(`release check failed at end: processes left after SIGTERM: ${JSON.stringify(left)}`)
  console.log('processes left: []')
}

async function checkAppImage(dir: string): Promise<void> {
  const name = await step('AppImage', () => pickAppImage(readdirSync(dir)))
  const file = join(dir, name)
  await step('size', () => checkAppImageSize(statSync(file).size))
  await step('update file', () => {
    const yml = join(dir, LINUX_UPDATE_FILE)
    if (!existsSync(yml)) throw new Error(`${LINUX_UPDATE_FILE} is missing`)
    checkUpdateFile(readFileSync(yml, 'utf8'), readFileSync(file), name, LINUX_UPDATE_FILE)
  })
  await startAppImage(file)
  console.log(`openaflow: the release check passed for ${name}`)
}

async function checkBuild(dir: string): Promise<void> {
  await step('output folder', () => {
    if (!existsSync(dir)) throw new Error(`no folder ${dir}: run pnpm package first`)
  })
  if (process.platform === 'linux') return checkAppImage(dir)
  const name = await step('installer', () => pickInstaller(readdirSync(dir)))
  const installer = join(dir, name)
  const bytes = readFileSync(installer)
  await step('size', () => checkSize(statSync(installer).size))
  await step('update file', () => {
    const yml = join(dir, 'latest.yml')
    if (!existsSync(yml)) throw new Error('latest.yml is missing')
    checkUpdateFile(readFileSync(yml, 'utf8'), bytes, name)
  })
  await step('blockmap', () => {
    if (!existsSync(`${installer}.blockmap`)) throw new Error(`${name}.blockmap is missing`)
  })
  // A proof that holds the lock around this script says so. A second take in one chain would wait for itself.
  if (process.env.OPENAFLOW_INSTALL_LOCK_HELD === '1') await installAndStart(installer)
  else await withInstallLock(() => installAndStart(installer))
  console.log(`openaflow: the release check passed for ${name}`)
}

async function main(argv: string[]): Promise<void> {
  const args = argv.filter((arg) => arg !== '--')
  const tag = args.find((arg) => arg.startsWith('--tag='))
  if (args.length !== 1) throw new StepError('usage: pnpm release:check <output dir>, or pnpm release:check --tag=<tag>')
  if (tag !== undefined) {
    const { version } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { version: string }
    await step('tag', () => tagVersion(tag.slice('--tag='.length), version))
    console.log(`openaflow: the tag matches version ${version}`)
    return
  }
  // `pnpm --filter … exec` moves into the package folder. INIT_CWD is where the human typed the command.
  await checkBuild(resolve(process.env.INIT_CWD ?? process.cwd(), args[0]!))
}

try {
  await main(process.argv.slice(2))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
