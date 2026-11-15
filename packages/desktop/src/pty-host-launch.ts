// Where the pty host bundle and the hooks plugin are, the host's env, and the main side of its messages. No
// `electron` import: pty-host-main.ts is the glue. The rules are in pod-docs/sprints/host-core.md (§2, §4).

import { join } from 'node:path'
import type { HostToMain, StartSpec } from '@openaflow/pty-host/protocol'

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

export type PtyHostClient = {
  onMessage(m: unknown): void
  /** The host is gone: what waits, and every later call, rejects. */
  fail(reason: string): void
  start(spec: StartSpec): Promise<{ pid: number }>
  snapshot(id: string): Promise<string | null>
}

type Waiter<T> = { resolve(value: T): void; reject(err: Error): void }

/** Sends after `ready`, and matches each answer to its request by id, in order. */
export function createPtyHostClient(post: (m: unknown) => void): PtyHostClient {
  let failed: string | undefined
  let markReady!: () => void
  let markFailed!: (err: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve
    markFailed = reject
  })
  // Each caller handles its own rejection.
  ready.catch(() => {})
  const starts = new Map<string, Waiter<{ pid: number }>[]>()
  const snapshots = new Map<string, Waiter<string | null>[]>()

  const unavailable = () => new Error(`terminals unavailable: ${failed}`)
  const take = <T>(map: Map<string, Waiter<T>[]>, id: string) => {
    const queue = map.get(id)
    const first = queue?.shift()
    if (queue?.length === 0) map.delete(id)
    return first
  }
  const request = <T>(map: Map<string, Waiter<T>[]>, id: string, message: unknown) =>
    new Promise<T>((resolve, reject) => {
      if (failed !== undefined) return reject(unavailable())
      void ready.then(
        () => {
          if (failed !== undefined) return reject(unavailable())
          map.set(id, [...(map.get(id) ?? []), { resolve, reject }])
          post(message)
        },
        () => reject(unavailable()),
      )
    })

  const client: PtyHostClient = {
    onMessage(raw) {
      const m = raw as HostToMain | null
      if (m?.type === 'ready') markReady()
      else if (m?.type === 'load-failed') client.fail(m.error)
      else if (m?.type === 'started') take(starts, m.id)?.resolve({ pid: m.pid })
      else if (m?.type === 'start-failed') take(starts, m.id)?.reject(new Error(m.error))
      else if (m?.type === 'snapshot') take(snapshots, m.id)?.resolve(m.text)
    },
    fail(reason) {
      if (failed !== undefined) return
      failed = reason
      markFailed(unavailable())
      for (const map of [starts, snapshots] as Map<string, Waiter<never>[]>[]) {
        for (const queue of map.values()) for (const w of queue) w.reject(unavailable())
        map.clear()
      }
    },
    start: (spec) => request(starts, spec.id, { type: 'start', spec }),
    snapshot: (id) => request(snapshots, id, { type: 'snapshot', id }),
  }
  return client
}
