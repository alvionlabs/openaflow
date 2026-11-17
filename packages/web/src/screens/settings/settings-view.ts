// The settings page with no DOM (settings §8): what it shows for a SettingsView, and how each change saves at once.
// SettingsScreen.tsx only wires it.

import type { SettingsView } from '@openaflow/model'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'

/** The answer of GET /api/settings and POST /api/actions/settings, or undefined when it isn't one. */
export function parseSettingsView(data: unknown): SettingsView | undefined {
  if (!isObject(data) || typeof data.scrollback !== 'number' || !Number.isInteger(data.scrollback)) return undefined
  if (data.wrapper === undefined) return { scrollback: data.scrollback }
  const w = data.wrapper
  if (!isObject(w) || !isText(w.runWrapper) || !isText(w.stopCommand) || typeof w.isDefault !== 'boolean' || !isText(w.preview)) return undefined
  if (!isObject(w.defaults) || !isText(w.defaults.runWrapper) || !isText(w.defaults.stopCommand)) return undefined
  if (w.fallback !== undefined && !isText(w.fallback)) return undefined
  if (w.stopSkipped !== undefined && w.stopSkipped !== true) return undefined
  return {
    scrollback: data.scrollback,
    wrapper: {
      runWrapper: w.runWrapper,
      stopCommand: w.stopCommand,
      isDefault: w.isDefault,
      defaults: { runWrapper: w.defaults.runWrapper, stopCommand: w.defaults.stopCommand },
      preview: w.preview,
      ...(w.fallback !== undefined ? { fallback: w.fallback } : {}),
      ...(w.stopSkipped ? { stopSkipped: true as const } : {}),
    },
  }
}
