// A listbox button: a field-styled button that opens a list of options (label, slash command, one muted line).
// Focus stays on the button. The rules are in listbox.ts; this file only wires them.
import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '../theme/icons.tsx'
import { CLOSED, closeListbox, hoverAt, listboxKey, pickAt, toggleListbox, type ListboxItem, type ListboxStep } from './listbox.ts'
import './listbox.css'

export type ListboxProps = {
  /** The button's id, for a `<label htmlFor>`. */
  id: string
  /** The id of the label, which also names the list. */
  labelledBy: string
  items: readonly ListboxItem[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export function Listbox({ id, labelledBy, items, value, onChange, disabled }: ListboxProps) {
  const listId = useId()
  const optionId = (i: number) => `${listId}-${i}`
  const [state, setState] = useState(CLOSED)
  const listRef = useRef<HTMLUListElement>(null)

  const apply = (step: ListboxStep) => {
    setState(step.state)
    if (step.pick !== undefined && step.pick !== value) onChange(step.pick)
  }

  // Keep the active option in view as the keys move it.
  useEffect(() => {
    if (state.open) listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [state.open, state.active])

  // Busy closes the list.
  useEffect(() => {
    if (disabled) setState(CLOSED)
  }, [disabled])

  const current = items.find((i) => i.kind === 'option' && i.value === value) ?? items.find((i) => i.kind === 'option')

  return (
    <div className="listbox">
      <button
        id={id}
        type="button"
        role="combobox"
        className="input listbox-button"
        aria-haspopup="listbox"
        aria-expanded={state.open}
        aria-controls={listId}
        aria-labelledby={`${labelledBy} ${id}`}
        aria-activedescendant={state.open && state.active >= 0 ? optionId(state.active) : undefined}
        disabled={disabled}
        onClick={(e) => {
          // A key's click (detail 0) is the key handler's.
          if (e.detail !== 0) setState((s) => toggleListbox(items, value, s))
        }}
        onKeyDown={(e) => {
          const step = listboxKey(items, value, state, { key: e.key, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, now: e.timeStamp })
          if (step.handled) {
            e.preventDefault()
            e.stopPropagation()
          }
          apply(step)
        }}
        onBlur={() => setState(closeListbox)}
      >
        {current?.kind === 'option' && (
          <span className="listbox-value">
            <span className="listbox-label">{current.label}</span>
            {current.command && <code className="listbox-command">{current.command}</code>}
          </span>
        )}
        <span className="listbox-chevron">
          <Icon name="chevron-down" />
        </span>
      </button>
      <ul ref={listRef} id={listId} role="listbox" aria-labelledby={labelledBy} className="menu listbox-list" hidden={!state.open}>
        {items.map((item, i) =>
          item.kind === 'divider' ? (
            <li key={i} role="separator" className="listbox-divider" />
          ) : (
            <li
              key={i}
              id={optionId(i)}
              role="option"
              aria-selected={item.value === value}
              data-active={i === state.active ? '' : undefined}
              className="listbox-option"
              // Keep focus on the button, so the click lands before any blur closes the list.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setState((s) => hoverAt(items, s, i))}
              onClick={() => apply(pickAt(items, state, i))}
            >
              <span className="listbox-option-head">
                <span className="listbox-label">{item.label}</span>
                {item.command && <code className="listbox-command">{item.command}</code>}
              </span>
              {item.line && <span className="listbox-line">{item.line}</span>}
            </li>
          ),
        )}
      </ul>
    </div>
  )
}
