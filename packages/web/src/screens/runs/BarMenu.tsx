import { useState, type RefObject } from 'react'
import type { BoardRepo } from '@openaflow/model'
import { terminalBridge } from '../../desktop-bridge.ts'
import { Icon } from '../../theme/icons.tsx'
import type { ChoiceStorage } from '../../theme/theme.ts'
import { ForgetRunItem, RemoveRepoItem, useMenu } from './menu-parts.tsx'
import { NewSessionDialog } from './NewSessionDialog.tsx'
import { menuRepo } from './new-session-flow.ts'
import { ThemeControl } from './ThemeControl.tsx'
import './menu.css'

/** The menu's last items, each after a confirm: Forget drops the selected run's claim, Remove its repo. */
type MenuAction = { onPick: () => void }

/** The ⋯ trigger's id: the remove confirm sends focus back to it when it closes. */
export const MENU_TRIGGER_ID = 'run-menu-trigger'

export type BarMenuViewProps = {
  open: boolean
  onToggle: () => void
  /** Called when a theme is picked; the menu stays open. */
  onThemePick?: () => void
  portBase?: number
  /** New session: opens its modal. Only in the desktop app (`menuRepo`). */
  newSession?: MenuAction
  forget?: MenuAction
  remove?: MenuAction
  /** Where the theme is read from and saved; the page's local storage when not given. */
  storage?: ChoiceStorage
  triggerRef?: RefObject<HTMLButtonElement | null>
  menuRef?: RefObject<HTMLDivElement | null>
}

/** The trigger and, when open, the menu. */
export function BarMenuView({ open, onToggle, onThemePick, portBase, newSession, forget, remove, storage, triggerRef, menuRef }: BarMenuViewProps) {
  return (
    <div className="bar-menu">
      <button ref={triggerRef} id={MENU_TRIGGER_ID} type="button" className="btn sm icon ghost" aria-label="Menu" aria-expanded={open} onClick={onToggle}>
        <Icon name="more" />
      </button>
      {open && (
        <div ref={menuRef} className="menu bar-menu-panel" role="group" aria-label="Menu">
          <div className="mi mi-block">
            <ThemeControl storage={storage} onPick={onThemePick} />
          </div>
          {portBase !== undefined && (
            <div className="mi">
              <span>Ports</span>
              <span className="mi-note mono">{portBase}</span>
            </div>
          )}
          {newSession && (
            <button type="button" className="mi mi-action" aria-haspopup="dialog" onClick={newSession.onPick}>
              New session
            </button>
          )}
          {(forget || remove) && <hr />}
          {forget && <ForgetRunItem onPick={forget.onPick} />}
          {remove && <RemoveRepoItem onPick={remove.onPick} />}
        </div>
      )}
    </div>
  )
}

/**
 * The run header's ⋯ menu: the theme, the run's port base, New session (desktop app only), Forget this run, and Remove
 * repo. Auto-continue is a button in the run header, not here. The screen keys the menu by run, so a new run gets a
 * closed menu. `newSession`: the selected run's repo, which the New session modal starts in; the modal gets each Board's
 * copy of it, to see the new session's marker.
 */
export function BarMenu({ portBase, newSession, forget, remove }: { portBase?: number; newSession?: BoardRepo | undefined; forget?: MenuAction; remove?: MenuAction }) {
  const { open, send, triggerRef, menuRef } = useMenu('')
  const [starting, setStarting] = useState(false)
  const repo = menuRepo(newSession, terminalBridge())
  return (
    <>
      <BarMenuView
        open={open}
        onToggle={() => send('toggle')}
        onThemePick={() => send('pick-theme')}
        portBase={portBase}
        {...(repo ? { newSession: { onPick: () => (send('pick-remove'), setStarting(true)) } } : {})}
        {...(forget ? { forget: { onPick: () => (send('pick-remove'), forget.onPick()) } } : {})}
        {...(remove ? { remove: { onPick: () => (send('pick-remove'), remove.onPick()) } } : {})}
        triggerRef={triggerRef}
        menuRef={menuRef}
      />
      {starting && repo && <NewSessionDialog repo={repo} onClose={() => setStarting(false)} />}
    </>
  )
}
