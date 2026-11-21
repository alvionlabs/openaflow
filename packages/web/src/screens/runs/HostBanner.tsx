import { AlertBanner } from '../../components/AlertBanner.tsx'
import { ReloadBanner } from '../../components/ReloadBanner.tsx'
import type { ReloadFlag } from '../../reload-flag.ts'
import { BANNER_NOTE, BANNER_TITLE } from './host-banner.ts'

/** The heartbeat banner: the terminals stopped answering. The screen mounts it only while the host is unresponsive. */
export function HostBanner() {
  return <AlertBanner kind="host-banner" title={BANNER_TITLE} note={BANNER_NOTE} />
}

/**
 * The banners at the top of the main column. The Reload banner comes first: it holds the only action, and a reload
 * also starts the host watch again.
 */
export function TopBanners({ reloadFlag, hostDown }: { reloadFlag?: ReloadFlag | undefined; hostDown: boolean }) {
  return (
    <>
      <ReloadBanner flag={reloadFlag} />
      {hostDown && <HostBanner />}
    </>
  )
}
