// Open at login on Linux: Electron's login item API does nothing there, so the app writes an XDG autostart file.
// No `node:` import: the fs comes in, so the tests use a fake and the sandboxed preload may import login-item.ts.
// Paths are POSIX strings. The rules are in pod-docs/sprints/settings.md §7.

export const AUTOSTART_FILE = 'openaflow.desktop'

/** The calls the autostart file needs. `readFile` and `remove` throw an error with `code: 'ENOENT'` for no file. */
export type AutostartFs = {
  readFile(path: string): string
  /** Makes the folder and its parents. */
  mkdir(path: string): void
  writeFile(path: string, text: string, mode: number): void
  rename(from: string, to: string): void
  remove(path: string): void
}

type Env = Record<string, string | undefined>

const absolute = (value: string | undefined): string | undefined => (value !== undefined && value.startsWith('/') ? value.replace(/\/+$/, '') || '/' : undefined)
const join = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)

/** `OPENAFLOW_AUTOSTART_DIR`, else `$XDG_CONFIG_HOME/autostart`, else `~/.config/autostart`. A relative value is skipped. */
export function autostartDir(env: Env, home: string): string {
  const own = absolute(env.OPENAFLOW_AUTOSTART_DIR)
  if (own !== undefined) return own
  const config = absolute(env.XDG_CONFIG_HOME)
  return join(config ?? join(home, '.config'), 'autostart')
}

/** One word in double quotes, escaped for the Exec key, then for a desktop-entry string, then for field codes. */
const execWord = (word: string) => `"${word.replace(/["`$\\]/g, '\\$&')}"`.replaceAll('\\', '\\\\').replaceAll('%', '%%')

/** The value of the `Exec=` key: the program, then the args, each quoted. */
export const execValue = (program: string, args: readonly string[]): string => [program, ...args].map(execWord).join(' ')

export const desktopEntry = (exec: string): string =>
  ['[Desktop Entry]', 'Type=Application', 'Name=OpenAFlow', `Exec=${exec}`, 'X-GNOME-Autostart-enabled=true', ''].join('\n')

const isMissing = (err: unknown) => (err as { code?: unknown } | null)?.code === 'ENOENT'

/** A key's value, with the spaces around `=` allowed by the spec, or undefined. */
const keyIs = (line: string, key: string, value: string) => {
  const at = line.indexOf('=')
  return at > 0 && line.slice(0, at).trim() === key && line.slice(at + 1).trim() === value
}

const turnedOff = (lines: readonly string[]) => lines.some((l) => keyIs(l, 'Hidden', 'true') || keyIs(l, 'X-GNOME-Autostart-enabled', 'false'))

/** The program of an `Exec=` value written by execValue with these args, or undefined: one absolute word that
 * execWord gives back unchanged, then exactly the args. */
function ownProgram(value: string, args: readonly string[]): string | undefined {
  const tail = ` ${args.map(execWord).join(' ')}`
  if (!value.endsWith(tail)) return undefined
  const word = value.slice(0, -tail.length)
  const unstring = word.replaceAll('%%', '%').replace(/\\\\/g, '\\')
  if (!/^".*"$/s.test(unstring)) return undefined
  const program = unstring.slice(1, -1).replace(/\\(.)/gs, '$1')
  return program.startsWith('/') && execWord(program) === word ? program : undefined
}

export function createAutostart(o: { fs: AutostartFs; dir: string; program: string; args: readonly string[] }) {
  const file = join(o.dir, AUTOSTART_FILE)
  const exec = execValue(o.program, o.args)
  /** Writes a temp file beside it, then renames it. Throws when that fails. */
  const save = (text: string) => {
    o.fs.mkdir(o.dir)
    // Not `.desktop`, so a desktop that watches the folder never reads a half-written entry.
    const temp = join(o.dir, `.${AUTOSTART_FILE}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
    try {
      o.fs.writeFile(temp, text, 0o644)
      o.fs.rename(temp, file)
    } catch (err) {
      try {
        o.fs.remove(temp)
      } catch {
        // Not written, or gone.
      }
      throw err
    }
  }
  /** The file's text, or undefined for no file. Any other read error throws. */
  const read = (): string | undefined => {
    try {
      return o.fs.readFile(file)
    } catch (err) {
      if (isMissing(err)) return undefined
      throw err
    }
  }
  return {
    /** On only for the app's own `Exec=` line, not hidden and not turned off. A read error other than no file throws. */
    isOn(): boolean {
      const text = read()
      if (text === undefined) return false
      const lines = text.split(/\r?\n/)
      return lines.includes(`Exec=${exec}`) && !turnedOff(lines)
    },
    /** Writes or deletes the file. Throws when that fails; no file to delete is fine. */
    write(on: boolean): void {
      if (!on) {
        try {
          o.fs.remove(file)
        } catch (err) {
          if (!isMissing(err)) throw err
        }
        return
      }
      save(desktopEntry(exec))
    },
    /**
     * Points an on entry of the app's own at this program, when it names another one: an update moves the AppImage.
     * Own: a `Name=OpenAFlow` line and one `Exec=` line, of one absolute program and these args. A missing, turned-off,
     * or foreign file stays as it is. Answers the old program when it rewrote. Throws when the read or the write fails.
     */
    repair(): string | undefined {
      const text = read()
      if (text === undefined) return undefined
      const parts = text.split(/(\r?\n)/)
      const lines = parts.filter((_, i) => i % 2 === 0)
      if (lines.includes(`Exec=${exec}`) || turnedOff(lines) || !lines.includes('Name=OpenAFlow')) return undefined
      const execAt = parts.flatMap((l, i) => (i % 2 === 0 && l.slice(0, Math.max(l.indexOf('='), 0)).trim() === 'Exec' ? [i] : []))
      if (execAt.length !== 1) return undefined
      const at = execAt[0]!
      const line = parts[at]!
      const old = line.startsWith('Exec=') ? ownProgram(line.slice('Exec='.length), o.args) : undefined
      if (old === undefined) return undefined
      parts[at] = `Exec=${exec}`
      save(parts.join(''))
      return old
    },
  }
}
