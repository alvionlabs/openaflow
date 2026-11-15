// Where the pty host bundle and the hooks plugin are, the host's env, and the main side of its messages. No
// `electron` import: pty-host-main.ts is the glue. The rules are in pod-docs/sprints/host-core.md (§2, §4).

import { join } from 'node:path'
import type { HostToMain } from '@openaflow/pty-host/protocol'

type Place = { packaged: boolean; appPath: string; resourcesPath: string }

/** With this set, Electron's exe runs as plain Node, which a utilityProcess must not. */
const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

/** Unpackaged: <appPath>/../pty-host/dist/pty-host.cjs. Packaged: <resourcesPath>/pty-host/pty-host.cjs, outside the asar, beside its node_modules/node-pty. */
export function ptyHostEntry(o: Place): string {
  if (o.packaged) return join(o.resourcesPath, 'pty-host', 'pty-host.cjs')
  return join(o.appPath, '..', 'pty-host', 'dist', 'pty-host.cjs')
}

/** Unpackaged: <appPath>/../hooks-plugin/plugin. Packaged: <resourcesPath>/hooks-plugin. */
export function hooksPluginDir(o: Place): string {
  if (o.packaged) return join(o.resourcesPath, 'hooks-plugin')
  return join(o.appPath, '..', 'hooks-plugin', 'plugin')
}

/** A copy of env with ELECTRON_RUN_AS_NODE removed in any case. Everything else stays: Windows needs SystemRoot to start a pty. */
export function ptyHostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() !== RUN_AS_NODE) out[key] = value
  return out
}

/** The line desktop.log gets for a host message, if any. */
export function hostLogLine(m: unknown): string | undefined {
  const message = m as Partial<HostToMain> | null
  if (message?.type === 'ready') return 'openaflow desktop: terminal host ready'
  if (message?.type === 'load-failed') return `openaflow desktop: terminal host could not load node-pty: ${message.error}`
  return undefined
}
