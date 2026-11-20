// The host's settings from its environment. host-entry.ts reads them once at start.

export const DEFAULT_SCROLLBACK = 5_000
export const SCROLLBACK = { min: 100, max: 100_000 }

/**
 * Lines each session keeps above its screen: `OPENAFLOW_SCROLLBACK`, a whole number from 100 to 100,000. Unset or
 * empty gives 5,000. Any other value gives 5,000 and one log line for the host's log.
 */
export function scrollbackFrom(env: Record<string, string | undefined>): { scrollback: number; log?: string } {
  const value = env.OPENAFLOW_SCROLLBACK
  if (value === undefined || value === '') return { scrollback: DEFAULT_SCROLLBACK }
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (n >= SCROLLBACK.min && n <= SCROLLBACK.max) return { scrollback: n }
  return {
    scrollback: DEFAULT_SCROLLBACK,
    log: `openaflow pty host: OPENAFLOW_SCROLLBACK must be a whole number from ${SCROLLBACK.min} to ${SCROLLBACK.max}, not ${JSON.stringify(value)}; using ${DEFAULT_SCROLLBACK}`,
  }
}
