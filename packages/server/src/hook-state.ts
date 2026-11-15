// Reads a run's hook-state file (the plugin's `record.sh` writes it; the line format is in
// pod-docs/sprints/host-core.md, shared contract 8). Pure: the caller reads the file and passes the text.

import { createHash } from 'node:crypto'

export type HookEvent = {
  at: number
  event: string
  session: string
  source?: string
  /** The `notification_type` of a Notification. */
  kind?: string
  /** The `tool_name` of a tool event. */
  tool?: string
  /** SHA-256 hex of the prompt. The prompt text itself never leaves this reader. */
  promptHash?: string
  /** The line was over 64 KB, so the plugin kept only the event name and the session. */
  cut?: boolean
}

export type HookState = {
  /** The session of the newest `SessionStart`; `cause` is its `source`. */
  live?: { session: string; cause: string; at: number }
  events: HookEvent[]
}

/** Events with the same name, session, source, kind, and tool this close count once. */
const DUPLICATE_WINDOW_MS = 2000

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** One line to one event, or `undefined` for a line that holds none (bad JSON, no time, no event name, empty payload). */
const parseLine = (line: string): HookEvent | undefined => {
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(row) || typeof row.at !== 'number' || !Number.isFinite(row.at)) return undefined
  if (row.cut === true) {
    const event = str(row.event)
    if (!event) return undefined
    return { at: row.at, event, session: str(row.session) ?? '', cut: true }
  }
  const payload = row.payload
  if (!isRecord(payload)) return undefined
  const event = str(payload.hook_event_name)
  if (!event) return undefined
  const out: HookEvent = { at: row.at, event, session: str(payload.session_id) ?? '' }
  const source = str(payload.source)
  if (source !== undefined) out.source = source
  const kind = str(payload.notification_type)
  if (kind !== undefined) out.kind = kind
  const tool = str(payload.tool_name)
  if (tool !== undefined) out.tool = tool
  const prompt = str(payload.prompt)
  if (prompt !== undefined) out.promptHash = createHash('sha256').update(prompt).digest('hex')
  return out
}

const keyOf = (e: HookEvent): string => JSON.stringify([e.event, e.session, e.source, e.kind, e.tool])

export const readHookState = (text: string): HookState => {
  const events: HookEvent[] = []
  const lastKept = new Map<string, number>()
  let live: HookState['live']
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const event = parseLine(line)
    if (!event) continue
    if (event.event === 'SessionStart' && event.session !== '' && (!live || event.at >= live.at)) {
      live = { session: event.session, cause: event.source ?? 'unknown', at: event.at }
    }
    const key = keyOf(event)
    const previous = lastKept.get(key)
    if (previous !== undefined && Math.abs(event.at - previous) <= DUPLICATE_WINDOW_MS) continue
    lastKept.set(key, event.at)
    events.push(event)
  }
  return live ? { live, events } : { events }
}
