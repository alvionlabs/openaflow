// Only a test-hooks build calls this (`pnpm package --test-hooks`, or the Electron harness). Every other build drops
// it at bundle time, and the release check refuses a main.cjs that holds its name. The rules are in
// pod-docs/sprints/host-core.md (§6).

import type { SessionInfo, StartSpec } from '@openaflow/pty-host/protocol'
import type { PtyHostStarter } from './pty-host-starter.ts'
import type { QuitAnswer } from './quit-flow.ts'

export type TestTerminals = {
  start(spec: StartSpec): Promise<{ pid: number }>
  snapshot(id: string): Promise<string | null>
  list(): Promise<SessionInfo[]>
  kill(id: string): Promise<void>
  /** The current host's process ID; it changes after a restart. */
  hostPid(): number | undefined
}

/** The quit question's answer in a test-hooks build, which never opens the native box. */
export type TestQuit = {
  /** The answer to the next question only; every later one is `end` again, so the harness's `close()` still quits. */
  answer(a: QuitAnswer): void
}

/**
 * Sets `globalThis.__openaflowTest.terminals` and `.quit`, which a Playwright test reaches with `app.evaluate`.
 * Returns the quit question's stand-in.
 */
export function installTestHooks(starter: PtyHostStarter): { quitAnswer(): Promise<QuitAnswer> } {
  const g = globalThis as { __openaflowTest?: { terminals?: TestTerminals; quit?: TestQuit } }
  g.__openaflowTest ??= {}
  let next: QuitAnswer = 'end'
  g.__openaflowTest.quit = {
    answer(a) {
      if (a !== 'end' && a !== 'cancel') throw new Error('quit answer must be end or cancel')
      next = a
    },
  }
  g.__openaflowTest.terminals = {
    start: (spec) => starter.startSession(spec),
    snapshot: (id) => starter.snapshot(id),
    list: () => starter.list(),
    kill: (id) => starter.kill(id),
    hostPid: () => starter.pid(),
  }
  return {
    quitAnswer: async () => {
      const a = next
      next = 'end'
      return a
    },
  }
}
