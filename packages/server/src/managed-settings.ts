// Claude Code's managed settings file, read only for `disableSideloadFlags`: when it is on, claude refuses the
// `--plugin-dir` flags every hosted session starts with. The rule is sprint default-workflow §7. The app never
// matches the text claude prints; this file is the one signal.

import { readFile } from 'node:fs/promises'

/** Where Claude Code reads its managed settings on `platform`. Any other platform reads as Linux does. */
export function managedSettingsPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  return '/etc/claude-code/managed-settings.json'
}

/** True only when `file` parses to an object whose `disableSideloadFlags` is `true`. Missing, unreadable, or invalid: false. */
export async function blocksSideload(file: string): Promise<boolean> {
  let json: unknown
  try {
    json = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return false
  }
  if (typeof json !== 'object' || json === null) return false
  return (json as { disableSideloadFlags?: unknown }).disableSideloadFlags === true
}
