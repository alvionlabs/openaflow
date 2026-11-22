import type { ReactNode } from 'react'
import './alert-banner.css'

/**
 * The banner at the top of the main column: the dot, a bold title, a muted note, and an optional action after them.
 * `kind` names the banner (`host-banner`, `reload-banner`) for the page and its tests; the look is the same.
 */
export function AlertBanner({ kind, title, note, children }: { kind: string; title: string; note: string; children?: ReactNode }) {
  return (
    <div className={`alert-banner ${kind}`} role="status">
      <span className="alert-banner-dot" aria-hidden="true" />
      <p className="alert-banner-text">
        <b>{title}</b>
        <span className="alert-banner-note">{note}</span>
      </p>
      {children}
    </div>
  )
}
