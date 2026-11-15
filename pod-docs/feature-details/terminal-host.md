# Terminal host

## What it is

The desktop app runs terminals for `claude` sessions in its own process, the pty host. A session lives in the host, not in the window, so it outlives a window reload, a hidden window, a closed window, and a server crash. The window reads and types into a session through a `MessagePort`. No screen uses it yet: the Terminal tab and New session come with sprint `terminal-tab`. The protocol and its rules are in [`pod-docs/sprints/host-core.md`](../sprints/host-core.md) (§1–§8). The main-process side (start order, log lines) is also in [desktop.md](desktop.md) (Terminal host, Terminal link, Test hooks).

## How it works

- **Host** (`packages/pty-host`). A second Electron `utilityProcess`, `OpenAFlow terminal host`. It loads `node-pty` (pinned to `1.2.0-beta.18`) and sends `ready`, or `load-failed` and exits 1. Then it beats every 5 s. Each session has a node-pty process and a headless xterm buffer (`@xterm/headless`, 5,000 lines of scrollback, or `OPENAFLOW_SCROLLBACK` from 100 to 100,000). The session's `id` is its run marker.
  - `start` refuses a bad spec and spawns nothing (`bad id`, `id in use`, `program not absolute`, `no folder`, `bad size`, `spawn failed: …`). `started` goes out only once the pty has a pid: on Linux at once, on Windows about 1 s later, when ConPTY's output worker connects. A session that waits for its pid lists as `pid: 0, live: true`.
  - `kill` is the pty's own kill. `dispose` removes the session with no `exit`. `shutdown` kills every pty, waits at most 3 s, and exits 0.
  - `exit` goes once to main and to every attached port. The session stays listed, attachable, and snapshottable until `dispose`.
- **Bundle and package.** `pnpm build` writes `packages/pty-host/dist/pty-host.cjs` with xterm inside and `node-pty` outside, because node-pty loads its native binary from its own folder. Packaged, both sit outside the asar under `<resources>/pty-host/`, with the build system's prebuilds only.
- **Window side.** A window's port may only `attach`, `detach`, `input`, `resize`, and `ack`. Anything else gets `error` `not allowed`; a bad message gets `bad message`; the host never throws.
  - `attach` sends one `replay` (the buffer, serialized at the session's current size), then live `data`. Each chunk reaches the port once and in order. So a window sends `resize` before `attach`.
  - Flow control: only `data` characters count. A port over 100,000 unacked characters pauses the pty; it resumes once every port is under 5,000. A window acks only `data`, never the `replay`. A closed or detached port stops counting.
- **Starter** (`packages/desktop/src/pty-host-starter.ts`). Forks the host after the server's first ready. It waits 20 s for `ready`, watches the beat (a log line at 6 s, `unresponsive` at 11 s), and restarts a host that ends outside a stop, up to 5 times in the app's life. Each crash logs `terminal host lost sessions: <ids>`. After that it is `failed`, and every request answers `terminals unavailable`. The board runs either way. A quit stops the server and the host together.
- **Window link** (`terminal-port.ts`, `terminal-port-main.ts`, `preload-main.ts`). The page calls `window.openaflow.connectTerminals()`. Only the app window's main frame on the server's current origin gets a port; any other caller gets `forbidden`. The port reaches the page as a `window` message `{ type: 'openaflow:terminal-port' }` with the port in `ports[0]`, before the promise resolves. Before the host is ready, the call waits up to 20 s. `window.openaflow.onTerminalHost(fn)` reports `ready`, `unresponsive`, `restarted`, and `failed`. After `restarted`, the old port is dead and the page connects again.
- **Hooks plugin** (`packages/hooks-plugin/plugin/`, packaged at `<resources>/hooks-plugin/`). The plugin `openaflow-hooks` has no skills. For `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`, `PreToolUse`, and `PermissionRequest`, `scripts/record.sh` (POSIX `sh`, no Node, no `jq`) appends one line to `$OPENAFLOW_HOOKS_DIR/$OPENAFLOW_RUN.jsonl`: `{"v":1,"at":<ms>,"payload":<stdin JSON>}`, or a `cut` line over 64 KB. It never writes to stdout and always exits 0. `packages/server/src/hook-state.ts` reads the file into the live session (the newest `SessionStart`, with its cause) and the events, with a `promptHash` and never the prompt text. Nothing calls the reader yet.
- **Start command** (`packages/server/src/session-command.ts`, skills in `packages/model/src/skills.ts`). `sessionCommand` builds `claude --session-id <id> --plugin-dir <dir>` plus at most one prompt argument, last: `/pod:<skill> <text>`, or plain text alone. No print, permission, or model flag. The env is the runner's, with every inherited `OPENAFLOW_*` dropped, then `OPENAFLOW_RUN`, `OPENAFLOW_HOOKS_DIR`, and `TERM=xterm-256color`. On Windows a readable npm shim runs as its `node` plus script; an unreadable one runs through `cmd.exe` with no prompt, and `typeYourself` holds the line to type. Nothing calls it yet.
- **Test hooks.** A `--test-hooks` build (the Electron harness, or `pnpm package --test-hooks`) sets `globalThis.__openaflowTest.terminals`: `start(spec)`, `snapshot(id)`, `list()`, `kill(id)`, and `hostPid()`, which follows the current host after a restart. Every other build drops the code, and `release:check` refuses a `main.cjs` that names it. Never upload or install a `--test-hooks` build.

## Proved where

| What | Linux (Fedora, this machine) | Linux CI (`ubuntu-latest`) | Windows CI (`windows-latest`) | Windows, by hand |
|---|---|---|---|---|
| node-pty in Electron, unpackaged and packaged (`real-pty-proof`) | yes | yes | yes | — |
| The window's echo and reload (`real-terminal`) | yes | yes | yes | — |
| The packaged app's echo and reload (`real-terminal` › `packaged`) | yes: `release/linux-unpacked/openaflow` and the AppImage | yes: `release/linux-unpacked/openaflow` | yes: `release/win-unpacked/OpenAFlow.exe` | the human's command below |
| A `kill` from the main side reaches the program, and the window hears its `exit` | yes | yes | yes | — |
| Hide and a new window, a server crash, a host crash, the page's refusals, and a kill right after the start (`real-terminal`) | yes | yes | yes | — |
| The folder bridge in real Electron (`real-folder-bridge`) | yes | not in CI | not in CI | — |
| The app starts and its server follows it (`real-start`) | yes | yes | yes | — |
| Host protocol, flow control, replay order (unit tests with a fake pty and the real `@xterm/headless`; `real-pty` under Node) | yes | yes (`verify`) | yes (`verify`) | — |
| The hooks plugin's script (`record.test.ts`) | yes | yes (`verify`) | yes, with Git's `sh` (`verify`) | — |
| The start command with real `claude` (`real-claude-start`: the start argument after the folder-trust prompt, `--session-id` with cause `startup`, the exact prompt in `UserPromptSubmit`) | yes | never in CI | never in CI | the human's command below |
| The Windows npm-shim route | unit tests only | — | unit tests only | never ran with real `claude` |
| The `cmd.exe` route (an unreadable shim) | — | — | unit tests only | never ran |
| The `PreToolUse` and `PermissionRequest` hooks firing in real `claude` | never fired | — | — | never fired |

- `real-start` and the Linux gate of `real-folder-bridge` (host-core C1) have no History line in [desktop.md](desktop.md); this table is their record.
- **A kill right after the start:** node-pty holds `kill()` on Windows until the program's first output, so a kill while a session waits for its pid may let the program run for a moment. `real-terminal` › `a kill right after the start ends the session` sends `start`, `list`, and `kill` in a row, and checks that the session ends and its program stops. Its log line, `a kill right after the start answered …`, shows the pid the start gave (or `spawn failed: …`) and the session as `list` saw it at the kill (`pid: 0` means it still waited for its pid). On Linux the pid comes at once, so the kill always lands on a started session.
- **The human's Windows commands**, on a real Windows machine from the repo root:
  - `pnpm build`, `pnpm package --test-hooks`, then `$env:OPENAFLOW_REAL_ELECTRON='1'; $env:OPENAFLOW_PACKAGED_APP='<repo>\packages\desktop\release\win-unpacked\OpenAFlow.exe'; pnpm test:electron real-terminal`.
  - `$env:OPENAFLOW_REAL_CLAUDE='1'; pnpm vitest run packages/pty-host/test/real-claude-start.test.ts` (Haiku, at most 4 turns).

## The Electron checks

`packages/desktop/src/real-terminal.test.ts` starts the real app through `packages/desktop/test/electron-harness.ts`, with temp folders and a free port. Sessions start through the test hook with `node` and `packages/desktop/test/fixtures/numbered.mjs`, which prints `line <n>` every 100 ms and answers each line it reads with `got:<line>`. The page's code (plain code in `page.evaluate`, no product web code) connects, takes the port, sends `resize` then `attach`, and acks each `data`. The test draws what the page got in a headless terminal, the way the Terminal tab's xterm will, and checks the line numbers there: raw chunks can't be checked, because ConPTY redraws the screen.

- **Echo:** text sent from the page comes back as `got:hello-window`; then a `kill` gives `exit` in the window and `live: false`.
- **Reload:** after `page.reload()` the page connects again: one `replay`, first; every line from 1 once and in order; and lines go on.
- **Hide, show, and a new window:** a window hidden 10 s keeps getting `data` with no second replay. Then the window is destroyed and the app's own show (the `second-instance` route, as the tray's Open) opens a new one, which replays.
- **Server crash:** a SIGKILL on the server (its pid from `auto-continue-owner.json`). `/api/health` goes and comes back; the host pid, the session's pid, and `live: true` stay; the screen goes on; the reloaded page misses no line.
- **Host crash:** a SIGKILL on `hostPid()`. A new host pid, an empty `list()`, `terminal host lost sessions: <id>` in `desktop.log`, `restarted` in the page, and `no session` for the old id on a new port.
- **Page refusals:** a page port's `start`, `kill`, `dispose`, `list`, `snapshot`, `connect`, and `shutdown` each get `not allowed`, and nothing starts or stops.
- **A kill right after the start:** the session ends, and a started program stops.
- **Packaged** (with `OPENAFLOW_PACKAGED_APP`): only the echo and reload checks, after `app.isPackaged` is true.

CI runs these in `electron (ubuntu-latest)` and `electron (windows-latest)` (see [codebase-structure.md](../codebase-structure.md#ci)).

## Why it's this way

- The host is its own process, so a server crash or a window reload never ends a session, and a node-pty crash never takes the board down. The window gets a direct port, so terminal bytes never pass through the main process.
- `started` carries the pid, and on Windows ConPTY gives it about 1 s after the spawn, so `started` waits for it instead of reporting pid 0 (wave 1 fix, `c176a5d`).
- The replay is serialized at the session's current size, so a window that attaches at another size must resize first; otherwise the replay draws at the wrong width.

## Watch out

- On Windows, ConPTY lets about 300,000 characters through after an ack resumes the pty, before the pause holds again. Flow control limits memory, not the exact count.
- A kill on Windows while the session waits for its pid may let the program run for a moment (see Proved where).
- After a host crash, the sessions' programs are no longer the host's. In the spike, real `claude` ended in about 1 s from the closed pty's SIGHUP ([terminal-host-spike.md](../research/terminal-host-spike.md)). The session ender that ends leftovers comes with the session-life work in the plan. The test fixture ends itself after 5 minutes for this reason.
- Three `real-*` files in one `pnpm test:electron` call run side by side. CI runs one file a step.
- `real-start` runs Electron's own binary on `dist/main.cjs`, not the harness, so it has no packaged run.

## History

- 2026-11-14 · host-core N1: node-pty proved in Electron, unpackaged and packaged; test hooks and the Electron harness.
- 2026-11-14 · host-core C1: `real-start` (the app starts on Linux and its server follows it) and the folder bridge test on Linux.
- 2026-11-14 · host-core K1: the hooks plugin and the hook-state reader.
- 2026-11-14 · host-core H1: the full host protocol: attach and replay, input, resize, flow control, heartbeat, kill, dispose, list.
- 2026-11-14 · host-core S1: the starter (ready wait, heartbeat, 5 restarts, stop) and the window link.
- 2026-11-14 · host-core P1: the Linux AppImage, the release workflow's Linux build, and `verify (ubuntu-latest)`.
- 2026-11-14 · host-core A1: the start command and the skill list, proved with real `claude` on Linux.
- 2026-11-14 · host-core E1: `real-terminal`, the `electron` CI jobs on both systems, and this page.
