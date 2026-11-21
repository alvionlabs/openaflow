import { AlertBanner } from '../../components/AlertBanner.tsx'
import { BANNER_NOTE, BANNER_TITLE } from './host-banner.ts'

/** The heartbeat banner: the terminals stopped answering. The screen mounts it only while the host is unresponsive. */
export function HostBanner() {
  return <AlertBanner kind="host-banner" title={BANNER_TITLE} note={BANNER_NOTE} />
}
