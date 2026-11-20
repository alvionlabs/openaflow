import { overlayView } from './host-banner.ts'
import './host-banner.css'

/** The page while a confirmed quit ends the sessions: a dot and a line, no buttons. It stays until the window closes. */
export function QuitOverlay({ count }: { count: number }) {
  const view = overlayView(count)
  if (!view) return null
  return (
    <div className="quit-overlay">
      <p className="quit-overlay-line" role={view.role}>
        <span className="status s-run">{view.text}</span>
      </p>
    </div>
  )
}
