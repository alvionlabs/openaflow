/**
 * A listbox button's rules, with no DOM: Listbox.tsx only wires them. The pattern is WAI-ARIA's select-only
 * combobox: focus stays on the button, which names the active option with aria-activedescendant.
 *
 * Closed: ArrowDown, ArrowUp, Enter, Space, and Alt+ArrowDown open on the current pick; Home and End open on the
 * first and last option; a letter opens on the next option that starts with it.
 * Open: ArrowDown and ArrowUp move and wrap; Home and End go to the ends; Enter, Space, and Alt+ArrowUp pick and
 * close; Escape and Tab close and keep the old pick; letters search. A divider is never active.
 * A key with Ctrl or Meta is always the page's.
 */

export type ListboxItem = { kind: 'option'; value: string; label: string; command?: string; line?: string } | { kind: 'divider' }
export type ListboxState = { open: boolean; active: number; typed: string; typedAt: number }
export type ListboxKey = { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; now: number }
/** `handled`: the listbox took the key, so the caller prevents its default. `pick`: the value picked, if any. */
export type ListboxStep = { state: ListboxState; pick?: string; handled: boolean }

/** Letters typed closer together than this are one search. */
export const TYPEAHEAD_MS = 500
export const CLOSED: ListboxState = { open: false, active: -1, typed: '', typedAt: 0 }

const isOption = (items: readonly ListboxItem[], i: number) => items[i]?.kind === 'option'
const optionIndexes = (items: readonly ListboxItem[]) => items.flatMap((item, i) => (item.kind === 'option' ? [i] : []))

/** The option with this value, else the first option, else -1. */
function selectedIndex(items: readonly ListboxItem[], value: string): number {
  const at = items.findIndex((i) => i.kind === 'option' && i.value === value)
  return at >= 0 ? at : (optionIndexes(items)[0] ?? -1)
}

/** The next option from `from` in `dir`, wrapping, past any divider. */
function step(items: readonly ListboxItem[], from: number, dir: 1 | -1): number {
  const n = items.length
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n
    if (isOption(items, i)) return i
  }
  return from
}

function openAt(active: number): ListboxState {
  return { ...CLOSED, open: true, active }
}

const label = (items: readonly ListboxItem[], i: number) => {
  const item = items[i]
  return item?.kind === 'option' ? item.label.toLowerCase() : ''
}

/** The option a typed search lands on, or `active` when none matches. */
function search(items: readonly ListboxItem[], active: number, typed: string): number {
  const n = items.length
  // One letter, or the same letter again: the next match after the active option, so it cycles.
  const cycling = [...typed].every((c) => c === typed[0])
  const prefix = cycling ? typed[0]! : typed
  const start = cycling ? 1 : 0
  for (let k = start; k < n + start; k++) {
    const i = (((active + k) % n) + n) % n
    if (isOption(items, i) && label(items, i).startsWith(prefix)) return i
  }
  return active
}

function typeahead(items: readonly ListboxItem[], value: string, state: ListboxState, char: string, now: number): ListboxStep {
  const base = state.open ? state : openAt(selectedIndex(items, value))
  const fresh = state.open && state.typed !== '' && now - state.typedAt <= TYPEAHEAD_MS
  const typed = (fresh ? state.typed : '') + char.toLowerCase()
  return { state: { ...base, active: search(items, base.active, typed), typed, typedAt: now }, handled: true }
}

const isChar = (e: ListboxKey) => e.key.length === 1 && !e.altKey

export function listboxKey(items: readonly ListboxItem[], value: string, state: ListboxState, e: ListboxKey): ListboxStep {
  const unhandled = { state, handled: false }
  if (e.ctrlKey || e.metaKey) return unhandled
  const options = optionIndexes(items)
  if (options.length === 0) return unhandled

  if (!state.open) {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        return { state: openAt(selectedIndex(items, value)), handled: true }
      case 'Home':
        return { state: openAt(options[0]!), handled: true }
      case 'End':
        return { state: openAt(options.at(-1)!), handled: true }
    }
    return isChar(e) ? typeahead(items, value, state, e.key, e.now) : unhandled
  }

  const moved = (active: number): ListboxStep => ({ state: { ...state, active, typed: '' }, handled: true })
  const picked = (): ListboxStep => {
    const item = items[state.active]
    return item?.kind === 'option' ? { state: CLOSED, pick: item.value, handled: true } : { state: CLOSED, handled: true }
  }
  switch (e.key) {
    case 'ArrowDown':
      return moved(step(items, state.active, 1))
    case 'ArrowUp':
      return e.altKey ? picked() : moved(step(items, state.active, -1))
    case 'Home':
      return moved(options[0]!)
    case 'End':
      return moved(options.at(-1)!)
    case 'Enter':
      return picked()
    case 'Escape':
      return { state: CLOSED, handled: true }
    case 'Tab':
      return { state: CLOSED, handled: false }
    case ' ':
      // Inside a search, Space is part of the word.
      if (state.typed !== '' && e.now - state.typedAt <= TYPEAHEAD_MS) return typeahead(items, value, state, ' ', e.now)
      return picked()
  }
  return isChar(e) ? typeahead(items, value, state, e.key, e.now) : unhandled
}

/** A press on the button: open on the current pick, or close. */
export function toggleListbox(items: readonly ListboxItem[], value: string, state: ListboxState): ListboxState {
  if (state.open) return CLOSED
  const at = selectedIndex(items, value)
  return at < 0 ? CLOSED : openAt(at)
}

/** A blur or a press outside: close and keep the pick. */
export function closeListbox(_state: ListboxState): ListboxState {
  return CLOSED
}

/** A click on an item: an option picks and closes; a divider does nothing. */
export function pickAt(items: readonly ListboxItem[], state: ListboxState, index: number): ListboxStep {
  const item = items[index]
  if (item?.kind !== 'option') return { state, handled: false }
  return { state: CLOSED, pick: item.value, handled: true }
}

/** The pointer over an item makes it active; a divider changes nothing. */
export function hoverAt(items: readonly ListboxItem[], state: ListboxState, index: number): ListboxState {
  return isOption(items, index) && index !== state.active ? { ...state, active: index } : state
}
