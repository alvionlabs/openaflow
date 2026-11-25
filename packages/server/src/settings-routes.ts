// The settings routes (sprint settings, shared contract §5). `GET /api/settings` is mounted by app.ts behind the
// read guard; `POST /api/actions/settings` goes with the other actions, behind the action guard. Both answer a
// `SettingsView`. Every server has them, dev and `pnpm start` too. Changing settings writes no action-log entry.

import type { SettingsChange, SettingsView } from '@openaflow/model'
import { Hono, type Context } from 'hono'
import { commandTextError, defaultTexts, fillWords, splitCommand, type ScopeProbe } from './run-wrapper.ts'
import { isScrollback, type Settings, type SettingsStore } from './settings-store.ts'

export type SettingsRouteDeps = {
  store: Pick<SettingsStore, 'read' | 'change'>
  platform: NodeJS.Platform
  /** The server start's scope probe. None (dev, `pnpm start`): the default wrapper shows with no fallback. */
  probe?: () => Promise<ScopeProbe>
  /** The `claude` a new session would start, read at each answer. */
  claude(): string | undefined
  /** The hooks plugin folder a new session loads. */
  pluginDir: string | undefined
  /** The bundled workflow plugin folder a set-up repo's new session also loads, read at each answer. None: no bundle. */
  workflowDir(): string | undefined
}

const TEXT_KEYS = ['runWrapper', 'stopCommand'] as const
const KNOWN = new Set<string>(['scrollback', ...TEXT_KEYS])
const ERROR_WORD = { runWrapper: 'run wrapper', stopCommand: 'stop command' } as const

/** A preview word: as it is, or in double quotes (with `"` as `\"`) when it is empty or holds a space or a quote. */
const quote = (w: string) => (w === '' || /[ "']/.test(w) ? `"${w.replace(/"/g, '\\"')}"` : w)

/** The words of a text, or none for a bad one (the store reads only good texts). */
const wordsOf = (text: string) => {
  const split = splitCommand(text)
  return 'error' in split ? [] : split.words
}

/**
 * The view of `settings`: the wrapper section on Linux and macOS only, with the preview of a new session's command.
 * With a workflow folder, the preview is a set-up repo's command: both `--plugin-dir` flags and the workflow's `--add-dir`.
 */
export function settingsView(
  settings: Settings,
  o: { platform: NodeJS.Platform; probe?: ScopeProbe | undefined; claude: string | undefined; pluginDir: string | undefined; workflowDir?: string | undefined },
): SettingsView {
  if (o.platform === 'win32') return { scrollback: settings.scrollback }
  const defaults = defaultTexts(o.platform)
  const isDefaultWrapper = settings.runWrapper === undefined
  const fallback = isDefaultWrapper && defaults.runWrapper !== '' && o.probe !== undefined && !o.probe.on ? o.probe.reason : undefined
  const wrapperWords = fallback !== undefined ? [] : wordsOf(settings.runWrapper ?? defaults.runWrapper)
  const words = [
    ...fillWords(wrapperWords, '<run id>'),
    o.claude ?? 'claude',
    '--session-id',
    '<session id>',
    '--plugin-dir',
    o.pluginDir ?? '<plugin dir>',
    // A set-up repo's session; with no bundle, every session starts with the hooks plugin only.
    ...(o.workflowDir === undefined ? [] : ['--add-dir', o.workflowDir, '--plugin-dir', o.workflowDir]),
    '/pod:plan <your text>',
  ]
  // The default stop runs only with the default wrapper in force.
  const stopSkipped = settings.stopCommand === undefined && defaults.stopCommand !== '' && (!isDefaultWrapper || fallback !== undefined)
  return {
    scrollback: settings.scrollback,
    wrapper: {
      runWrapper: settings.runWrapper ?? defaults.runWrapper,
      stopCommand: settings.stopCommand ?? defaults.stopCommand,
      isDefault: isDefaultWrapper && settings.stopCommand === undefined,
      defaults: { ...defaults },
      preview: words.map(quote).join(' '),
      ...(fallback !== undefined ? { fallback } : {}),
      ...(stopSkipped ? { stopSkipped: true as const } : {}),
    },
  }
}

/** The change a body asks for, or the §5 error: `bad request`, `bad scrollback`, `run wrapper: …`, `stop command: …`. */
export function readChange(body: unknown, platform: NodeJS.Platform): SettingsChange | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'bad request' }
  const b = body as Record<string, unknown>
  const keys = Object.keys(b)
  if (keys.length === 0 || keys.some((k) => !KNOWN.has(k))) return { error: 'bad request' }
  if ('scrollback' in b && typeof b.scrollback !== 'number') return { error: 'bad request' }
  for (const key of TEXT_KEYS) {
    if (!(key in b)) continue
    if (platform === 'win32' || !(typeof b[key] === 'string' || b[key] === null)) return { error: 'bad request' }
  }
  if ('scrollback' in b && !isScrollback(b.scrollback)) return { error: 'bad scrollback' }
  const change: SettingsChange = {}
  if ('scrollback' in b) change.scrollback = b.scrollback as number
  const defaults = defaultTexts(platform)
  for (const key of TEXT_KEYS) {
    if (!(key in b)) continue
    const text = b[key] as string | null
    if (text === null) {
      change[key] = null
      continue
    }
    const word = commandTextError(text)
    if (word !== undefined) return { error: `${ERROR_WORD[key]}: ${word}` }
    // The default text, typed again, is stored as absent: the setting follows the default.
    change[key] = text.trim() === defaults[key] ? null : text
  }
  return change
}

/** `GET /api/settings`, mounted at /api/settings. */
export function createSettingsRead(deps: SettingsRouteDeps): Hono {
  return new Hono().get('/', async (c) => c.json(await viewOf(deps, await deps.store.read())))
}

/** `POST /api/actions/settings`, mounted with the action routes. */
export function createSettingsActions(deps: SettingsRouteDeps): Hono {
  return new Hono().post('/settings', async (c) => {
    const change = readChange(await jsonOf(c), deps.platform)
    if ('error' in change) return c.json({ error: change.error }, 400)
    let settings: Settings
    try {
      settings = await deps.store.change(change)
    } catch {
      return c.json({ error: 'not saved' }, 500)
    }
    return c.json(await viewOf(deps, settings))
  })
}

async function viewOf(deps: SettingsRouteDeps, settings: Settings): Promise<SettingsView> {
  // A server with a probe began it at its start; this waits only for its first answer.
  const probe = deps.platform === 'win32' ? undefined : await deps.probe?.()
  return settingsView(settings, { platform: deps.platform, probe, claude: deps.claude(), pluginDir: deps.pluginDir, workflowDir: deps.workflowDir() })
}

async function jsonOf(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}
