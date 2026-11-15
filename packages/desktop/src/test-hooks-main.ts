// Only a test-hooks build calls this (`pnpm package --test-hooks`, or the Electron harness). Every other build drops
// it at bundle time, and the release check refuses a main.cjs that holds its name. The rules are in
// pod-docs/sprints/host-core.md (§6).

import type { SessionInfo, StartSpec } from '@openaflow/pty-host/protocol'
import type { PtyHostStarter } from './pty-host-starter.ts'

export type TestTerminals = {
  start(spec: StartSpec): Promise<{ pid: number }>
  snapshot(id: string): Promise<string | null>
  list(): Promise<SessionInfo[]>
  kill(id: string): Promise<void>
  /** The current host's process ID; it changes after a restart. */
  hostPid(): number | undefined
}

/** Sets `globalThis.__openaflowTest.terminals`, which a Playwright test reaches with `app.evaluate`. */
export function installTestHooks(starter: PtyHostStarter): void {
  const g = globalThis as { __openaflowTest?: { terminals?: TestTerminals } }
  g.__openaflowTest ??= {}
  g.__openaflowTest.terminals = {
    start: (spec) => starter.startSession(spec),
    snapshot: (id) => starter.snapshot(id),
    list: () => starter.list(),
    kill: (id) => starter.kill(id),
    hostPid: () => starter.pid(),
  }
}
