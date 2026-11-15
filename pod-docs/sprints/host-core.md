# Sprint: Host core

_From plan: pod-docs/plans/terminal-host.md · Slug: host-core · Status: active · Generated: 2026-11-14_
<!-- autopilot-run: started=2026-11-14T23:07:20Z sprints=0 waves=1 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | N1 | node-pty proof: minimal pty host outside the asar, packaged, in CI on Windows and Linux | host-core-N1 | https://github.com/alvionlabs/openaflow/pull/117 | pushed | medium | — |
| 1 | C1 | Linux start test, the Linux test failures, config copy keeps modified times | host-core-C1 | https://github.com/alvionlabs/openaflow/pull/117 | pushed | medium | — |
| 1 | K1 | Hooks plugin and the hook-state reader | host-core-K1 | https://github.com/alvionlabs/openaflow/pull/117 | pushed | medium | — |
| 2 | H1 | Full pty host: attach, replay, input, resize, flow control, heartbeat | host-core-H1 | — | pending | — | N1 |
| 2 | S1 | Host starter and window link in the main process | host-core-S1 | — | pending | — | N1 |
| 2 | P1 | Linux AppImage, release workflow, Linux verify job | host-core-P1 | — | pending | — | N1, C1, K1 |
| 2 | A1 | Start command and skill list, proved with real `claude` | host-core-A1 | — | pending | — | N1, K1 |
| 3 | E1 | Electron terminal checks, unpackaged and packaged, in CI; docs | host-core-E1 | — | pending | — | H1, S1, P1 |

## Shared contract

**1. Machine notes (every slice).**
- Engineers run on Fedora. No Windows machine is reachable: Windows proof is a green `windows-latest` job on the slice PR, or a command the slice names for the human.
- `pnpm` is not on PATH: `npm i --prefix <scratchpad>/pnpm pnpm@11.1.2`, then put `<scratchpad>/pnpm/node_modules/.bin` on PATH. Electron 45.2.1 has no install script: get its binary with `node node_modules/electron/install.js` in `packages/desktop` (also in CI).
- No `xvfb` here: run Electron checks with `DISPLAY=:0`. Always use temp `OPENAFLOW_CONFIG_DIR`, `OPENAFLOW_PORTS_DIR`, `OPENAFLOW_CLAUDE_DIR`, and `OPENAFLOW_DESKTOP_DATA_DIR`.
- Dev ports by board order (i = 0 for N1 … 7 for E1): API `8400 + 10i`, web `8401 + 10i`.
- Spike code is reference only: origin `spike/terminal-host` and `spike/terminal-host-windows`; findings in `pod-docs/research/terminal-host-spike.md`.

**2. Layout.**

| What | Dev | Packaged |
|---|---|---|
| Pty host bundle | `packages/pty-host/dist/pty-host.cjs` | `<resources>/pty-host/pty-host.cjs` |
| node-pty | `packages/pty-host/node_modules/node-pty` | `<resources>/pty-host/node_modules/node-pty` (package.json, `lib/`, LICENSE, the build platform's prebuilds only) |
| Hooks plugin | `packages/hooks-plugin/plugin/` | `<resources>/hooks-plugin/` |
| Hook state | `<config dir>/hooks/<run marker>.jsonl` | same |

- `node-pty` is pinned to exactly `1.2.0-beta.18`. Fallback only if it fails in Electron: `@lydell/node-pty` (already in `decisions.md`; file a `PENDING` queue entry with the failing log, then switch). `@xterm/headless` and `@xterm/addon-serialize` are bundled; `node-pty` stays external. The build writes `dist/pty-host.cjs.meta.json` for the notices.
- Nothing under `packages/pty-host` or `packages/hooks-plugin` imports `electron`. `packages/hooks-plugin` has no `package.json`. `<config dir>` is the server's `liveConfigDir`.

**3. IDs and session env.** A run marker and a session ID are lowercase UUID v4, never equal. The host's session `id` is the run marker; the host accepts `/^[a-z0-9-]{1,64}$/`. A hosted session's env drops every inherited `OPENAFLOW_*` and sets only `OPENAFLOW_RUN=<run marker>` and `OPENAFLOW_HOOKS_DIR=<absolute config dir>/hooks`.

**4. Pty host protocol.**

```ts
type StartSpec = { id: string; program: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
// main → host (process.parentPort)
'start' {spec} | 'kill' {id} | 'dispose' {id} | 'list' | 'snapshot' {id} | 'connect' (ports[0] = a window's MessagePort) | 'shutdown'
// host → main
'ready' {version: 1} | 'load-failed' {error} | 'beat' | 'started' {id, pid} | 'start-failed' {id, error}
| 'exit' {id, exitCode, signal?} | 'list' {sessions: {id, pid, live, startedAt}[]} | 'snapshot' {id, text: string | null}
// window → host (MessagePort)
'attach' {id} | 'detach' {id} | 'input' {id, data} | 'resize' {id, cols, rows} | 'ack' {id, chars}
// host → window
'replay' {id, data} | 'data' {id, data} | 'exit' {id, exitCode} | 'error' {id?, error}
```
Each message is `{ type, ...fields }`. Rules:
- `start` refuses with `start-failed` and spawns nothing: `bad id`, `id in use`, `program not absolute`, `no folder` (cwd), `bad size` (cols outside 2–500, rows outside 1–200), `spawn failed: <message>`.
- `started` goes out only once the pty has a pid. On Linux that is the same tick; on Windows ConPTY gives the pid only after its output worker connects (about 1 s in CI), so the host checks every 10 ms and on each data and exit event. `started` always comes before `exit`, each once. A start that fails after the spawn answers `start-failed` with `spawn failed: <reason>`, frees the id, kills the pty, and sends no `exit`: `the program ended before it started (exit code N)`, `no process ID after 10 s`, `disposed before it started`, `the host is shutting down`. A session waiting for its pid sits in the map with pid 0 (`list` and `kill` must handle it). (Wave 1 fix, `c176a5d`.)
- `ready` once, after `require('node-pty')` works; else `load-failed` and exit 1. Then a `beat` every 5 s.
- `snapshot`: screen plus scrollback as right-trimmed plain lines; unknown id → `null`.
- `exit` is reported once, to main and every attached port. The session stays listed (`live: false`), attachable, and snapshottable until `dispose`.
- `attach` sends `replay` (serialized buffer), then live `data`, so each chunk reaches the port exactly once and in order. Unknown id → `error` `no session`. Exited session → `replay`, then `exit`.
- A window port may only attach, detach, input, resize, and ack; else `error` `not allowed`. A bad message → `error` `bad message`; the host never throws.
- `shutdown` kills every pty, waits at most 3 s for their exits, and exits 0.

**5. Window link.** The preload adds `window.openaflow.connectTerminals(): Promise<void>` and `window.openaflow.onTerminalHost(fn)` with states `ready`, `unresponsive`, `restarted`, `failed`. Main gives a port only to the folder bridge's sender (app window, main frame, server's current origin), else rejects `forbidden`. The port reaches the page as a `window` message `{ type: 'openaflow:terminal-port' }` with the port in `ports[0]`, before the promise resolves. Before ready, the request waits up to 20 s, then rejects `terminals unavailable`; after the host failed for good, it rejects at once. After `restarted`, old ports are dead and the page connects again.

**6. Test hooks.** A build-time define `__OPENAFLOW_TEST_HOOKS__`, true only in the Electron harness's bundles and in `pnpm package --test-hooks`; esbuild removes the code from every other build. When true, main sets `globalThis.__openaflowTest.terminals = { start(spec) → {pid}, snapshot(id), list(), kill(id), hostPid() }` (N1: start, snapshot, hostPid; S1: list, kill). The release check fails a `main.cjs` that holds `__openaflowTest`. Never upload a `--test-hooks` build.

**7. Electron tests.**
- New `real-*.test.ts` files gate on `OPENAFLOW_REAL_ELECTRON === '1'` and Linux or Windows. Existing ones keep their Windows gate unless a slice says otherwise.
- `pnpm test:electron [name…]` runs only the `real-*` files whose names hold a name; none runs all; a name that matches no file fails.
- `packages/desktop/test/electron-harness.ts` (N1) launches with Playwright `_electron` (`playwright-core`, pinned exact). It bundles `test/harness-main.ts` (calls `startShell` with `appPath`, as `test/probe-main.ts` does) and the preload with test hooks into a temp folder, sets the temp env, and returns `{ app, page, port, close }`. With `OPENAFLOW_PACKAGED_APP=<absolute path>` it launches that `--test-hooks` executable instead; packaged cases gate on that variable.
- Real `claude` tests run only with `OPENAFLOW_REAL_CLAUDE=1`, never in `pnpm verify` or CI, on Haiku, at most 4 turns a run.

**8. Hook state file.** One line per event: `{"v":1,"at":<ms>,"payload":<stdin JSON>}`. A payload over 64 KB is written as `{"v":1,"at":<ms>,"cut":true,"event":"<hook_event_name>","session":"<session_id>"}`. Empty stdin → `"payload":null`. Readers skip lines that don't parse. Registered events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`, `PreToolUse`, `PermissionRequest`. The reader returns no prompt text, only `promptHash` (SHA-256 hex).

## Per-slice detail

### N1: node-pty proof, packaged, in CI
- **Scope:** Prove node-pty in Electron 45, unpackaged and packaged, on Windows and Linux, before anything builds on it. Create `@openaflow/pty-host` (§2) with its pinned deps, an `allowBuilds` entry, a `build` script, and only these protocol parts: `ready`, `load-failed`, `start` and its answers, `exit`, `snapshot`, `shutdown` (5,000 lines scrollback for now). In main: a plain launch module (entry and plugin paths, dev and packaged; host env keeps `SystemRoot` and never holds `ELECTRON_RUN_AS_NODE`), glue that forks the host in a second `utilityProcess` after the server starts and logs `openaflow desktop: terminal host ready` or `… could not load node-pty: <error>`; the board keeps running when the host fails. Add §6 (start, snapshot, hostPid), the `--test-hooks` flag and its release-rule check, §7's harness and filter, node-pty outside the asar (Linux target `dir` for now), and node-pty and xterm in the notices. In `pod-ci.yml` add `pty proof` jobs on `windows-latest` and `ubuntu-latest` (`xvfb-run -a`, `sysctl kernel.apparmor_restrict_unprivileged_userns=0`): build, `real-pty-proof`, `pnpm package --test-hooks`, then `real-pty-proof` packaged (`release/win-unpacked/OpenAFlow.exe`, `release/linux-unpacked/openaflow`). Keep `verify` and today's triggers. Move the `pod-ci.yml` tests into `ci-workflow.test.ts`. A green `pty proof (windows-latest)` on this PR is the Windows proof.
- **Files owned:** `packages/pty-host/package.json` (new), `packages/pty-host/tsconfig.json` (new), `packages/pty-host/scripts/build.ts` (new), `packages/pty-host/src/protocol.ts` (new), `packages/pty-host/src/service.ts` (new), `packages/pty-host/src/service.test.ts` (new), `packages/pty-host/src/host-entry.ts` (new), `packages/pty-host/src/bundle.test.ts` (new), `packages/pty-host/test/real-pty.test.ts` (new), `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packages/desktop/package.json`, `packages/desktop/src/pty-host-launch.ts` (new), `packages/desktop/src/pty-host-launch.test.ts` (new), `packages/desktop/src/pty-host-main.ts` (new), `packages/desktop/src/test-hooks-main.ts` (new), `packages/desktop/src/shell-main.ts`, `packages/desktop/src/shell-config.ts`, `packages/desktop/src/bundle-desktop.ts`, `packages/desktop/src/bundle-desktop.test.ts`, `packages/desktop/src/build-config.ts`, `packages/desktop/src/build-config.test.ts`, `packages/desktop/src/licence-notices.ts`, `packages/desktop/src/licence-notices.test.ts`, `packages/desktop/src/release-rules.ts`, `packages/desktop/src/release-rules.test.ts`, `packages/desktop/src/real-pty-proof.test.ts` (new), `packages/desktop/src/release-workflow.test.ts`, `packages/desktop/src/ci-workflow.test.ts` (new), `packages/desktop/scripts/package.ts`, `packages/desktop/scripts/release-check.ts`, `packages/desktop/scripts/real-tests.mjs`, `packages/desktop/test/electron-harness.ts` (new), `packages/desktop/test/harness-main.ts` (new), `.github/workflows/pod-ci.yml`, `pod-docs/codebase-structure.md`, `pod-docs/feature-details/desktop.md`, `pod-docs/feature-details/installer-and-updates.md`
- **Success criteria:**
  - `[test] a real pty under Node runs a program; its output and exit code come back — packages/pty-host/test/real-pty.test.ts › a real pty runs a program and reports its output and exit`
  - `[test] start refuses each bad spec of §4 and spawns nothing — packages/pty-host/src/service.test.ts › start refuses bad specs and spawns nothing`
  - `[test] a node-pty that fails to load gives load-failed and exit 1 — packages/pty-host/src/service.test.ts › a node-pty that fails to load answers load-failed`
  - `[test] snapshot gives plain lines; unknown id gives null; an exited session answers until dispose — packages/pty-host/src/service.test.ts › snapshot`
  - `[test] shutdown kills every pty, and the host exits within 3 s — packages/pty-host/src/service.test.ts › shutdown ends every session, then the host`
  - `[test] the bundle keeps node-pty external, holds xterm, writes its meta file, and imports no electron — packages/pty-host/src/bundle.test.ts › the bundle keeps node-pty outside and imports no electron`
  - `[test] host entry and plugin dir resolve dev and packaged; the host env keeps SystemRoot and has no ELECTRON_RUN_AS_NODE — packages/desktop/src/pty-host-launch.test.ts › paths and env, dev and packaged`
  - `[test] node-pty and the pty host sit outside the asar with only the build platform's prebuilds — packages/desktop/src/build-config.test.ts › node-pty and the pty host sit outside the asar`
  - `[test] a normal bundle holds no __openaflowTest; a test-hooks bundle does — packages/desktop/src/bundle-desktop.test.ts › test hooks exist only in a test-hooks bundle`
  - `[test] the release rules refuse a main.cjs that holds __openaflowTest — packages/desktop/src/release-rules.test.ts › no test hooks in a release`
  - `[test] the notices name node-pty, @xterm/headless, and @xterm/addon-serialize — packages/desktop/src/licence-notices.test.ts › the notices name node-pty and xterm`
  - `[test] in Electron a terminal starts through the test hook and its snapshot shows the output, unpackaged and packaged — packages/desktop/src/real-pty-proof.test.ts › node-pty runs in the Electron app`
  - `[test] pty proof jobs run on both systems, unpackaged then packaged; verify stays free of packaging — packages/desktop/src/ci-workflow.test.ts › pty proof jobs`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### C1: Linux start and Linux test fixes
- **Scope:** The plan says `startNotifier` throws on Linux, but `notifier-main.ts` already guards it; what is missing is a test that starts the shell on Linux. Add `real-start.test.ts` (§7 gate), with plain `spawn` and temp folders. Guard other Windows-only calls on the start path by platform, in files you own; for `shell-main.ts` (N1's), file a queue entry. Gate `real-folder-bridge.test.ts` on Linux too. Fix the Linux failures of `pnpm verify` in the four files below (counted 2026-11-11; check again). A test that can't pass on Linux for a real reason gets `skipIf` on Linux, a reason, and a known-issue file. Queue item 2026-11-05: after each copy in `config-move.ts`, set the copy's times from the source on Linux and macOS; a failed `utimes` logs one line and the copy goes on. Windows proof of `real-start`: E1's `electron (windows-latest)` job.
- **Files owned:** `packages/desktop/src/real-start.test.ts` (new), `packages/desktop/src/real-folder-bridge.test.ts`, `packages/desktop/test/bridge-probe-main.ts`, `packages/desktop/src/notifier-main.ts`, `packages/desktop/src/window-main.ts`, `packages/server/src/board-service.test.ts`, `packages/server/src/bundle-app.test.ts`, `packages/server/src/gh-exec.test.ts`, `packages/server/src/main.test.ts`, `packages/server/src/config-move.ts`, `packages/server/src/config-move.test.ts`, `pod-docs/feature-details/server.md`, `pod-docs/known-issues/` (new files only)
- **Success criteria:**
  - `[test] the built app answers /api/health within 60 s, desktop.log holds no Uncaught or TypeError, and the server ends within 5 s of the main process — packages/desktop/src/real-start.test.ts › the shell starts and its server follows it`
  - `[test] the folder bridge test runs and passes on Linux — packages/desktop/src/real-folder-bridge.test.ts › the folder bridge in real Electron`
  - `[test] passes on Linux, or skips only named tests with a known-issue file — packages/server/src/board-service.test.ts › (whole file)`
  - `[test] same rule — packages/server/src/bundle-app.test.ts › (whole file)`
  - `[test] same rule — packages/server/src/gh-exec.test.ts › (whole file)`
  - `[test] same rule — packages/server/src/main.test.ts › (whole file)`
  - `[test] a copied file keeps its source's modified time — packages/server/src/config-move.test.ts › a copy keeps each file's modified time`
  - `[test] a failed utimes still counts as copied, with one log line — packages/server/src/config-move.test.ts › a failed utimes keeps the copy`
- **Depends on:** —
- **One-way door:** this changes the one-time copy of the old config folder: on Linux and macOS the copied files now keep their old modified times. The copy runs once per machine, only when the new folder does not exist. Undo: revert the slice's merge commit; a copy that already ran stays as it is.
- **Model:** opus

### K1: Hooks plugin and hook-state reader
- **Scope:** `packages/hooks-plugin/plugin/`: `.claude-plugin/plugin.json` (name `openaflow-hooks`, no skills), `hooks/hooks.json` (§8's events, each `sh "${CLAUDE_PLUGIN_ROOT}/scripts/record.sh"`, timeout 10 s), and `scripts/record.sh` in POSIX `sh` (no Node, no `jq`). It appends §8's line to `$OPENAFLOW_HOOKS_DIR/$OPENAFLOW_RUN.jsonl`, making the folder; strips CR and LF; never writes to stdout (a `SessionStart` stdout becomes model context); always exits 0; writes nothing when the marker is not a §3 marker or the folder variable is unset or relative. Time: `date +%s%3N`, else seconds × 1000. The test finds `sh` by running it, and skips with a printed reason when none starts (on `windows-latest`, Git's `sh` is on PATH, so it runs). `packages/server/src/hook-state.ts`: `readHookState(text)` → `{ live?: { session, cause, at }, events: { at, event, session, source?, kind?, tool?, promptHash?, cut? }[] }`. `live` is the newest `SessionStart`, its `cause` the `source`. Events with the same name, session, `source`, `notification_type`, and `tool_name` within 2 s count once. No caller yet (terminal-tab).
- **Files owned:** `packages/hooks-plugin/plugin/.claude-plugin/plugin.json` (new), `packages/hooks-plugin/plugin/hooks/hooks.json` (new), `packages/hooks-plugin/plugin/scripts/record.sh` (new), `packages/hooks-plugin/test/record.test.ts` (new), `packages/server/src/hook-state.ts` (new), `packages/server/src/hook-state.test.ts` (new)
- **Success criteria:**
  - `[test] an event becomes one §8 line in the run's file — packages/hooks-plugin/test/record.test.ts › a hook event becomes one line in the run's file`
  - `[test] a bad or missing marker, or a missing or relative folder, writes nothing, prints nothing, exits 0 — packages/hooks-plugin/test/record.test.ts › no marker, no write`
  - `[test] a folder it can't write still exits 0 with no stdout — packages/hooks-plugin/test/record.test.ts › an unwritable folder never fails the hook`
  - `[test] multi-line stdin gives one parsable line; empty stdin gives payload null — packages/hooks-plugin/test/record.test.ts › stdin edges`
  - `[test] a 65 KB payload gives a cut line with its event and session; 63 KB stays whole — packages/hooks-plugin/test/record.test.ts › big payloads`
  - `[test] the plugin is openaflow-hooks with no skills and the eight events — packages/hooks-plugin/test/record.test.ts › the plugin registers the eight events`
  - `[test] start A, /clear to B, /resume A gives live A with cause resume (spike check 9) — packages/server/src/hook-state.test.ts › the live session follows SessionStart`
  - `[test] duplicates within 2 s count once; 3 s apart twice; different events never merge — packages/server/src/hook-state.test.ts › duplicate events`
  - `[test] bad lines and a cut-off last line are skipped; empty text has no live session; cut lines keep event and session — packages/server/src/hook-state.test.ts › bad and cut lines`
  - `[test] the state holds promptHash and never the prompt text — packages/server/src/hook-state.test.ts › no prompt text`
- **Depends on:** —
- **One-way door:** none
- **Model:** sonnet

### H1: Full pty host
- **Scope:** The rest of §4 on N1's service: `kill` (the pty's own kill; tree kills are session-life), `dispose`, `list`, `connect`, attach and replay (serialize in the headless terminal's `write('', callback)` and add the port in that callback), detach, input (ignored after exit), resize (`error` `bad resize` outside the bounds; the buffer resizes too), heartbeat, and the window-port refusals. Scrollback from `OPENAFLOW_SCROLLBACK`: an integer 100–100,000, else 5,000 with one log line. Flow control: count characters sent to each port since its last ack; pause the pty while any port is over 100,000, resume when all are under 5,000; a closed or detached port stops counting. Unit tests use a fake pty and the real `@xterm/headless`.
- **Files owned:** `packages/pty-host/src/protocol.ts`, `packages/pty-host/src/service.ts`, `packages/pty-host/src/service.test.ts`, `packages/pty-host/src/session.ts` (new), `packages/pty-host/src/session.test.ts` (new), `packages/pty-host/src/host-config.ts` (new), `packages/pty-host/src/host-config.test.ts` (new), `packages/pty-host/src/host-entry.ts`, `packages/pty-host/test/real-pty.test.ts`
- **Success criteria:**
  - `[test] attach after 50 of 113 numbered lines gives every line once and in order — packages/pty-host/src/session.test.ts › attach mid-stream gives every line once and in order`
  - `[test] two ports both get data; a detached or closed port gets no more — packages/pty-host/src/session.test.ts › each port gets data until it detaches or closes`
  - `[test] attach to an unknown id gives no session; to an exited one, replay then exit — packages/pty-host/src/service.test.ts › attach edges`
  - `[test] a window port's start, kill, dispose, list, snapshot, or connect gets not allowed and changes nothing — packages/pty-host/src/service.test.ts › a window port can't start, kill, or dispose`
  - `[test] a bad message gives bad message and never throws — packages/pty-host/src/service.test.ts › bad messages`
  - `[test] resize applies inside 2–500 by 1–200 and refuses the rest — packages/pty-host/src/session.test.ts › resize bounds`
  - `[test] output pauses past 100,000 unacked characters, resumes under 5,000, and a closed port releases it — packages/pty-host/src/session.test.ts › flow control`
  - `[test] scrollback reads OPENAFLOW_SCROLLBACK, else 5,000; 6,000 lines keep the newest 5,000 — packages/pty-host/src/host-config.test.ts › scrollback`
  - `[test] ready once, then a beat every 5 s — packages/pty-host/src/service.test.ts › the host beats every 5 s`
  - `[test] kill gives one exit; dispose removes the session from list — packages/pty-host/src/service.test.ts › kill and dispose`
  - `[test] a real pty echoes input sent through an attached port — packages/pty-host/test/real-pty.test.ts › input reaches a real pty`
- **Depends on:** N1
- **One-way door:** none
- **Model:** opus

### S1: Host starter and window link
- **Scope:** Replace N1's glue with a plain starter and its glue. Starter: fork; wait for `ready` (no ready in 20 s: kill, count a failure); a start before ready waits; keep the live set from `started` and `exit`; beats (a log line at 6 s without one; `unresponsive` at 11 s, once per spell; `responsive` at the next); an exit outside a stop restarts the host, up to 5 times in the app's life, reporting the lost live ids each time; then `failed`, after which a start answers `terminals unavailable`. `stop()` sends `shutdown`, kills after 3 s, never restarts. §5's window link: move the folder bridge's sender check into an exported function and use it for both. Quit stops the server and the host together and quits after both. §6's `list` and `kill`. Not here: the quit dialog, tree kills, the banner (session-life).
- **Files owned:** `packages/desktop/src/pty-host-starter.ts` (new), `packages/desktop/src/pty-host-starter.test.ts` (new), `packages/desktop/src/pty-host-main.ts`, `packages/desktop/src/terminal-port.ts` (new), `packages/desktop/src/terminal-port.test.ts` (new), `packages/desktop/src/terminal-port-main.ts` (new), `packages/desktop/src/folder-bridge.ts`, `packages/desktop/src/folder-bridge.test.ts`, `packages/desktop/src/preload-main.ts`, `packages/desktop/src/test-hooks-main.ts`, `packages/desktop/src/shell-main.ts`, `packages/desktop/src/quit-flow.ts`, `packages/desktop/src/quit-flow.test.ts`, `pod-docs/feature-details/desktop.md`
- **Success criteria:**
  - `[test] a start before ready goes through at ready — packages/desktop/src/pty-host-starter.test.ts › a start before ready waits for ready`
  - `[test] no ready in 20 s counts as a crash — packages/desktop/src/pty-host-starter.test.ts › no ready in 20 s`
  - `[test] a crashed host restarts up to 5 times, reporting lost ids each time, then fails; a later start answers terminals unavailable — packages/desktop/src/pty-host-starter.test.ts › restarts, then failed`
  - `[test] 11 s without a beat reads unresponsive once; a beat clears it — packages/desktop/src/pty-host-starter.test.ts › heartbeat`
  - `[test] stop sends shutdown, kills after 3 s, never restarts — packages/desktop/src/pty-host-starter.test.ts › stop`
  - `[test] an exit leaves the live set — packages/desktop/src/pty-host-starter.test.ts › exits`
  - `[test] only the folder bridge's sender gets a port; others get forbidden; the folder bridge still passes its own tests — packages/desktop/src/terminal-port.test.ts › sender rule`
  - `[test] a request waits for ready up to 20 s, and after failed rejects at once — packages/desktop/src/terminal-port.test.ts › port request timing`
  - `[test] a restart sends restarted to every window — packages/desktop/src/terminal-port.test.ts › a restart tells every window`
  - `[test] quit stops the server and the host together and quits after both — packages/desktop/src/quit-flow.test.ts › a quit stops the server and the terminal host together`
- **Depends on:** N1
- **One-way door:** none
- **Model:** opus

### P1: Linux AppImage and release workflow
- **Scope:** `pnpm package` builds one x64 `openaflow-<version>-x86_64.AppImage` and `latest-linux.yml` on Linux, the NSIS installer on Windows, and stops with an error elsewhere. Ship the hooks plugin (§2). AppImage size limits. On Linux the release check checks the files and the sha512 in `latest-linux.yml`, starts the AppImage with temp folders (`APPIMAGE_EXTRACT_AND_RUN=1`), waits for `/api/health`, ends it, and leaves no process. `release.yml`: a `build-linux` job on `ubuntu-latest` (verify, package, check under `xvfb-run`, upload); `publish` takes both builds' files. Outside an AppImage (no `APPIMAGE`), the updater checks nothing and logs one line. Add `verify (ubuntu-latest)` to `pod-ci.yml`. `docs/install.md` Linux section: FUSE 2 (`libfuse2`, `fuse-libs`), `--appimage-extract-and-run`, the GNOME AppIndicator extension, and the Ubuntu 24.04 sandbox limit (describe it; never recommend `--no-sandbox` without the human's choice).
- **Files owned:** `packages/desktop/src/build-config.ts`, `packages/desktop/src/build-config.test.ts`, `packages/desktop/scripts/package.ts`, `packages/desktop/scripts/release-check.ts`, `packages/desktop/src/install-check.ts`, `packages/desktop/src/install-check.test.ts`, `packages/desktop/src/release-rules.ts`, `packages/desktop/src/release-rules.test.ts`, `packages/desktop/src/proof-release.test.ts`, `packages/desktop/src/updater-main.ts`, `packages/desktop/src/update-flow.ts`, `packages/desktop/src/update-flow.test.ts`, `packages/desktop/src/install-note.test.ts`, `.github/workflows/release.yml`, `packages/desktop/src/release-workflow.test.ts`, `.github/workflows/pod-ci.yml`, `packages/desktop/src/ci-workflow.test.ts`, `docs/install.md`, `pod-docs/codebase-structure.md`, `pod-docs/feature-details/installer-and-updates.md`
- **Success criteria:**
  - `[test] Linux builds one x64 AppImage with the agreed name and latest-linux.yml — packages/desktop/src/build-config.test.ts › Linux builds one x64 AppImage`
  - `[test] the target follows the platform; macOS stops with an error — packages/desktop/src/build-config.test.ts › package target per platform`
  - `[test] the hooks plugin sits outside the asar — packages/desktop/src/build-config.test.ts › the hooks plugin sits outside the asar`
  - `[test] AppImage size limits — packages/desktop/src/release-rules.test.ts › AppImage limits`
  - `[test] on Linux the check passes a good AppImage and fails a bad sha512, a missing file, and a test-hooks build — packages/desktop/src/proof-release.test.ts › the Linux release check`
  - `[test] a tag builds the AppImage on ubuntu-latest; publish takes both builds' files; actions stay pinned — packages/desktop/src/release-workflow.test.ts › a tag also builds Linux`
  - `[test] verify runs on windows-latest and ubuntu-latest with today's triggers — packages/desktop/src/ci-workflow.test.ts › verify on both systems`
  - `[test] outside an AppImage the updater stays off with one log line — packages/desktop/src/update-flow.test.ts › outside an AppImage the updater stays off`
  - `[test] the install note names FUSE 2, --appimage-extract-and-run, and the AppIndicator extension — packages/desktop/src/install-note.test.ts › the Linux note`
- **Depends on:** N1, C1, K1
- **One-way door:** this changes the release workflow, which publishes the app to users: a version tag now also builds and publishes a Linux AppImage and `latest-linux.yml`. Nothing publishes until the human pushes a tag. Undo: revert the slice's merge commit before the next tag.
- **Model:** opus

### A1: Start command, proved with real claude
- **Scope:** `packages/model/src/skills.ts`: the fixed list, in order, `plan`, `ship`, `task`, `research`, `idea`, `plain`, each with its command (`/pod:<id>`; none for plain); the `/pod:` prefix lives only here (labels come with terminal-tab). `packages/server/src/session-command.ts`: `sessionCommand({ claude, repo, skill, text, sessionId, runMarker, pluginDir, configDir, env, platform })` → `{ program, args, cwd, env, typeYourself? }` or an error word. Args: exactly `--session-id <id> --plugin-dir <dir>`, then at most one prompt argument, last: `/pod:<skill>` plus a space and the text, or plain text alone. Never `-p`, `--print`, `--bare`, a permission flag, or a model flag. Text is trimmed; empty means none; a control character (U+0000–U+001F, U+007F), over 2,000 characters, or plain text starting with `-` gives `bad text`. Bad ids give `bad id`; `repo` and `pluginDir` must be absolute. Env: the runner's `childEnv`, then §3, plus `TERM=xterm-256color`. Windows: a readable npm shim runs as its node plus script (`shimTarget`); no node gives `node not found`; an unreadable shim runs through cmd.exe with no prompt and `typeYourself` set to the line to type. Real proof (§7; node-pty and `@xterm/headless` used directly): one temp plugin folder holding a copy of the hooks plugin plus a `proof:pong` skill, so the builder's exact args run; Haiku from the scratch repo's `.claude/settings.json`. If a proof fails, file a `PENDING` entry naming the plan's fallback; don't change the contract. On Windows the human runs `OPENAFLOW_REAL_CLAUDE=1 pnpm vitest run packages/pty-host/test/real-claude-start.test.ts`; it also proves that Claude Code runs the hook's `sh` command there.
- **Files owned:** `packages/model/src/skills.ts` (new), `packages/model/src/index.ts`, `packages/model/test/skills.test.ts` (new), `packages/server/src/session-command.ts` (new), `packages/server/src/session-command.test.ts` (new), `packages/pty-host/test/real-claude-start.test.ts` (new), `packages/pty-host/test/fixtures/proof-skill/` (new)
- **Success criteria:**
  - `[test] the skill list is plan, ship, task, research, idea, plain — packages/model/test/skills.test.ts › the skill list`
  - `[test] exact args with one prompt last; a skill with no text gives /pod:<skill> alone; plain with no text gives no prompt — packages/server/src/session-command.test.ts › args`
  - `[test] trim, control characters, 2,000 vs 2,001 characters, plain text starting with - — packages/server/src/session-command.test.ts › text rules`
  - `[test] % ^ " ' & | < > ! and non-ASCII stay one unchanged argument — packages/server/src/session-command.test.ts › special characters stay one argument`
  - `[test] bad or equal ids and relative paths are refused — packages/server/src/session-command.test.ts › ids and paths`
  - `[test] the env drops ANTHROPIC_*, CLAUDE* but the allowlist, and inherited OPENAFLOW_*, then sets §3 and TERM — packages/server/src/session-command.test.ts › the session env`
  - `[test] npm shim, native exe, no node, and an unreadable shim with typeYourself — packages/server/src/session-command.test.ts › windows shims`
  - `[test] with real claude the slash command start argument runs as the first turn — packages/pty-host/test/real-claude-start.test.ts › a slash command start argument runs as the first turn`
  - `[test] the hook file names the --session-id with cause startup, and UserPromptSubmit's prompt equals the built prompt with the special characters — packages/pty-host/test/real-claude-start.test.ts › hooks see the session and the exact prompt`
  - `[test] in a new folder the trust prompt shows first; after the test answers it, the start argument still runs — packages/pty-host/test/real-claude-start.test.ts › the start argument survives the folder-trust prompt`
- **Depends on:** N1, K1
- **One-way door:** none
- **Model:** opus

### E1: Electron terminal checks and docs
- **Scope:** Real Electron checks through the harness. Start sessions through the test hook with a fixture program (`node` plus a script that prints a numbered line every 100 ms and echoes its input). Read the window side with `page.evaluate` code that connects, takes the port, attaches, and acks; no product web code in this sprint. The same checks run packaged with `OPENAFLOW_PACKAGED_APP` (the AppImage on Linux). Turn the `pty proof` jobs into `electron (ubuntu-latest)` and `electron (windows-latest)`: `real-start`, `real-pty-proof`, and `real-terminal`, unpackaged then packaged, today's triggers. Fix `real-start` if it fails on Windows. Write `pod-docs/feature-details/terminal-host.md` (host, protocol, starter, window link, hooks plugin, start command, test hooks, what was proved where) and update `codebase-structure.md` (Parts, Smoke recipe, CI). On a real Windows machine the human runs `pnpm build`, `pnpm package --test-hooks`, then `$env:OPENAFLOW_REAL_ELECTRON='1'; $env:OPENAFLOW_PACKAGED_APP='<repo>\packages\desktop\release\win-unpacked\OpenAFlow.exe'; pnpm test:electron real-terminal`.
- **Files owned:** `packages/desktop/src/real-terminal.test.ts` (new), `packages/desktop/src/real-start.test.ts`, `packages/desktop/test/fixtures/numbered.mjs` (new), `packages/desktop/test/electron-harness.ts`, `.github/workflows/pod-ci.yml`, `packages/desktop/src/ci-workflow.test.ts`, `pod-docs/feature-details/terminal-host.md` (new), `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] text written from the window comes back in the window — packages/desktop/src/real-terminal.test.ts › input from the window echoes back`
  - `[test] after a reload every line shows once and in order, and lines go on — packages/desktop/src/real-terminal.test.ts › a reload replays once and in order`
  - `[test] a window hidden 10 s keeps its output with no replay; a new window replays — packages/desktop/src/real-terminal.test.ts › hide, show, and a new window`
  - `[test] killing the server leaves the terminal live, and /api/health comes back — packages/desktop/src/real-terminal.test.ts › a server crash leaves the terminal live`
  - `[test] killing the host gives a new host PID, the session reported lost, and restarted in the window — packages/desktop/src/real-terminal.test.ts › a host crash restarts the host`
  - `[test] a page port can't start a session — packages/desktop/src/real-terminal.test.ts › the page can't start a session`
  - `[test] the packaged app passes the echo and reload checks — packages/desktop/src/real-terminal.test.ts › packaged`
  - `[test] real-start passes on windows-latest and ubuntu-latest — packages/desktop/src/real-start.test.ts › the shell starts and its server follows it`
  - `[test] electron jobs run on ubuntu-latest under xvfb and on windows-latest, unpackaged then packaged — packages/desktop/src/ci-workflow.test.ts › electron jobs`
- **Depends on:** H1, S1, P1
- **One-way door:** none
- **Model:** opus
