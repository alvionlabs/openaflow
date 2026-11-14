import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../theme/icons.tsx'
import { FORGET_ERRORS } from './forget-flow.ts'
import { refusalText, warnUnknown } from './remove-flow.ts'
import { TOGGLE_INITIAL, createToggleFlow, toggleView, type RunTarget, type ToggleState, type ToggleView } from './resume-flow.ts'

const ERROR_ID = 'auto-continue-error'

/**
 * The auto-continue route's words, in Forget's short, warm words (DESIGN.md, "Forms and errors"). A dead or missing
 * token shows the reload text; any other word shows the try-again text, and its exact cause goes to the console.
 */
export const TOGGLE_ERRORS: ReadonlyMap<string, string> = new Map(['not a run', 'bad request'].map((word) => [word, FORGET_ERRORS.get(word)!]))
/** The words under the button for a refusal's word. No raw server word reaches the screen. */
export const toggleText = (word: string): string => refusalText(TOGGLE_ERRORS, word)
/** For the try-again text only: the raw word and status go to the console. */
export const warnToggle = (reply: { status: number; message: string }): void => warnUnknown('auto-continue', TOGGLE_ERRORS, reply)

/**
 * The Auto-continue toggle button: pressed (a blue tint and a fast-forward icon) when on, plain with a muted pause
 * icon when off. While it saves it looks disabled and ignores presses, but it is `aria-disabled`, not `disabled`, so
 * keyboard focus stays on it. A failed save's message shows under it.
 */
export function AutoContinueButtonView({ view, onPress }: { view: ToggleView; onPress: () => void }) {
  return (
    <span className="auto-toggle">
      <button
        className="btn sm lead auto-button"
        type="button"
        aria-pressed={view.on}
        aria-disabled={view.disabled || undefined}
        aria-describedby={view.error ? ERROR_ID : undefined}
        onClick={() => {
          if (!view.disabled) onPress()
        }}
      >
        <Icon name={view.on ? 'fast-forward' : 'pause'} />
        Auto-continue
      </button>
      {view.error && (
        <span id={ERROR_ID} className="auto-continue-error" role="alert">
          {view.error}
        </span>
      )}
    </span>
  )
}

/** The run header's Auto-continue button: one press posts the opposite of what it shows (`createToggleFlow`). */
export function AutoContinueButton({ target, on }: { target: RunTarget; on: boolean }) {
  const [state, setState] = useState<ToggleState>(TOGGLE_INITIAL)
  const flow = useMemo(() => createToggleFlow(target, setState, undefined, { onRefused: warnToggle }), [target.repoId, target.run])
  useEffect(() => flow.board(on), [flow, on])
  return <AutoContinueButtonView view={toggleView(on, state, toggleText)} onPress={() => flow.press()} />
}
