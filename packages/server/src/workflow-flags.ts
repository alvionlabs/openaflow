// The flags that load a set-up repo's bundled workflow in `claude`, for every run kind: a new hosted session, a hosted
// Resume (session-command.ts), the `-p … --resume <id> continue` run (claude-runner.ts), and the settings preview.
//
// `--add-dir` makes the workflow folder a working folder, so claude reads the workflow's own files with no prompt. It
// also lets a session in `acceptEdits` mode edit them, and on Windows the per-user install folder is writable. So an
// Edit deny rule covers the folder. From https://code.claude.com/docs/en/permissions:
// - "Rules are evaluated in order: deny, then ask, then allow."
// - "`Edit` rules apply to all built-in tools that edit files." `Write(path)` rules don't match: "Claude Code checks
//   file permissions against `Edit(path)` and `Read(path)` rules." So the rule is `Edit(...)` alone.
// - "`//path` | Absolute path from filesystem root"; "On Windows, paths are normalized to POSIX form before matching.
//   `C:\Users\alice` becomes `/c/Users/alice`". Patterns use gitignore syntax, where "`**` matches across directories".
// `claude --help` lists `--add-dir <directories...>` and `--disallowedTools <tools...>`: each takes every word up to the
// next flag, so each is followed by a flag here, and the workflow's `--plugin-dir` comes last.

const GLOB = /[*?[\]]/g

/**
 * `Edit(//<folder>/**)`: every file under `dir`, an absolute folder. Windows paths take their POSIX form (`C:\a` is
 * `/c/a`, a share `\\host\share` is `//host/share`). Glob characters in a folder name are escaped with `\`, as gitignore
 * reads them, so they match only themselves.
 */
export function editDenyRule(dir: string, platform: NodeJS.Platform): string {
  let posix = platform === 'win32' ? dir.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, d: string) => `/${d.toLowerCase()}/`) : dir
  posix = posix.replace(/\/+$/, '')
  return `Edit(/${posix.replace(GLOB, (c) => `\\${c}`)}/**)`
}

/**
 * `--add-dir <dir> --disallowedTools <rule> --plugin-dir <dir>`. `deny: false` leaves the rule out (a path that can't
 * carry it); `quote` wraps each value (cmd.exe's line).
 */
export function workflowFlags(dir: string, o: { platform: NodeJS.Platform; deny?: boolean; quote?: (w: string) => string }): string[] {
  const q = o.quote ?? ((w: string) => w)
  const deny = o.deny === false ? [] : ['--disallowedTools', q(editDenyRule(dir, o.platform))]
  return ['--add-dir', q(dir), ...deny, '--plugin-dir', q(dir)]
}
