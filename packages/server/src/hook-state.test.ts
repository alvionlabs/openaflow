import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { readHookState } from './hook-state.ts'

const row = (at: number, payload: Record<string, unknown> | null) => JSON.stringify({ v: 1, at, payload })
const text = (...rows: string[]) => rows.join('\n') + '\n'
const start = (at: number, session: string, source: string) => row(at, { hook_event_name: 'SessionStart', session_id: session, source })

describe('readHookState', () => {
  test('the live session follows SessionStart', () => {
    // Spike check 9: start A, /clear gives B, /resume A gives A again with cause resume.
    const state = readHookState(text(start(1000, 'A', 'startup'), start(10_000, 'B', 'clear'), start(20_000, 'A', 'resume')))
    expect(state.live).toEqual({ session: 'A', cause: 'resume', at: 20_000 })
    expect(state.events.map((e) => [e.event, e.session, e.source])).toEqual([
      ['SessionStart', 'A', 'startup'],
      ['SessionStart', 'B', 'clear'],
      ['SessionStart', 'A', 'resume'],
    ])
    // Other events never change the live session.
    const more = readHookState(text(start(1000, 'A', 'startup'), row(2000, { hook_event_name: 'Stop', session_id: 'Z' })))
    expect(more.live).toEqual({ session: 'A', cause: 'startup', at: 1000 })
  })

  test('duplicate events', () => {
    const stop = (at: number) => row(at, { hook_event_name: 'Stop', session_id: 'A' })
    expect(readHookState(text(stop(1000), stop(2500))).events).toHaveLength(1)
    expect(readHookState(text(stop(1000), stop(4000))).events).toHaveLength(2)
    // The kept event is the first one.
    expect(readHookState(text(stop(1000), stop(2500))).events[0]!.at).toBe(1000)
    // A different name, session, source, notification type, or tool never merges.
    const merged = readHookState(
      text(
        row(1000, { hook_event_name: 'Stop', session_id: 'A' }),
        row(1100, { hook_event_name: 'SubagentStop', session_id: 'A' }),
        row(1200, { hook_event_name: 'Stop', session_id: 'B' }),
        row(1300, { hook_event_name: 'SessionStart', session_id: 'A', source: 'startup' }),
        row(1400, { hook_event_name: 'SessionStart', session_id: 'A', source: 'resume' }),
        row(1500, { hook_event_name: 'Notification', session_id: 'A', notification_type: 'permission_prompt' }),
        row(1600, { hook_event_name: 'Notification', session_id: 'A', notification_type: 'idle_prompt' }),
        row(1700, { hook_event_name: 'PreToolUse', session_id: 'A', tool_name: 'Bash' }),
        row(1800, { hook_event_name: 'PreToolUse', session_id: 'A', tool_name: 'Read' }),
      ),
    )
    expect(merged.events).toHaveLength(9)
    expect(merged.events.find((e) => e.kind === 'idle_prompt')).toMatchObject({ event: 'Notification', kind: 'idle_prompt' })
    expect(merged.events.find((e) => e.tool === 'Read')).toMatchObject({ event: 'PreToolUse', tool: 'Read' })
  })

  test('bad and cut lines', () => {
    expect(readHookState('')).toEqual({ events: [] })
    expect(readHookState('\n\n')).toEqual({ events: [] })
    const good = start(1000, 'A', 'startup')
    const half = row(5000, { hook_event_name: 'Stop', session_id: 'A' }).slice(0, 30)
    const state = readHookState(
      text(good, 'not json', '[1,2]', 'null', JSON.stringify({ v: 1, payload: { hook_event_name: 'Stop' } }), row(1500, null)) + half,
    )
    expect(state.events).toHaveLength(1)
    expect(state.live).toEqual({ session: 'A', cause: 'startup', at: 1000 })
    // A cut line keeps its event and session.
    const cut = readHookState(text(JSON.stringify({ v: 1, at: 3000, cut: true, event: 'PreToolUse', session: 'A' })))
    expect(cut.events).toEqual([{ at: 3000, event: 'PreToolUse', session: 'A', cut: true }])
    expect(cut.live).toBeUndefined()
  })

  test('no prompt text', () => {
    const prompt = 'my secret prompt text'
    const state = readHookState(text(row(1000, { hook_event_name: 'UserPromptSubmit', session_id: 'A', prompt })))
    expect(state.events[0]!.promptHash).toBe(createHash('sha256').update(prompt).digest('hex'))
    expect(JSON.stringify(state)).not.toContain('secret')
    expect(Object.keys(state.events[0]!)).not.toContain('prompt')
  })
})
