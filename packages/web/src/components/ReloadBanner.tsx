import { useSyncExternalStore } from 'react'
import { reloadFlag, RELOAD_NOTE, RELOAD_TITLE, type ReloadFlag } from '../reload-flag.ts'
import { AlertBanner } from './AlertBanner.tsx'

/** The banner after an API restart: why the actions fail, and the one button that fixes it. */
export function ReloadBannerView({ onReload }: { onReload: () => void }) {
  return (
    <AlertBanner kind="reload-banner" title={RELOAD_TITLE} note={RELOAD_NOTE}>
      <button className="btn sm" type="button" onClick={onReload}>
        Reload
      </button>
    </AlertBanner>
  )
}

/** Loads the page again: a new page gets a new token. */
export const reloadPage = () => location.reload()

/**
 * The Reload banner once any request finds the page's token stale (reload-flag.ts), until the page reloads. Each
 * screen's main column mounts it first, above the host banner: it holds the only way out.
 */
export function ReloadBanner({ flag = reloadFlag, reload = reloadPage }: { flag?: ReloadFlag | undefined; reload?: () => void }) {
  const shown = useSyncExternalStore(flag.subscribe, flag.get, flag.get)
  return shown ? <ReloadBannerView onReload={reload} /> : null
}
