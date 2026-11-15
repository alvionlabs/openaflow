// `app.quit()` is the one way to quit. The first `before-quit` holds the quit until the server and the terminal host
// have both stopped; their stops run together. Nothing here forces a quit or ends another process, so a resumed
// `claude` keeps running.

export type QuitFlow = {
  beforeQuit(e: { preventDefault(): void }): void
  /** A Windows shutdown: nothing waits, and the server's parent watch does the rest. */
  sessionEnd(): void
}

/** Runs a stop; a throw counts as a stop that ended. */
const settled = async (stop: () => Promise<unknown>) => {
  try {
    await stop()
  } catch {
    // Quit anyway: the stop's own timeout has run, or there's nothing to wait for.
  }
}

export function createQuitFlow(o: { stops: Array<() => Promise<unknown>>; hide(): void; quit(): void }): QuitFlow {
  let state: 'running' | 'stopping' | 'through' = 'running'
  const stopThenQuit = async () => {
    try {
      o.hide()
    } catch {
      // A window that's gone needs no hiding.
    }
    await Promise.all(o.stops.map(settled))
    // A session end during the stop already let the quit through.
    if (state !== 'stopping') return
    state = 'through'
    o.quit()
  }
  return {
    beforeQuit(e) {
      if (state === 'through') return
      e.preventDefault()
      if (state === 'stopping') return
      state = 'stopping'
      void stopThenQuit()
    },
    sessionEnd() {
      state = 'through'
    },
  }
}
