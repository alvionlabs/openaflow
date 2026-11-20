import { BANNER_NOTE, BANNER_TITLE } from './host-banner.ts'
import './host-banner.css'

/** The heartbeat banner: the terminals stopped answering. The screen mounts it only while the host is unresponsive. */
export function HostBanner() {
  return (
    <div className="host-banner" role="status">
      <span className="host-banner-dot" aria-hidden="true" />
      <p className="host-banner-text">
        <b>{BANNER_TITLE}</b>
        <span className="host-banner-note">{BANNER_NOTE}</span>
      </p>
    </div>
  )
}
