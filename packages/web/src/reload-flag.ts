// The one app-wide "reload needed" flag. After an API restart the page's token is stale, and every request with it
// gets 403 `bad token`; only a page reload gets a new token. Each request path calls `staleToken` on its reply, so
// the check lives here once. The first stale reply sets the flag, and the Reload banner (ReloadBanner.tsx) shows
// until the page reloads. Nothing clears it: a reload starts a new page with a new flag.

export type ReloadFlag = {
  /** Whether a request found the page's token stale or missing. */
  get(): boolean
  /** Sets the flag. Listeners hear only the first set. */
  set(): void
  subscribe(fn: () => void): () => void
}

export function createReloadFlag(): ReloadFlag {
  let on = false
  const listeners = new Set<() => void>()
  return {
    get: () => on,
    set() {
      if (on) return
      on = true
      for (const fn of listeners) fn()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/** The page's flag. */
export const reloadFlag: ReloadFlag = createReloadFlag()

/**
 * Whether a reply says the page's token is stale (HTTP 403 with the error word `bad token`). When it does, the
 * page's flag is set. Any other status or word (a refused value, an outage) leaves the flag as it is.
 */
export function staleToken(status: number, error: unknown, flag: ReloadFlag = reloadFlag): boolean {
  if (status !== 403 || error !== 'bad token') return false
  flag.set()
  return true
}

/** No token on the page at all: a reload is the only way to get one, so the flag is set as for a stale token. */
export function noToken(flag: ReloadFlag = reloadFlag): void {
  flag.set()
}

/** The banner's words: the full sentence lives only here. */
export const RELOAD_TITLE = 'OpenAFlow restarted in the background.'
export const RELOAD_NOTE = 'Reload to continue.'
