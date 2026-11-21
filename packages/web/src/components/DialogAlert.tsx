import { useSyncExternalStore } from 'react'
import { RELOAD } from '../actions-client.ts'
import { reloadFlag, type ReloadFlag } from '../reload-flag.ts'
import { ModalAlert } from './ModalAlert.tsx'
import { reloadPage } from './ReloadBanner.tsx'

/**
 * Whether a dialog's error offers its own Reload: the line is the stale-token words and a request found the token
 * stale. A dialog's backdrop covers the Reload banner, so the dialog needs the button itself.
 */
export const offersReload = (message: string, stale: boolean): boolean => stale && message === RELOAD

/** A dialog's error box: the shared alert, with Reload beside the line for a stale token (the banner's reload). */
export function DialogAlert({ message, id, flag = reloadFlag, reload = reloadPage }: { message: string; id?: string | undefined; flag?: ReloadFlag; reload?: () => void }) {
  const stale = useSyncExternalStore(flag.subscribe, flag.get, flag.get)
  return <ModalAlert message={message} id={id} onReload={offersReload(message, stale) ? reload : undefined} />
}
