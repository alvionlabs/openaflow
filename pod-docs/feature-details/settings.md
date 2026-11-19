# Settings

## What it is

The settings page sets four things: Open at login, the scrollback of new terminals, the run wrapper, and the stop command. The page opens from the sidebar's **Settings** button, from the tray's **Settings**, and from **Open settings** under a wrapper error. Its hash is `#settings`. The server keeps the values in `<config dir>/settings.json`. Open at login is the desktop's own, not the server's. The shapes are in [the settings sprint's shared contract](../sprints/settings.md) (§2–§8). Hosted sessions are in [hosted-sessions.md](hosted-sessions.md); the terminal host is in [terminal-host.md](terminal-host.md); the tray and the preload are in [desktop.md](desktop.md).

## How it works

- **Settings file** (`settings-store.ts`, `<config dir>/settings.json`): `{v: 1, scrollback?, runWrapper?, stopCommand?}`. Every server reads and writes it: the desktop's, `pnpm dev`, and `pnpm start`. It is read at each use (each `GET /api/settings`, each New session and Resume start), with no cache, so a hand edit applies to the next start.
  - An absent key is the default. `""` means none. Defaults: scrollback 5,000. Linux: run wrapper `systemd-run --user --scope --quiet --unit=openaflow-run-{runId}.scope`, stop command `systemctl --user stop openaflow-run-{runId}.scope`. macOS: both `""`. Windows: no wrapper and no stop, and it ignores stored texts.
  - A missing file is all defaults. A file that isn't JSON, isn't an object, or has `v` other than 1 is all defaults, with one log line `openaflow: settings.json can't be read; using defaults`. A read never rewrites it. A bad key (scrollback out of range, a text that breaks the text rules) gets its default, with one line `openaflow: settings.json has a bad <key>; using its default`. The other keys still apply.
  - A change writes the whole file to a temp file beside it, then renames it, mode 0600. Changes run one at a time, each on the file as it is then, so two quick changes both land. A change replaces a file that can't be read.
- **Command text rules** (`splitCommand`, `commandTextError`, `resolveProgram` in `run-wrapper.ts`), for the run wrapper and the stop command:
  - At most 1,024 characters, and no control character. Only a space separates words. `"…"` and `'…'` group, the quotes go, and nothing escapes inside them. Quoted and plain parts that touch make one word (`a"b c"` → `ab c`).
  - Words: `bad text`, `too long`, `unclosed quote`, `too many words` (over 32), `unknown placeholder {name}`, `no program` (an empty first word). Other braces are literal. Empty or all-space text is none.
  - Placeholders fill per word, after the split, so a value never makes a new word: `{runId}` → the run marker; `{unit}` → `openaflow-run-<run marker>.scope`. A filled word over 1,024 characters is `too long`; the save checks this with a sample id.
  - The first word must be an absolute path to a file, or a bare name (no `/`) found on the session env's PATH. Else `<word> not found`. This check runs at each start, not at save, because PATH can change.
- **At each start** (`createRunWrapper().plan` and `applyPlan`; New session and Resume; Linux and macOS):
  - Run wrapper absent on Linux: the default words with the scope probe's absolute `systemd-run`, while the probe is on. Probe off: no wrapper, and nothing is refused.
  - Run wrapper changed (non-empty stored text): the program check, then the **wrapper check**: `<program> <filled args…> <absolute true>`, with `{runId}` as a fresh UUID v4 (never the session's marker), the session env, cwd `/`, no shell, at most 5 s. Exit 0 passes, and that exact text passes with no check for the rest of this server's life. A failure is never kept. `true` not on PATH: no check, one log line `openaflow: true not found; the run wrapper starts with no check`. The start then runs the wrapper's program and args, then the `claude` program and args.
  - Run wrapper `""`: no wrapper.
  - Stop command changed: its program check, then it goes with any wrapper. It never runs as a check. `""`: no stop. Absent: the default stop words (absolute `systemctl`) only while the default wrapper is in force with the probe on, else no stop.
  - A refusal answers `409 {error:'run wrapper: <word>'}` or `409 {error:'stop command: <word>'}`. `<word>` is the not-found word, or the check's: `exit N: <stderr first line>`, `killed by <signal>`, `no answer in 5 s`, or `could not start: <code>`. New session refuses after `409 claude not found` and before `409 session starting`; Resume after the first `404 no session`. A refusal saves no record, writes no action-log entry, and logs one line `openaflow: session start refused: <error>`.
  - The spec's `scrollback` is the setting. The record keeps what its start used: `scrollback` (100–100,000) and `stop`. A bad stored value is dropped on read, and the record stays. The sweep sends each record's own `stop`, whatever the settings are now.
- **Routes** (`settings-routes.ts`; every server, dev and `pnpm start` too):
  - `GET /api/settings`, behind the read guard (the token, no `Origin`) → `200 SettingsView`. No token → `403 bad token`.
  - `POST /api/actions/settings`, behind the action guard, with `{scrollback?, runWrapper?, stopCommand?}` → `200 SettingsView` after the write. `null` removes a key. A text whose trimmed value is the platform default is stored as absent. Only the keys sent change. Errors, first match: `400 bad request` (not an object, no known key, an unknown key, a wrong type, or a wrapper key on Windows); `400 bad scrollback` (not a whole number from 100 to 100,000); `400 run wrapper: <word>`; `400 stop command: <word>`; `500 not saved` (the file stays as before).
  - `SettingsView`: `scrollback`, and on Linux and macOS `wrapper`: the two texts (stored, or the default), `isDefault` (both keys absent), `defaults`, `preview`, `fallback?`, and `stopSkipped?`. `preview` is the full command a new session gets now: the wrapper words (`{runId}` as `<run id>`), the `claude` path (or `claude`), `--session-id <session id> --plugin-dir <plugin dir>`, and `/pod:plan <your text>`. A word that is empty or holds a space or a quote is in double quotes. `fallback` is the probe's reason when the default wrapper is in force and the probe is off. `stopSkipped` is set when the stop key is absent but no stop runs (a changed or empty wrapper, or a fallback). A server with no probe (dev, `pnpm start`) shows the default wrapper words with no `fallback`.
  - Changing settings writes no action-log entry.
- **Scrollback.** The pty host takes `StartSpec.scrollback`: not a whole number from 100 to 100,000 → `start-failed` `bad scrollback`, checked after `bad screen file`. Absent: the host's own value (`OPENAFLOW_SCROLLBACK`, else 5,000). The Board's `HostedSession.scrollback` comes from the record. The page's xterm takes `session.scrollback ?? 5_000` (`terminalOptions` in `terminal-tab.ts`; xterm's own default is 1,000). A change applies to new sessions only.
- **Open at login** (`login-item.ts`, `login-autostart.ts`, glue in `login-item-main.ts`). The preload gives `window.openaflow.openAtLogin()` and `setOpenAtLogin(on)`, on `openaflow:login-item:get` and `openaflow:login-item:set`. The folder bridge's sender rule applies: any other caller gets `forbidden`. A non-boolean gets `bad request`; a read that throws gets `login item failed`. `setOpenAtLogin` answers the state read after the write, so a failed write answers the old state.
  - Windows and macOS: Electron's login item API, with `--hidden` (unpackaged: the app folder, then `--hidden`). On Windows this is the `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value.
  - Linux: Electron's API does nothing there, so the app writes `<dir>/openaflow.desktop`. `<dir>`: `OPENAFLOW_AUTOSTART_DIR` (absolute only), else `$XDG_CONFIG_HOME/autostart` (absolute only), else `~/.config/autostart`. The file: `[Desktop Entry]`, `Type=Application`, `Name=OpenAFlow`, `Exec=<exec>`, `X-GNOME-Autostart-enabled=true`. `<exec>` is the program (`$APPIMAGE` when packaged with it set, else the executable), then the args, each in double quotes and escaped for the `Exec` key. It reads as on only with that exact `Exec=` line and no `Hidden=true` or `X-GNOME-Autostart-enabled=false`. On makes the folder, writes a temp file, and renames it (mode 0644). Off deletes only that file.
  - Linux, at each start from an AppImage (a `--hidden` start too): an update moves the AppImage to a new versioned name, so `repairLoginItem` points the entry at `$APPIMAGE`. It rewrites only the `Exec=` line, through the same temp file and rename, and only when the file is the app's own and on: an exact `Name=OpenAFlow` line, exactly one `Exec=` key, its value one absolute program in the app's own quoting and then exactly the current args, and no `Hidden=true` or `X-GNOME-Autostart-enabled=false`. A missing, turned-off, or foreign file stays as it is, and so does a run that is not an AppImage (linux-unpacked, unpackaged). A failed read or write logs one line, and the start goes on. A moved AppImage reads as off until the next start from it.
- **Tray.** Open, Settings, Quit. Settings shows the window on `#settings` (`bus.showWindow('#settings')`, which sets the hash in the page with no reload).
- **Page** (`packages/web/src/screens/settings/`; rules in `settings-view.ts`, requests in `settings-client.ts`). On `#settings`, the main column shows the page and the sidebar stays. The selection never rewrites the hash, and a reload stays there. **Back** goes to the hash before `#settings`, else `''`; focus then goes to the sidebar's Settings button. Sections: **General** (desktop only): the Open at login switch, "Start OpenAFlow in the tray when you sign in."; **Terminals**: Scrollback, "lines per terminal"; **Run wrapper** (only with `wrapper`): Wrapper command, Stop command, "Full command for a new session", the `fallback` line, the `stopSkipped` line "The default stop command runs only with the default run wrapper.", and **Reset to default** (off when `isDefault`; it posts `{runWrapper: null, stopCommand: null}`). Each change saves at once: the switch on change; a field on blur or Enter when its text changed. Escape puts the saved text back. A refused save shows the server's word under its field (`aria-invalid`) and keeps the typed text. A failed load shows "Couldn't load settings. Please try again" with **Try again**. A switch answer that differs from the ask, or a rejection, shows "Couldn't change Open at login".
- **Open settings on a wrapper error** (`wrapperError` in `new-session-flow.ts`). An error that starts with `run wrapper: ` or `stop command: ` shows the title ("The session didn't start" in the New session form, "The session didn't resume" in the stop bar's alert box), "Your run wrapper failed:" or "Your stop command failed:", the rest as code, and **Open settings**, which moves the page to `#settings`. In the ⋯ menu's modal, Open settings also closes the modal.

## Electron checks

`packages/desktop/src/real-settings.test.ts` runs in the real app through the Electron harness, unpackaged, on Linux and Windows. `claude` is `packages/desktop/test/fixtures/settings-claude.mjs`: it prints `--lines N` numbered lines (from its args, or from inside its prompt arg), then echoes each line it reads, as `fake-session-claude.mjs` does. A changed wrapper is a plain `sh` script, so CI needs no user bus.

- **Scrollback applies to new sessions:** scrollback 200, set through the page, then a New session that prints 1,000 lines keeps at most 200 lines plus its rows in the host's snapshot. A session started before the change keeps 5,000.
- **Changed wrapper and stop** (Linux): a wrapper script that writes `{runId}` to a file and runs the rest gets the session's marker, and the fake `claude` gets its args. A changed stop script runs with the marker at a confirmed quit.
- **Broken wrapper stops the start** (Linux): a wrapper that exits 3 with `bad option` gives `409 run wrapper: exit 3: bad option` and no record, and the form's **Open settings** shows the page.
- **Open at login on Linux:** `setOpenAtLogin(true)` writes `openaflow.desktop` with `--hidden` in the temp autostart folder; `false` deletes it.
- **Windows settings:** the page has no Run wrapper section. Open at login turns on and back off (always off in `finally`), only with `CI=true`, because it writes the real `HKCU` Run value.
- **Main opens the settings page:** `#settings`, set on the window from main, shows the page beside the sidebar, and Back returns to the run.

CI runs `pnpm test:electron real-settings` in both `electron` jobs, unpackaged only (see [codebase-structure.md](../codebase-structure.md#ci)).

## Why it's this way

- **A wrapper check before the first start of a text:** a broken wrapper would otherwise fail inside the terminal, with no word the page can show. The check runs the wrapper around `true` with a fresh id, so it never touches the session's own scope. A passed text is kept, so only the first start waits; a failure is never kept, so a fix needs no restart.
- **The record keeps its stop:** a sweep after an app crash must end a session with the stop its start used, even when the settings changed since.
- **The default stop only with the default wrapper:** the default stop names the default scope unit. With another wrapper, that unit doesn't exist.
- **Linux writes an autostart file:** Electron's login item API does nothing on Linux. The file follows the XDG autostart rules, which GNOME and KDE read.
- **Read at each use, no cache:** a hand edit, or a second server on the same config folder, applies at the next start.

## Watch out

- `GET /api/settings` waits for the scope probe's first answer, up to about 6 s after an app start.
- Windows ignores stored wrapper and stop texts, and `POST` with a wrapper key there is `400 bad request`.
- A wrapper text that passed its check passes for the rest of the server's life. A wrapper that breaks later fails inside the terminal; restart the app to check it again.
- Records written before this sprint have no `stop`, so the sweep sends none for them.
- `real-settings` › `windows settings` writes the real `HKCU` Run value. It runs that part only with `CI=true`. Never run it with `CI=true` on your own Windows machine.
- Tests write Open at login only in `OPENAFLOW_AUTOSTART_DIR`, a temp folder. Never the real `~/.config/autostart`.
- Two AppImages at different paths, both started: each start points an on entry at itself, so the last one started wins.
- `POST /api/actions/settings` is one more token-gated way to choose a program the app runs, as `tool-path` is.

## History

- 2026-11-15 · settings S4 · added: `settings.json`, the command text rules, the wrapper check, the run wrapper and stop command at each start, `scrollback` and `stop` on records, the sweep's stored stop, and the settings routes.
- 2026-11-15 · settings H3 · added: `StartSpec.scrollback` and `bad scrollback` in the pty host.
- 2026-11-15 · settings D3 · added: Open at login (the Linux autostart file, Electron's API elsewhere), its preload calls, and the tray's Settings.
- 2026-11-17 · settings W4 · added: the settings page on `#settings`, Back, and the sidebar's Settings button.
- 2026-11-17 · settings W5 · added: Open settings on a wrapper error, in the New session form and the stop bar, and the view's scrollback from the session.
- 2026-11-18 · settings X3 · added: `real-settings.test.ts` with the `settings-claude.mjs` fixture, and its CI step; `real-folder-bridge` joins CI.
- 2026-11-19 · plan fix · changed: at start, an AppImage points its own on autostart entry at its new path after an update (`login-item.test.ts` › `linux repair at start`).
