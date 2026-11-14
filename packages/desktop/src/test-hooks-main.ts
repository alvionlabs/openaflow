// Only a test-hooks build calls this (`pnpm package --test-hooks`, or the Electron harness). Every other build drops
// it at bundle time, and the release check refuses a main.cjs that holds its name. The rules are in
// pod-docs/sprints/host-core.md (§6).

import type { StartSpec } from '@openaflow/pty-host/protocol'
import type { PtyHost } from './pty-host-main.ts'

export type TestTerminals = {
  start(spec: StartSpec): Promise<{ pid: number }>
  snapshot(id: string): Promise<string | null>
  hostPid(): number | undefined
}

/** Sets `globalThis.__openaflowTest.terminals`, which a Playwright test reaches with `app.evaluate`. */
export function installTestHooks(host: PtyHost): void {
  const g = globalThis as { __openaflowTest?: { terminals?: TestTerminals } }
  g.__openaflowTest ??= {}
  g.__openaflowTest.terminals = {
    start: (spec) => host.client.start(spec),
    snapshot: (id) => host.client.snapshot(id),
    hostPid: () => host.pid(),
  }
}
