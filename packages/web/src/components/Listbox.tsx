// A listbox button: a field-styled button that opens a list of options (label, slash command, one muted line).
// Focus stays on the button. The rules are in listbox.ts; this file only wires them.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../theme/icons.tsx'
import { CLOSED, closeListbox, hoverAt, listboxKey, listPlacement, pickAt, toggleListbox, type ListboxItem, type ListboxStep } from './listbox.ts'
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
  const buttonRef = useRef<HTMLButtonElement>(null)

  const apply = (step: ListboxStep) => {
    setState(step.state)
    if (step.pick !== undefined && step.pick !== value) onChange(step.pick)
  }

  // While open, the list is fixed to the viewport by the button, so a modal panel's overflow never clips it.
  // It follows the button on any scroll and on resize.
  useLayoutEffect(() => {
    const list = listRef.current
    const button = buttonRef.current
    if (!state.open || !list || !button) return
    const place = () => {
      const p = listPlacement(button.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, list.scrollHeight)
      const px = (n: number | undefined) => (n === undefined ? '' : `${n}px`)
      Object.assign(list.style, { top: px(p.top), bottom: px(p.bottom), left: px(p.left), width: px(p.width), maxHeight: px(p.maxHeight) })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [state.open])

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
        ref={buttonRef}
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
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-labelledby={labelledBy}
        className="listbox-list"
        hidden={!state.open}
        // A press anywhere in the list keeps focus on the button, so no blur closes it before the click lands.
        onMouseDown={(e) => e.preventDefault()}
      >
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
