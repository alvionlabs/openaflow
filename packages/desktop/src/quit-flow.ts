// `app.quit()` is the one way to quit. The first `before-quit` holds the quit until the server and the terminal host
// have both stopped; their stops run together. With a live hosted session, the quit first asks, and a confirm ends
// every session (the roster's `endAll`) before the stops. Nothing here ends a resumed `claude -p` run: the roster holds
// hosted sessions only. The rules are in pod-docs/sprints/session-life.md (§8). No `electron` import: quit-main.ts
// shows the dialog.

/** Main → every window: `{ count }`, the sessions a confirmed quit ends. */
export const QUITTING_CHANNEL = 'openaflow:quitting'
/** The most labels the dialog lists; the rest read `and N more`. */
export const DETAIL_MAX = 10

export type QuitAnswer = 'end' | 'cancel'
export type QuitQuestion = { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }

/** The dialog's words. Cancel is the default and the cancel button, so Enter and Escape both keep the sessions. */
export function quitQuestion(labels: Array<string | undefined>): QuitQuestion {
  const n = labels.length
  const lines = labels.slice(0, DETAIL_MAX).map((l) => (l === undefined || l === '' ? 'a session' : l))
  if (n > DETAIL_MAX) lines.push(`and ${n - DETAIL_MAX} more`)
  return {
    message: n === 1 ? '1 session is active. Quit ends it.' : `${n} sessions are active. Quit ends them.`,
    detail: lines.join('\n'),
    buttons: ['Quit and end sessions', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  }
}

/** The page's side: the count from a `QUITTING_CHANNEL` message, or undefined for anything else. */
export const quittingCount = (payload: unknown): number | undefined => {
  const count = typeof payload === 'object' && payload !== null ? (payload as { count?: unknown }).count : undefined
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : undefined
}

export type QuitSessions = {
  /** The sessions a quit asks about: live, or waiting for their pid. */
  live(): Array<{ label?: string }>
  /** Shows the question. A throw reads as Cancel. */
  ask(q: QuitQuestion): Promise<QuitAnswer>
  /** A confirm: the windows hear the count, and the relay sends the server no more `exit` or `lost`. */
  confirmed(count: number): void
  /** A Windows shutdown: the relay goes quiet, with no word to the windows. */
  silence(): void
  /** The roster's `endAll`: flush, then end every session. */
  endAll(): Promise<void>
  /** The server failed for good: its error box came first, so no question. */
  serverFailed(): boolean
  log(line: string): void
}

export type QuitFlow = {
  beforeQuit(e: { preventDefault(): void }): void
  /** A Windows shutdown: no question; the ends start, and nothing waits. */
  sessionEnd(): void
  /**
   * For a Restart now. No live session → true with no question. Else the quit question: Cancel → false; confirm →
   * the ends, then true, and the quit after it asks nothing.
   */
  endSessions(): Promise<boolean>
}

/** Runs a stop; a throw counts as a stop that ended. */
const settled = async (stop: () => Promise<unknown>) => {
  try {
    await stop()
  } catch {
    // Quit anyway: the stop's own timeout has run, or there's nothing to wait for.
  }
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function createQuitFlow(o: { stops: Array<() => Promise<unknown>>; hide(): void; quit(): void; sessions?: QuitSessions }): QuitFlow {
  const sessions = o.sessions
  /** `asking`: a quit waits on the question or the ends. */
  let state: 'running' | 'asking' | 'stopping' | 'through' = 'running'
  /** The question or the ends under way, from a quit or from endSessions. Every caller shares it. */
  let pending: Promise<boolean> | undefined

  const stopThenQuit = async () => {
    state = 'stopping'
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

  /** Asks (unless the server failed), then ends every session. True when they ended, false on Cancel. */
  const askThenEnd = async (s: QuitSessions, live: Array<{ label?: string }>): Promise<boolean> => {
    if (!s.serverFailed()) {
      let answer: QuitAnswer
      try {
        answer = await s.ask(quitQuestion(live.map((x) => x.label)))
      } catch (err) {
        s.log(`openaflow desktop: quit question failed, so nothing ends: ${reason(err)}`)
        return false
      }
      s.log(`openaflow desktop: quit asked about ${live.length} sessions: ${answer}`)
      // A Windows shutdown while the dialog was open: its own ends are under way.
      if (answer !== 'end' || state === 'through') return false
    }
    s.confirmed(live.length)
    try {
      await s.endAll()
    } catch (err) {
      s.log(`openaflow desktop: ending sessions failed: ${reason(err)}`)
    }
    return true
  }

  /** The shared question and ends, or undefined when no session is live. */
  const endLive = (): Promise<boolean> | undefined => {
    if (pending) return pending
    const live = sessions?.live() ?? []
    if (!sessions || live.length === 0) return undefined
    const p = askThenEnd(sessions, live).finally(() => {
      if (pending === p) pending = undefined
    })
    pending = p
    return p
  }

  return {
    beforeQuit(e) {
      if (state === 'through') return
      e.preventDefault()
      // A quit while a question is open, or while the ends run, is ignored.
      if (state !== 'running' || pending) return
      const asking = endLive()
      if (!asking) {
        void stopThenQuit()
        return
      }
      state = 'asking'
      void asking.then((ended) => {
        if (state !== 'asking') return
        if (ended) void stopThenQuit()
        else state = 'running'
      })
    },
    sessionEnd() {
      state = 'through'
      if (!sessions) return
      sessions.silence()
      void sessions.endAll().catch(() => {})
    },
    async endSessions() {
      // A quit already under way decides; it ends the sessions or there are none.
      if (state === 'stopping' || state === 'through') return true
      return (await endLive()) ?? true
    },
  }
}
