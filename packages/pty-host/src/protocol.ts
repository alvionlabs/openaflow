// The pty host's messages with the main process. The rules are in pod-docs/sprints/host-core.md (§4). This slice
// has the start, snapshot, dispose, and shutdown parts; attach, input, resize, and the heartbeat come later.
// No `electron` import: the host runs under Node in tests.

export const PROTOCOL_VERSION = 1

export type StartSpec = { id: string; program: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }

export type MainToHost =
  | { type: 'start'; spec: StartSpec }
  | { type: 'snapshot'; id: string }
  | { type: 'dispose'; id: string }
  | { type: 'shutdown' }

export type HostToMain =
  | { type: 'ready'; version: typeof PROTOCOL_VERSION }
  | { type: 'load-failed'; error: string }
  | { type: 'started'; id: string; pid: number }
  | { type: 'start-failed'; id: string; error: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'snapshot'; id: string; text: string | null }

/** A session ID: a run marker. */
export const SESSION_ID = /^[a-z0-9-]{1,64}$/
export const COLS = { min: 2, max: 500 }
export const ROWS = { min: 1, max: 200 }

const inRange = (n: unknown, r: { min: number; max: number }) => Number.isInteger(n) && (n as number) >= r.min && (n as number) <= r.max

/** Answers the first rule a spec breaks, or `undefined`. `id in use` and `spawn failed` need the host's state. */
export function specError(spec: unknown, o: { isAbsolute(path: string): boolean; isDir(path: string): boolean }): string | undefined {
  if (typeof spec !== 'object' || spec === null) return 'bad message'
  const s = spec as Record<string, unknown>
  if (typeof s.id !== 'string' || !SESSION_ID.test(s.id)) return 'bad id'
  if (typeof s.program !== 'string' || !o.isAbsolute(s.program)) return 'program not absolute'
  if (!Array.isArray(s.args) || !s.args.every((a) => typeof a === 'string')) return 'bad message'
  if (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env) || !Object.values(s.env).every((v) => typeof v === 'string')) return 'bad message'
  if (typeof s.cwd !== 'string' || !o.isAbsolute(s.cwd) || !o.isDir(s.cwd)) return 'no folder'
  if (!inRange(s.cols, COLS) || !inRange(s.rows, ROWS)) return 'bad size'
  return undefined
}
