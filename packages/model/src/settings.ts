// The settings page's shapes (sprint settings, shared contract §2, §5, §6). The server reads and writes
// `<config dir>/settings.json`; the page reads `SettingsView` from `GET /api/settings`.

/** Scrollback lines per terminal: the range a setting may hold, and the default when none is stored. */
export const SETTINGS_SCROLLBACK = { min: 100, max: 100_000, default: 5_000 } as const

/** `GET /api/settings` and `POST /api/actions/settings` answer this. */
export type SettingsView = {
  scrollback: number
  /** Absent on Windows: no run wrapper and no stop command there. */
  wrapper?: {
    /** The stored text, or the platform default text. */
    runWrapper: string
    stopCommand: string
    /** Both keys absent. */
    isDefault: boolean
    defaults: { runWrapper: string; stopCommand: string }
    /** The full command a new session gets now. */
    preview: string
    /** The default wrapper with the scope probe off: the probe's reason. */
    fallback?: string
    /** The stop key is absent, but a start runs no stop (a changed or empty wrapper, or a fallback). */
    stopSkipped?: true
  }
}

/** `POST /api/actions/settings`'s body. `null` removes the key. */
export type SettingsChange = { scrollback?: number; runWrapper?: string | null; stopCommand?: string | null }
