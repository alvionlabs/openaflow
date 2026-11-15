// The pty host's messages with the main process and with each window's port. The rules are in
// pod-docs/sprints/host-core.md (§4). No `electron` import: the host runs under Node in tests.

export const PROTOCOL_VERSION = 1

export type StartSpec = {
  id: string
  program: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  /** Absolute. The host saves the session's snapshot text there (session-life §2). */
  screenFile?: string
}

export type SessionInfo = { id: string; pid: number; live: boolean; startedAt: number }

/** From the main process, on `process.parentPort`. `connect` carries a window's MessagePort in `ports[0]`. */
export type MainToHost =
  | { type: 'start'; spec: StartSpec }
  | { type: 'kill'; id: string }
  | { type: 'dispose'; id: string }
  | { type: 'list' }
  | { type: 'snapshot'; id: string }
  | { type: 'connect' }
  /** Save every session's screen file now. The host answers `flushed` once, within `FLUSH_WAIT_MS`. */
  | { type: 'flush' }
  | { type: 'shutdown' }

export type HostToMain =
  | { type: 'ready'; version: typeof PROTOCOL_VERSION }
  | { type: 'load-failed'; error: string }
  | { type: 'beat' }
  | { type: 'started'; id: string; pid: number }
  | { type: 'start-failed'; id: string; error: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'list'; sessions: SessionInfo[] }
  | { type: 'snapshot'; id: string; text: string | null }
  | { type: 'flushed' }

/** From a window, on the MessagePort that `connect` gave the host. */
export type WindowToHost =
  | { type: 'attach'; id: string }
  | { type: 'detach'; id: string }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  /** `chars`: how many characters of `data` the window has written since its last ack. `replay` does not count. */
  | { type: 'ack'; id: string; chars: number }

export type HostToWindow =
  | { type: 'replay'; id: string; data: string }
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }
  | { type: 'error'; id?: string; error: string }

/** Main's message types. A window port that sends one gets `not allowed`. */
export const MAIN_ONLY: ReadonlySet<string> = new Set(['start', 'kill', 'dispose', 'list', 'snapshot', 'connect', 'flush', 'shutdown'])

export const BEAT_MS = 5_000
/** A port over `pauseAbove` unacked characters pauses the pty; it resumes once every port is under `resumeBelow`. */
export const FLOW = { pauseAbove: 100_000, resumeBelow: 5_000 }
/** A port over `FLOW.pauseAbove` that has sent nothing for this long stops holding the pty, until its next message. */
export const STALE_PORT_MS = 30_000
/** How often a session's screen file is saved, when its text changed. */
export const SCREEN_SAVE_MS = 10_000
/** `flush` answers `flushed` within this, even when a write hangs. */
export const FLUSH_WAIT_MS = 2_000

/** A session ID: a run marker. */
export const SESSION_ID = /^[a-z0-9-]{1,64}$/
export const COLS = { min: 2, max: 500 }
export const ROWS = { min: 1, max: 200 }

const inRange = (n: unknown, r: { min: number; max: number }) => Number.isInteger(n) && (n as number) >= r.min && (n as number) <= r.max

/** Whether a terminal may have this size: integers, 2–500 columns by 1–200 rows. */
export const sizeOk = (cols: unknown, rows: unknown) => inRange(cols, COLS) && inRange(rows, ROWS)

/** Answers the first rule a spec breaks, or `undefined`. `id in use` and `spawn failed` need the host's state. */
export function specError(spec: unknown, o: { isAbsolute(path: string): boolean; isDir(path: string): boolean }): string | undefined {
  if (typeof spec !== 'object' || spec === null) return 'bad message'
  const s = spec as Record<string, unknown>
  if (typeof s.id !== 'string' || !SESSION_ID.test(s.id)) return 'bad id'
  if (typeof s.program !== 'string' || !o.isAbsolute(s.program)) return 'program not absolute'
  if (!Array.isArray(s.args) || !s.args.every((a) => typeof a === 'string')) return 'bad message'
  if (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env) || !Object.values(s.env).every((v) => typeof v === 'string')) return 'bad message'
  if (typeof s.cwd !== 'string' || !o.isAbsolute(s.cwd) || !o.isDir(s.cwd)) return 'no folder'
  if (!sizeOk(s.cols, s.rows)) return 'bad size'
  if (s.screenFile !== undefined && (typeof s.screenFile !== 'string' || !o.isAbsolute(s.screenFile))) return 'bad screen file'
  return undefined
}
