# Sprint: Settings

_From plan: pod-docs/plans/terminal-host.md · Slug: settings · Status: active · Generated: 2026-11-15_
<!-- autopilot-run: started=2026-11-15T09:51:09Z sprints=1 waves=4 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | S4 | Server: settings file, settings routes, run wrapper and stop command at each start | settings-S4 | https://github.com/alvionlabs/openaflow/pull/150 | pushed | medium | — |
| 1 | H3 | Pty host: scrollback per session | settings-H3 | https://github.com/alvionlabs/openaflow/pull/150 | pushed | high | — |
| 1 | D3 | Desktop: Open at login (Linux autostart), preload calls, tray Settings | settings-D3 | https://github.com/alvionlabs/openaflow/pull/150 | pushed | medium | — |
| 2 | W4 | Settings page, its route, and the sidebar button | settings-W4 | — | pending | — | S4 |
| 2 | W5 | Open settings on a wrapper error; the view's scrollback | settings-W5 | — | pending | — | S4 |
| 3 | X3 | Electron checks, CI, and docs | settings-X3 | — | pending | — | S4, H3, D3, W4, W5 |

## Shared contract

**0. Scope edges.** Here: the settings page (plan Look **Settings**, draft `pod-docs/design-drafts/terminal-host-look.html` §6), Open at login, scrollback, run wrapper, stop command (research decisions 18–22; `decisions.md` 2026-11-04, 2026-11-11 ×2). This replaces session-life §6's "Linux run wrapper" and the `stop` source in its §3: the start and the sweep now take the wrapper and stop from §4 below. Unchanged: the ender's own steps (session-life §7), which always run after the stop command; the quit dialog; E1's exit 5 line (queue 2026-11-15 E1, value in use: as built). Changing settings writes no action-log entry and adds no `ActionEntry` member.

**1. Machine notes.** As session-life §1, plus a temp `OPENAFLOW_AUTOSTART_DIR`. Commits are GPG-signed: if signing times out, stop and say so. Ports by board order (i = 0 for S4 … 5 for X3): API `8400 + 10i`, web `8401 + 10i`. Build temp paths from `realpath(mkdtemp(...))` (known issue `temp-paths-resolve-differently.md`).

**2. Settings file** (`<config dir>/settings.json`; any server reads and writes it, also dev and `pnpm start`).
```ts
type SettingsFile = { v: 1; scrollback?: number; runWrapper?: string; stopCommand?: string }
```
- A key that is absent means the default. `""` means none. Defaults: scrollback 5,000. Linux: run wrapper `systemd-run --user --scope --quiet --unit=openaflow-run-{runId}.scope`, stop command `systemctl --user stop openaflow-run-{runId}.scope`. macOS: both `""`. Windows: both are ignored, even when stored.
- Read at each use (each `GET /api/settings`, each New session and Resume start), with no cache, so a hand edit applies to the next start.
- Missing file: all defaults. A file that isn't JSON, isn't an object, or has `v` ≠ 1: all defaults, one log line `openaflow: settings.json can't be read; using defaults`, and the file stays until the next change. A single bad key (scrollback out of range, a text that breaks §3): that key's default, one log line naming the key; the other keys still apply.
- Writes: the whole file to a temp file beside it, then rename, mode 0600. Writes run one at a time, each on the file as it is then, so two quick changes both land.

**3. Command text rules** (run wrapper and stop command; `packages/server/src/run-wrapper.ts`).
- At most 1,024 characters; no control character (U+0000–U+001F, U+007F). Only a space separates words. `"…"` and `'…'` group, the quotes go, with no escapes inside; quoted and plain parts that touch make one word (`a"b c"` → `ab c`). Errors: `bad text`, `too long`, `unclosed quote`, `too many words` (over 32), `unknown placeholder {name}` (any `{name}` with name `[A-Za-z]+` other than the two below), `no program` (the first word is empty). Other braces are literal. Empty or all-space text is none.
- Placeholders are filled per word after the split, so a filled value never makes a new word: `{runId}` → the run marker; `{unit}` → `openaflow-run-<run marker>.scope`. A filled word over 1,024 characters is `too long` (checked at save with a sample UUID).
- The first word must become an absolute file: absolute and present, or a bare name (no `/`) found on the session env's PATH (`resolveBin`). Else `<word> not found`. This check runs at each start, not at save, because PATH can change.

**4. Applying settings at a start** (New session and Resume; Linux and macOS; Windows: no wrapper, no stop, as today).
- Run wrapper absent (default) on Linux: today's scope probe. On: the default wrapper words with the probe's absolute `systemd-run`. Off: no wrapper, nothing refused (the probe logged once).
- Run wrapper changed (a non-empty stored text): §3's program check, then a **wrapper check**: run `<program> <filled args…> <true>` with `{runId}` filled by a fresh UUID v4 (never the session's marker), the session env, cwd `/`, no shell, at most 5 s (the probe's `run`, including its words). Exit 0 passes, and that exact text passes with no check for the rest of this server's life; a failure is never cached. `true` not on PATH: no check, one log line. The start: program = the wrapper's absolute program, args = its filled args, then the `claude` program and args.
- Run wrapper `""`: none.
- Stop command: changed (non-empty) → its §3 program check, then used with any wrapper, never run as a check; `""` → none; absent (default) → the default stop words (absolute `systemctl`) only when the default wrapper is in force with the probe on, else none.
- Refusals, before the record is saved and before the "nothing waits" part of each route: `409 {error:'run wrapper: <word>'}` and `409 {error:'stop command: <word>'}`, where `<word>` is §3's not-found word or the check's word (`exit N: <stderr first line>`, `killed by <signal>`, `no answer in 5 s`, `could not start: <code>`). Order: New session — after `409 claude not found`, before `409 session starting`. Resume — after the first `404 no session`, before the second. A refusal writes no action-log entry and one console line `openaflow: session start refused: <error>`.
- Scrollback: `StartSpec.scrollback` = the setting.
- The record keeps what its start used: `StoredSession.scrollback?: number` (integer 100–100,000) and `StoredSession.stop?: string[]` (session-life §3's shape rules). A bad stored value is dropped on read; the record stays.
- **Sweep** (session-life §3) sends each closed record's stored `stop`, and no stop for a record without one, whatever the settings are now.

**5. Routes.**
- `GET /api/settings` (behind `readGuard`, so the token is required) → `200 SettingsView`. No token → `403 bad token`.
- `POST /api/actions/settings` (action guard and body limit) with `{scrollback?: number; runWrapper?: string | null; stopCommand?: string | null}` → `200 SettingsView` after the write. `null` removes the key. A text whose trimmed value equals the platform default is stored as absent. Only the keys sent change. Errors, first match: `400 bad request` (not an object, no known key, an unknown key, a wrong type, or a wrapper key on Windows); `400 bad scrollback` (not an integer from 100 to 100,000); `400 run wrapper: <§3 text word>`; `400 stop command: <§3 text word>`; `500 not saved` (the file and the answer stay as before).
```ts
// @openaflow/model
type SettingsView = {
  scrollback: number
  wrapper?: {                                  // absent on Windows
    runWrapper: string; stopCommand: string    // stored text, or the platform default text
    isDefault: boolean                         // both keys absent
    defaults: { runWrapper: string; stopCommand: string }
    preview: string                            // the full command a new session gets now
    fallback?: string                          // default wrapper, probe off: the probe's reason
    stopSkipped?: true                         // stop key absent, but §4 runs no stop (changed or empty wrapper, or fallback)
  }
}
```
- `preview`: the wrapper words in force (as typed, `{runId}` → `<run id>`, `{unit}` → `openaflow-run-<run id>.scope`; none when empty, or when `fallback` is set), then the `claude` path (or `claude` when not found), `--session-id`, `<session id>`, `--plugin-dir`, the plugin folder (or `<plugin dir>`), `/pod:plan <your text>`. Words are joined by spaces; an empty word, or a word with a space or a quote, is in double quotes with `"` as `\"`. A server with no probe (dev, `pnpm start`) shows the default wrapper words with no `fallback`.

**6. Model and pty host.**
- `HostedSession.scrollback?: number`, from the record. `SETTINGS_SCROLLBACK = { min: 100, max: 100_000, default: 5_000 }` in `@openaflow/model`.
- `StartSpec.scrollback?: number` (the pty host's and the server's copy). The host: not an integer from 100 to 100,000 → `start-failed` `bad scrollback`, checked after `bad screen file`. Absent → the host's `OPENAFLOW_SCROLLBACK` value, as today. Main relays the spec unchanged.

**7. Open at login, preload, and tray** (`packages/desktop`).
- Preload adds `window.openaflow.openAtLogin(): Promise<boolean>` and `setOpenAtLogin(on: boolean): Promise<boolean>`. The second resolves to the state read after the write. Channels: `openaflow:login-item:get` and `openaflow:login-item:set`. The folder bridge's sender rule applies: other senders are rejected with `forbidden`. A non-boolean is rejected with `bad request`. A read or write that throws is rejected with `login item failed`.
- Windows and macOS: `createLoginItem` on Electron's API, as today (args `--hidden`, or the app folder then `--hidden` when unpackaged).
- Linux: Electron's API doesn't support it, so the app uses an XDG autostart file `<dir>/openaflow.desktop`. `<dir>` is `OPENAFLOW_AUTOSTART_DIR` (absolute only), else `$XDG_CONFIG_HOME/autostart` (absolute only), else `~/.config/autostart`. The file holds, in this order, `[Desktop Entry]`, `Type=Application`, `Name=OpenAFlow`, `Exec=<exec>`, `X-GNOME-Autostart-enabled=true`. `<exec>`: the program, then the args, each in double quotes. Inside the quotes, `"`, `` ` ``, `$`, and `\` take a `\`. Then every `\` is doubled again (the desktop-entry string rule), and `%` becomes `%%`. Program: packaged with `APPIMAGE` set → `$APPIMAGE`. Otherwise → `process.execPath`. Args are the Windows ones. The file reads as on when it holds that exact `Exec=` line, and holds no `Hidden=true` and no `X-GNOME-Autostart-enabled=false`. Any other content, such as a moved AppImage, reads as off. Turning it on makes the folder, writes a temp file, and renames it (mode 0644). Turning it off deletes only that file; a missing file is fine.
- Tray menu: `Open`, `Settings`, `Quit`. Settings shows the window on the hash `#settings` (`bus.showWindow('#settings')`).

**8. Web.**
- Route: `#settings` (no slash, so `parseHash` never reads it as a repo). On it, the main column shows the settings page and the sidebar stays. The selection effect doesn't rewrite the hash. **Back** goes to the hash the page had before, or to `''`. A reload on `#settings` stays there.
- Page (draft §6, `DESIGN.md`, existing tokens and `.input`/`.switch` only): a **Back** button and the title. **General**, desktop only: the Open at login switch with "Start OpenAFlow in the tray when you sign in." **Terminals**: Scrollback, as a number with "lines per terminal". **Run wrapper**, only when `wrapper` is present: Wrapper command, Stop command, "Full command for a new session" (the `preview` text), the `fallback` reason as one muted line, with `stopSkipped` the muted line "The default stop command runs only with the default run wrapper.", and **Reset to default** (off when `isDefault`). Each change saves at once. The switch saves on change. A field saves on blur or Enter when its text changed, and Escape puts the saved text back. A refused save shows the server's word under that field (`aria-invalid`) and keeps the typed text. A failed load shows "Couldn't load settings. Please try again" with **Try again**.
- Sidebar foot: **Settings** beside Add repo, in both builds.
- Error with **Open settings** (to `#settings`): an error that starts with `run wrapper: ` or `stop command: `. New session: "The session didn't start", "Your run wrapper failed:" or "Your stop command failed:", the rest as code. Resume (the stop bar's alert box): "The session didn't resume", then the same lines.
- Terminal view: xterm `scrollback` = `session.scrollback ?? 5_000` (xterm's own default is 1,000).

**9. Electron checks and CI.** New `real-settings.test.ts`, gated as host-core §7, with the `fake-session-claude.mjs` fixture and a plain `sh` script as the changed wrapper, so CI needs no user bus. `pod-ci.yml` gains a `real-settings` step (unpackaged) in both `electron` jobs.

## Per-slice detail

### S4: Server: settings file, settings routes, run wrapper and stop command at each start
- **Scope:** §2–§5, and §6's `HostedSession.scrollback`, `SETTINGS_SCROLLBACK`, and `SettingsView` in `@openaflow/model`, plus the server's `StartSpec` copy. Build the settings store, both routes (mount the read in `app.ts` as `settings?: Hono`, behind `readGuard`), the §3 text rules, the wrapper check, and the start changes in `session-routes.ts`. Store `scrollback` and `stop` on records, and make the sweep read `stop` from the record. Keep the scope probe. Don't touch the web or the desktop.
- **Files owned:** `packages/model/src/settings.ts` (new), `packages/model/src/index.ts`, `packages/model/src/board.ts`, `packages/server/src/settings-store.ts` (new), `packages/server/src/settings-store.test.ts` (new), `packages/server/src/settings-routes.ts` (new), `packages/server/src/settings-routes.test.ts` (new), `packages/server/src/run-wrapper.ts`, `packages/server/src/run-wrapper.test.ts`, `packages/server/src/session-routes.ts`, `packages/server/src/session-routes.test.ts`, `packages/server/src/session-store.ts`, `packages/server/src/session-store.test.ts`, `packages/server/src/terminal-channel.ts`, `packages/server/src/terminal-channel.test.ts`, `packages/server/src/start-server.ts`, `packages/server/src/start-server.test.ts`, `packages/server/src/app.ts`
- **Success criteria:**
  - `[test]` missing file, bad JSON, `v: 2`, and one bad key each read as §2 says, with one log line each, and a bad file is not rewritten by a read — `settings-store.test.ts › reads defaults and keeps good keys`
  - `[test]` two writes started together both land; a failed rename leaves the old file — `settings-store.test.ts › writes one at a time, whole`
  - `[test]` quotes, touching parts, an unclosed quote, 33 words, 1,025 characters, a control character, `{nope}`, a `""` program, and a literal `{}` give §3's words — `run-wrapper.test.ts › splits command text`
  - `[test]` a `{runId}` value with a space stays one word; `{unit}` fills `openaflow-run-<marker>.scope` — `run-wrapper.test.ts › fills placeholders per word`
  - `[test]` a bare name is found on PATH; an absolute missing file and a relative `a/b` give `<word> not found` — `run-wrapper.test.ts › resolves the program`
  - `[test]` the wrapper check: exit 0 passes once per text (a second start runs no check); exit 3 with stderr gives `exit 3: <line>` and is checked again next time; a hang gives `no answer in 5 s` (short limit in the test); its `{runId}` is never the session marker — `run-wrapper.test.ts › checks a changed wrapper`
  - `[test]` with no `true` on PATH, a changed wrapper starts with no check and one log line — `run-wrapper.test.ts › no true, no check`
  - `[test]` absent, changed, and `""` wrapper with the probe on and off, each with absent, changed, and `""` stop, give §4's program, args, and stop; Windows ignores stored texts — `run-wrapper.test.ts › resolves wrapper and stop per setting`
  - `[test]` New session and Resume refuse with `409 run wrapper: …` and `409 stop command: …` in §4's order, save no record, and log no entry — `session-routes.test.ts › refuses a broken wrapper or stop`
  - `[test]` a start sends `scrollback` from settings, and the record keeps `scrollback` and `stop`; a settings change between two starts applies to the second only — `session-routes.test.ts › a start uses the settings in force`
  - `[test]` a record's bad `scrollback` or `stop` is dropped on read, and the record stays; `HostedSession.scrollback` comes from the record — `session-store.test.ts › keeps scrollback and stop`
  - `[test]` the sweep sends each record's stored `stop`, and none for a record without one, after the settings changed — `start-server.test.ts › sweep uses the stop each session started with`
  - `[test]` GET needs the token; POST answers the §5 errors in order, maps `null` and the default text to absent, changes only the keys sent, and answers `500 not saved` on a failed write — `settings-routes.test.ts › settings routes`
  - `[test]` the preview for default-on, a fallback with its reason, a changed wrapper, empty, no `claude`, and no probe; quoting of a word with a space; `stopSkipped` set only for an absent stop with a changed or empty wrapper or a fallback — `settings-routes.test.ts › preview`
  - `[test]` on Windows, GET has no `wrapper`, and POST with `runWrapper` is `400 bad request` — `settings-routes.test.ts › windows has no wrapper`
- **Depends on:** —
- **One-way door:** none (the new `settings.json` and the new record fields are additive; older builds drop unknown keys)
- **Model:** opus

### H3: Pty host: scrollback per session
- **Scope:** §6's `StartSpec.scrollback` in `protocol.ts`, `specError`'s `bad scrollback`, and `service.ts` using the spec's value, else the host's. Nothing else changes.
- **Files owned:** `packages/pty-host/src/protocol.ts`, `packages/pty-host/src/protocol.test.ts` (new), `packages/pty-host/src/service.ts`, `packages/pty-host/src/service.test.ts`
- **Success criteria:**
  - `[test]` 99, 100,001, 1.5, and `"5000"` give `bad scrollback`; 100, 100,000, and absent pass; a bad screen file still comes first — `protocol.test.ts › scrollback rule`
  - `[test]` a session started with `scrollback: 200` keeps at most 200 lines above its screen in `snapshot`, and one with none keeps the host's value — `service.test.ts › scrollback per session`
- **Depends on:** —
- **One-way door:** none
- **Model:** sonnet

### D3: Desktop: Open at login (Linux autostart), preload calls, tray Settings
- **Scope:** all of §7. Put the IPC glue in a new `login-item-main.ts`. The rules stay in `login-item.ts`, with a fake fs and a fake API, and the Linux file work goes in a new `login-autostart.ts`. The sandboxed preload may import only modules with no `node:` import (`bundle-desktop.test.ts` reads its imports). The channels' sender gate is a pure function on `senderAllowed` (`folder-bridge.ts`). Add `OPENAFLOW_AUTOSTART_DIR` to the Electron harness's temp env, so no test writes the real autostart folder. Resolves queue 2026-11-04 "Start at login leaves the tray in PR #88". Don't touch `quit-flow.ts`.
- **Files owned:** `packages/desktop/src/login-item.ts`, `packages/desktop/src/login-item.test.ts`, `packages/desktop/src/login-autostart.ts` (new), `packages/desktop/src/login-item-main.ts` (new), `packages/desktop/src/preload-main.ts`, `packages/desktop/src/real-folder-bridge.test.ts`, `packages/desktop/src/tray-menu.ts`, `packages/desktop/src/tray-menu.test.ts`, `packages/desktop/src/window-main.ts`, `packages/desktop/test/electron-harness.ts`
- **Success criteria:**
  - `[test]` the `Exec=` line for a path with a space, `$`, `%`, `"`, `` ` ``, and `\`, for an AppImage, linux-unpacked, and unpackaged — `login-item.test.ts › linux exec line`
  - `[test]` on writes the five lines and makes the folder; off deletes only `openaflow.desktop`; off with no file is fine — `login-item.test.ts › linux autostart on and off`
  - `[test]` another `Exec`, `Hidden=true`, or `X-GNOME-Autostart-enabled=false` reads as off; on after that rewrites the file — `login-item.test.ts › linux reads only its own entry`
  - `[test]` the folder: `OPENAFLOW_AUTOSTART_DIR`, then `XDG_CONFIG_HOME`, then home; a relative value is skipped — `login-item.test.ts › autostart folder`
  - `[test]` a write that throws answers the state read after it; a read that throws rejects `login item failed` — `login-item.test.ts › answers what a read returns`
  - `[test]` Windows keeps today's args — `login-item.test.ts › windows args unchanged`
  - `[test]` a get or set from another window, a subframe, or another origin answers `forbidden` and touches nothing — `login-item.test.ts › sender rule`
  - `[test]` the page's `window.openaflow` keys are exactly the seven, and `setOpenAtLogin('yes')` rejects `bad request` — `real-folder-bridge.test.ts › the page sees only the bridge keys`
  - `[test]` the menu is Open, Settings, Quit, and Settings calls its handler — `tray-menu.test.ts › tray menu`
- **Depends on:** —
- **One-way door:** none (turning it on writes one file the switch deletes again)
- **Model:** opus

### W4: Settings page, its route, and the sidebar button
- **Scope:** §8's route, page, and sidebar button. Add a `loginBridge(win)` to `desktop-bridge.ts`: `{ get(), set(on) }`, or undefined when the shell lacks the calls. Add a settings client (GET, POST with the token, as `setup-client.ts` does) and a pure `settings-view.ts`. Put styles in a new `settings.css`, with tokens only. Not here: the error's Open settings button (W5).
- **Files owned:** `packages/web/src/screens/settings/SettingsScreen.tsx` (new), `packages/web/src/screens/settings/settings-view.ts` (new), `packages/web/src/screens/settings/settings-view.test.ts` (new), `packages/web/src/screens/settings/settings-client.ts` (new), `packages/web/src/screens/settings/settings-client.test.ts` (new), `packages/web/src/screens/settings/settings.css` (new), `packages/web/src/desktop-bridge.ts`, `packages/web/src/desktop-bridge.test.ts`, `packages/web/src/selection.ts`, `packages/web/src/selection.test.ts`, `packages/web/src/App.tsx`, `packages/web/src/screens/runs/RunsScreen.tsx`, `packages/web/src/screens/runs/runs-screen.test.ts`, `packages/web/src/screens/runs/tab-panels.test.ts`, `packages/web/src/screens/runs/runs.css`, `packages/web/src/screens/runs/runs-css.test.ts`
- **Success criteria:**
  - `[test]` `#settings` is the settings view, the selection never rewrites it, and Back goes to the previous hash, else `''` — `selection.test.ts › settings route`
  - `[test]` the browser build has no General section; Windows (no `wrapper`) has no Run wrapper section; Reset is off when `isDefault`; the `fallback` and `stopSkipped` lines show only when set — `settings-view.test.ts › sections per build and platform`
  - `[test]` a field posts only on a changed blur or Enter, Escape restores the text, and a 400 word shows under its field with the text kept — `settings-view.test.ts › saves at once`
  - `[test]` a switch answer that differs from the ask, or a rejection, shows "Couldn't change Open at login" and the state read — `settings-view.test.ts › login switch`
  - `[test]` GET and POST send the token; Reset posts `{runWrapper:null, stopCommand:null}`; a failed load reads "Couldn't load settings. Please try again" — `settings-client.test.ts › settings client`
  - `[test]` `loginBridge` is undefined without both calls — `desktop-bridge.test.ts › login bridge`
  - `[test]` the sidebar foot holds Settings after Add repo, in both builds — `runs-screen.test.ts › sidebar settings button`
  - `[manual]` the page matches draft §6 in light and dark at desktop width and at 375 px (`setViewportSize`), with focus rings and no overflow, in the browser build and in `pnpm desktop`
- **Depends on:** S4
- **One-way door:** none
- **Model:** opus

### W5: Open settings on a wrapper error; the view's scrollback
- **Scope:** the §8 error words with **Open settings**, in the New session form and the Resume alert box, and the §8 terminal view scrollback. Use the literal `#settings`.
- **Files owned:** `packages/web/src/screens/runs/new-session-flow.ts`, `packages/web/src/screens/runs/new-session-flow.test.ts`, `packages/web/src/screens/runs/NewSessionForm.tsx`, `packages/web/src/screens/runs/resume-session-flow.ts`, `packages/web/src/screens/runs/resume-session-flow.test.ts`, `packages/web/src/screens/runs/TerminalTab.tsx`, `packages/web/src/screens/runs/TerminalView.tsx`, `packages/web/src/screens/runs/terminal-tab.ts`, `packages/web/src/screens/runs/terminal-tab.test.ts`, `packages/web/src/screens/runs/new-session.css`, `packages/web/src/screens/runs/terminal.css`
- **Success criteria:**
  - `[test]` a `run wrapper: exit 3: bad option` reply gives the title, the "Your run wrapper failed:" line, the code `exit 3: bad option`, and an Open settings action, and `stop command: …` gives its own line; other errors have no action — `new-session-flow.test.ts › wrapper errors offer settings`
  - `[test]` the same for Resume, with "The session didn't resume" — `resume-session-flow.test.ts › wrapper errors offer settings`
  - `[test]` the terminal options take `session.scrollback`, else 5,000 — `terminal-tab.test.ts › view scrollback`
  - `[manual]` the error block (title, line, code, Open settings) in the form and in the stop bar matches draft §4 in light and dark, at desktop width and at 375 px, with a long reason wrapping
- **Depends on:** S4
- **One-way door:** none
- **Model:** sonnet

### X3: Electron checks, CI, and docs
- **Scope:** §9, and the docs for this sprint plus session-life's leftovers: Resume, `resume-session` entries, and the screen route in `actions.md` and `server.md`; `desktop.md:121` (`endSessions()` is wired); the Windows job helper's `ok` line, which now carries a count and pulls in earlier children. Add the settings routes and Open at login to the smoke recipe. Write a new `settings.md`. Set the idea's status line. Don't edit archived sprint docs.
- **Files owned:** `packages/desktop/src/real-settings.test.ts` (new), `packages/desktop/test/fixtures/settings-claude.mjs` (new: prints `--lines N` numbered lines, then echoes like `fake-session-claude.mjs`), `.github/workflows/pod-ci.yml`, `packages/desktop/src/ci-workflow.test.ts`, `pod-docs/feature-details/settings.md` (new), `pod-docs/feature-details/hosted-sessions.md`, `pod-docs/feature-details/desktop.md`, `pod-docs/feature-details/terminal-host.md`, `pod-docs/feature-details/server.md`, `pod-docs/feature-details/actions.md`, `pod-docs/codebase-structure.md`, `pod-docs/ideas/settings-page.md`
- **Success criteria:**
  - `[test]` scrollback 200 set through the page's POST, then a New session that prints 1,000 lines keeps at most 200 plus its rows in the snapshot; a session started before the change keeps 5,000 — `real-settings.test.ts › scrollback applies to new sessions`
  - `[test]` a changed wrapper script that writes `{runId}` to a file and runs the rest gets the session's marker, and the fake `claude` gets its args; a changed stop script runs with the marker on a confirmed quit — `real-settings.test.ts › changed wrapper and stop` (Linux only)
  - `[test]` a wrapper that exits 3 with `bad option` gives `409 run wrapper: exit 3: bad option`, no record, and the form's Open settings shows the page — `real-settings.test.ts › broken wrapper stops the start` (Linux only)
  - `[test]` on Linux, `setOpenAtLogin(true)` writes `openaflow.desktop` in the temp folder with `--hidden`, and `false` deletes it — `real-settings.test.ts › open at login on linux`
  - `[test]` on Windows, the page has no Run wrapper section; Open at login turns on and back off (always off in `finally`), only when `CI=true`, because it writes the real `HKCU` Run value — `real-settings.test.ts › windows settings`
  - `[test]` `#settings` set on the window from main shows the settings page beside the sidebar, and Back returns to the run — `real-settings.test.ts › main opens the settings page`
  - `[test]` both `electron` jobs run `pnpm test:electron real-settings` — `ci-workflow.test.ts › electron jobs`
- **Depends on:** S4, H3, D3, W4, W5
- **One-way door:** none
- **Model:** opus
