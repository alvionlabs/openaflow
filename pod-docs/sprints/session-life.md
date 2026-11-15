# Sprint: Session life

_From plan: pod-docs/plans/terminal-host.md · Slug: session-life · Status: active · Generated: 2026-11-15_
<!-- autopilot-run: started=2026-11-15T09:51:09Z sprints=0 waves=1 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | H2 | Pty host: saved screens, flush, kill before the pid, stale ports | session-life-H2 | merged | done | medium | — |
| 1 | E1 | Session ender and roster (Linux tree, marker, scope, signals) | session-life-E1 | merged | done | medium | — |
| 1 | J1 | Windows Job Object helper | session-life-J1 | merged | done | medium | — |
| 1 | M2 | Model: resume check, resume action, session label | session-life-M2 | merged | done | medium | — |
| 1 | C2 | Resume command and the Linux run wrapper | session-life-C2 | merged | done | medium | — |
| 2 | S3 | Server: Resume route, saved screens, sweep and labels, 504 | session-life-S3 | https://github.com/alvionlabs/openaflow/pull/141 | pushed | medium | M2, C2, H2 |
| 2 | D2 | Main: quit dialog, ending sessions, leftovers, window events | session-life-D2 | https://github.com/alvionlabs/openaflow/pull/141 | pushed | medium | H2, E1, J1 |
| 2 | W2 | Terminal tab: Resume, can't resume, saved screen, untested paths | session-life-W2 | https://github.com/alvionlabs/openaflow/pull/141 | pushed | medium | M2 |
| 2 | W3 | Host banner, Ending overlay, hosted Waiting rows, reply card | session-life-W3 | https://github.com/alvionlabs/openaflow/pull/141 | pushed | medium | M2 |
| 3 | U2 | Restart now asks the quit question | session-life-U2 | — | pending | — | D2 |
| 3 | X2 | Electron checks for quit, crashes, and Resume; CI; docs | session-life-X2 | — | pending | — | H2, C2, S3, D2, W2, W3 |

## Shared contract

**0. Scope edges.** Here: Resume, `can't resume`, saved screens, quit, process-tree ends, leftovers, the heartbeat banner, and updates (plan Scope; research [Session life, Quit, Resume, Updates, Ending a process tree](../research/terminal-host.md#session-life)). The run wrapper and stop command are fixed Linux defaults here; sprint `settings` makes them editable (decisions 18–22). UI says "session", not the decisions' "run" ("Ending N sessions…"), as the plan and the approved draft do. The ender touches hosted sessions only: a resumed `claude -p` still outlives a quit (`real-exit.test.ts`).

**1. Machine notes.** Terminal-tab §1, plus: Windows proof is a green `windows-latest` job (`verify` runs plain vitest files, `electron` runs `real-*`). Ports by board order (i = 0 for H2 … 10 for X2): API `8400 + 10i`, web `8401 + 10i`. Real `claude` runs only through X1's gate, which the human hasn't set up, so those proofs skip. New `real-*` names must not hold `real-session`, `real-terminal`, `real-exit`, or `real-start`. The desktop window stops at 800 px: check 375 px with Playwright's `page.setViewportSize({ width: 375, height: 667 })`. The human tests by hand in `pnpm desktop` on Linux.

**2. Pty host additions** (host-core §4).
- `StartSpec.screenFile?: string`: absolute, else `start` refuses `bad screen file`. The host writes the session's `snapshot` text there: every `SCREEN_SAVE_MS` = 10,000 when the text changed since its last write; once after `exit`; on `flush`; at `shutdown` before it kills ptys. A write makes the folder, writes a temp file beside it, renames, mode 0600. A failed write logs one line per session, with no text, and never throws. No write after `dispose`.
- `flush` (main → host) → the host writes every session's file, then answers `flushed` once, at most 2 s after the ask.
- `kill` or `dispose` of a session waiting for its pid: answers `start-failed` `spawn failed: killed before it started` / `spawn failed: disposed before it started`, frees the id, never sends `started` or `exit`, and kills the pty as soon as node-pty takes the kill. On Windows the program may run for a moment (queue 2026-11-15, E1); nothing more is promised.
- Stale port: a port over `FLOW.pauseAbove` that has sent nothing for `STALE_PORT_MS` = 30,000 stops counting toward the pause. It still gets data; its next message counts it again from 0 (queue 2026-11-15, E1).

**3. Server ↔ main additions** (terminal-tab §2).
```ts
{ op: 'start', req, spec: StartSpec, stop?: string[] }      // stop: §6's argv; spec.screenFile set (§5)
{ op: 'sweep', sessions: { id: string; stop?: string[] }[] }
{ op: 'labels', labels: { id: string; label: string }[] }
```
- `stop`: 1–32 strings, each ≤ 1,024 characters, the first absolute. Else the start goes on with no stop and one log line.
- `sweep`: only a server with a terminal channel sends it, once per reconcile, naming each record that reconcile set to `stopped · app closed`. None → no message. Main skips ids the starter holds (live or waiting for a pid) and sweeps the rest (§7).
- `labels`: every `starting` or `live` record with `sessionLabel` (§4). Sent at each server start and after a Board rebuild when the list differs from the last sent. Main keeps the newest: at most 100, each cut to 120 characters, control characters dropped. After the server is gone, main uses the last list.
- From a quit's confirm (or `endSessions()` true) on, main sends the server no `exit` or `lost`. So the next start's reconcile reads those sessions `stopped · app closed`, as the draft shows after a quit.
- `spec` reaches the host unchanged, `screenFile` included. Bad shapes: ignored with one log line, as today.

**4. Store, Board, model.**
- `StoredSession.resumedFrom?: string`: the marker it resumes; only while `starting`, dropped at `started`. `readRecord` keeps it.
- `HostedSession.resume?: 'ok' | 'no folder' | 'no conversation' | 'in use'`, set only on `ended` and `stopped`. First match: the repo path isn't a folder → `no folder`; no file `<claude dir>/projects/<projectDirName(repoPath)>/<liveSession>.jsonl` → `no conversation`; a `starting` or `live` record in any repo whose `sessions` hold `liveSession` → `in use`; else `ok`. `<claude dir>` is the server's transcript folder.
- `ActionEntry` gains `{ action: 'resume-session'; result: 'started' | 'failed' }`, target `<skill command or plain> · <new marker first 8>`.
- `sessionLabel(repo, session, now)`: `<repo name> · <joined run>`, or `<repo name> · no plan yet`.
- No new member in `SessionView`, `SessionDot`, `StoredSessionState`, or `StopReason`.

**5. Routes** (behind the existing guard and token).
- `POST /api/actions/resume-session {repoId, marker, cols?, rows?}` → `200 {outcome:'started', marker:<new>, logged}`. Errors, first match: `400 bad request`; `409 no terminal host`; `404 no session` (also a repeat after success); `409 session is live`; `409 session starting` (this repo, so a second press lands here); `409 claude not found`; `409 can't resume: <reason>` (§4, checked again now); `409 too many sessions`; `400 <command word>`; `502 start failed: <host word>`; `504 terminals unavailable`. It saves a new record (new marker; `sessionId` the old `liveSession`; old `skill`; `resumedFrom`), then starts §6's resume command. On `started`: the old record goes, its hook and screen files are deleted (missing is fine), and the old id is disposed. On `start-failed`: the new record goes, the old one stays. On `504`: as New session today (the new record stays `starting`; queue 2026-11-15 S1 waits on the human), and the old one stays. Logs one entry, rebuilds, answers.
- New session and Resume set `spec.screenFile` to `<config dir>/screens/<marker>.txt`. Dismiss also deletes that file.
- `GET /api/sessions/<marker>/screen` (token required): `200 {text}`; `404 {error:'no screen'}` when the marker isn't a stored record or has no file; `403 bad token`. It reads only paths built from a stored marker. Screen text is never on the Board or in a log.

**6. Session commands** (`packages/server`).
- `resumeCommand(o)`: as `sessionCommand`, with args `--resume <sessionId> --plugin-dir <dir>`, no prompt, no `--session-id`. Windows routes as today; an unreadable shim gives no `typeYourself`.
- Linux run wrapper. `scopeProbe()` runs once per server start: `<systemd-run> --user --scope --quiet <true>` with a session's env, 5 s limit. Exit 0: on. Else, or a tool not found as an absolute path on PATH: off, and one line `openaflow: sessions run with no systemd scope: <reason>`. On: program `<systemd-run>`, args `--user --scope --quiet --unit=openaflow-run-<marker>.scope <program> <args…>`; stop `[<systemctl>, '--user', 'stop', 'openaflow-run-<marker>.scope']`. Off, Windows, macOS: no wrapper, no stop.

**7. Ending a session** (`packages/desktop`).
- Linux `end(id, pid, stop?)`: (1) start the stop command, no shell, killed after 6 s, a failure is one log line; (2) snapshot the pid's process group and descendants (`/proc/*/stat`) and every process whose `/proc/<pid>/environ` holds `OPENAFLOW_RUN=<id>`, each with its start time; (3) SIGHUP to the group; wait until the snapshot is gone, at most 3 s; (4) SIGTERM to the group and each survivor; at most 3 s; (5) SIGKILL each survivor; (6) 500 ms later, survivors → one line `openaflow desktop: session <id first 8> left <n> processes`. Never signal pid ≤ 1, main, its parent, the host, the server, or a pid whose start time differs from the snapshot. Pid 0: steps 1, 2 (marker only), 4–6.
- Linux `sweep(id, stop?)` (no live pty): steps 1, 2 (marker only), 4–6.
- Windows `end`: `jobs.close(id)`, then `taskkill /T /F /PID <pid>` when pid > 0 (hidden), wait at most 3 s, log survivors. `sweep`: `jobs.close(id)`. No env reads on Windows.
- `type JobControl = { assign(id: string, pid: number): Promise<boolean>; close(id: string): Promise<void>; dispose(): void }`. J1 builds it; E1 declares the same shape; D2 passes one to the other.
- Roster: each session main started this app life: pid, stop, label, live or ended. `started` assigns the job on Windows. `endAll()`: host `flush` (2 s at most), then `end` for each live one and `sweep` for each that ended this app life, all at once; done in about 7 s. `lost(ids)` → `sweep` each. `sweep(sessions)` from the server skips live and pid-waiting ids.

**8. Quit, update, window.**
- `before-quit` with no live session: today's flow. Else the native dialog: message `1 session is active. Quit ends it.` or `N sessions are active. Quit ends them.`; detail: one label per line (unknown: `a session`), at most 10, then `and N more`; buttons `Quit and end sessions`, `Cancel`; Cancel is the default and the cancel id. Cancel: nothing changes; a later quit asks again. A quit while the dialog is open is ignored. Confirm: windows get `openaflow:quitting {count}`, `endAll()` runs, then windows hide and today's stops run.
- After the server failed for good, a quit doesn't ask: it ends the sessions as after a confirm (the error box came first).
- `ctx.endSessions(): Promise<boolean>`: no live session → `true`, no dialog. Else the same dialog (no dialog after a server failure, as above). Cancel → `false`. Confirm → overlay, `endAll()`, `true`; the quit after it asks nothing.
- `session-end` (Windows shutdown): no dialog; `flush` and `endAll()` start; nothing waits.
- Preload adds `window.openaflow.onQuitting(fn: (count: number) => void): () => void` and `window.openaflow.terminalHostState(): Promise<'starting' | 'ready' | 'unresponsive' | 'failed'>` (queue 2026-11-15, S1). The sender rule applies.
- Test hooks: a test-hooks build never opens the native box. It answers `end`, or `cancel` after `__openaflowTest.quit.answer('cancel')`, so the harness's `close()` still quits. Main logs `openaflow desktop: quit asked about <n> sessions: <answer>`.
- Restart now (also on the last chance) calls `ctx.endSessions()` first: `false` → like Later, log `update <version>: kept, sessions are active`; `true` → today's restart.

**9. Web.**
- Stop bar, `resume` `ok`: today's dot and word, line `<end line> Resume starts the same Claude session again.`, **Resume** (primary) then **Dismiss**. Not `ok`: blocked dot, word `Can't resume`, line `The repo folder is gone.` / `The session file is gone.` / `Another terminal holds this session.`, **Dismiss** only. Absent: Dismiss only.
- Under the bar: the host's replay while it holds the session; else §5's saved screen, faded; else the bar alone.
- Resume: posts once; `Resuming…`, both buttons off; waits up to 10 s for the new marker, then focuses the terminal. Errors in the alert box under the bar: `can't resume: …` → the reason line; `session starting` and `too many sessions` → N1's words; 502, 504, network → `The session didn't resume. Please try again`.
- Banner (desktop only): `unresponsive` → blocked dot, `Terminals are not responding.`, muted `Your sessions may still run. The app keeps trying.`; `ready` or `restarted` hides it; at page load from `terminalHostState()`.
- Overlay on `onQuitting(count)`: full page, run dot, `Ending 1 session…` or `Ending N sessions…`, `role="status"`, no buttons.
- Browser build: never Resume, the banner, or the overlay.

**10. Electron checks and CI.** New `real-quit.test.ts` and `real-resume.test.ts`, each gated as host-core §7, with a fake `claude` fixture `life-claude.mjs`. A scope case runs only when §6's probe works, else skips with a printed reason (`ubuntu-latest` may have no user bus). Both electron jobs gain `real-quit` and `real-resume` steps, and `real-resume` packaged.

## Per-slice detail

### H2: Pty host: saved screens, flush, kill before the pid, stale ports
- **Scope:** §2 in `packages/pty-host`: the protocol types (`screenFile`, `flush`, `flushed`, `MAIN_ONLY`), the screen writer, the pid-wait kill and dispose, and the stale-port rule. Fake pty, fake clock, real `@xterm/headless`. X2 writes the docs.
- **Files owned:** `packages/pty-host/src/protocol.ts`, `packages/pty-host/src/service.ts`, `packages/pty-host/src/service.test.ts`, `packages/pty-host/src/session.ts`, `packages/pty-host/src/session.test.ts`, `packages/pty-host/src/screen-file.ts` (new), `packages/pty-host/src/screen-file.test.ts` (new)
- **Success criteria:**
  - `[test] a session's screen is written at 10 s only when it changed, after exit, and at shutdown before the kill — packages/pty-host/src/screen-file.test.ts › save times`
  - `[test] the file is replaced whole with mode 0600 and its folder made — packages/pty-host/src/screen-file.test.ts › atomic write`
  - `[test] a failed write logs one line with no text and the session goes on; no write after dispose — packages/pty-host/src/screen-file.test.ts › write failures`
  - `[test] a relative screenFile is refused bad screen file and spawns nothing — packages/pty-host/src/service.test.ts › start refuses bad specs and spawns nothing`
  - `[test] flush writes every file and answers flushed once; a hung write still answers within 2 s — packages/pty-host/src/service.test.ts › flush`
  - `[test] kill and dispose while waiting for the pid answer start-failed, kill at the pid, and never send started or exit — packages/pty-host/src/service.test.ts › kill before the pid`
  - `[test] a port over the limit and silent 30 s stops holding the pty; at 29.9 s it holds; its next message counts again — packages/pty-host/src/session.test.ts › stale port`
  - `[test] a window port's flush gets not allowed — packages/pty-host/src/service.test.ts › a window port can't start, kill, or dispose`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### E1: Session ender and roster
- **Scope:** §7's plain modules: `/proc` reading, the Linux `end` and `sweep`, the Windows `end` and `sweep` against a `JobControl` and an injected `taskkill`, and the roster. OS calls are injected; unit tests use fakes. Real Linux cases spawn a group leader with the marker in its env that starts a child, a `setsid` orphan, and a child that ignores SIGHUP and SIGTERM. No wiring and no docs: D2 does both.
- **Files owned:** `packages/desktop/src/proc-scan.ts` (new), `packages/desktop/src/proc-scan.test.ts` (new), `packages/desktop/src/session-ender.ts` (new), `packages/desktop/src/session-ender.test.ts` (new), `packages/desktop/src/session-roster.ts` (new), `packages/desktop/src/session-roster.test.ts` (new)
- **Success criteria:**
  - `[test] the snapshot holds the group, the descendants, and marker holders with start times, and skips unreadable entries — packages/desktop/src/proc-scan.test.ts › snapshot`
  - `[test] the steps run in order: stop command, snapshot, SIGHUP, SIGTERM, SIGKILL; each wait ends early when all are gone — packages/desktop/src/session-ender.test.ts › linux order`
  - `[test] pid ≤ 1, main, its parent, the host, the server, and a reused pid are never signalled — packages/desktop/src/session-ender.test.ts › never signals`
  - `[test] a stop command that fails or hangs logs one line and the signals go on; done within 7 s — packages/desktop/src/session-ender.test.ts › stop command edges`
  - `[test] pid 0 and sweep use the marker and skip SIGHUP — packages/desktop/src/session-ender.test.ts › no pid`
  - `[test] Windows closes the job, then taskkill /T /F, and logs survivors — packages/desktop/src/session-ender.test.ts › windows`
  - `[test] on Linux a real tree with an orphan and a signal-ignoring child is gone, and its port closed — packages/desktop/src/session-ender.test.ts › real tree ends`
  - `[test] with a working user scope, an env-cleared setsid child is ended by the stop command; else it skips with the reason — packages/desktop/src/session-ender.test.ts › real scope`
  - `[test] endAll flushes first, ends live ones and sweeps ended ones in parallel, and a hung flush waits only 2 s — packages/desktop/src/session-roster.test.ts › end all`
  - `[test] a server sweep skips live and pid-waiting ids; lost ids are swept once — packages/desktop/src/session-roster.test.ts › sweeps`
  - `[test] started assigns the job on Windows only — packages/desktop/src/session-roster.test.ts › jobs`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### J1: Windows Job Object helper
- **Scope:** `createJobControl({ spawn, log })` returning §7's `JobControl`: one hidden `powershell.exe -NoProfile -NonInteractive` child of main, started at the first `assign`, compiling a small C# class with `Add-Type` (`CreateJobObject`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `AssignProcessToJobObject`). Lines: `assign <id> <pid>` → `ok <id>` or `fail <id> <code>`; `close <id>` → `closed <id>`. stdin closes → it exits, and Windows ends each job's processes. No answer in 10 s → `assign` is `false`. A dead helper logs one line; the next `assign` starts a new one. No new dependency. If it can't work on `windows-latest`, ship tree kill only (`assign` always `false`) and file a `PENDING` naming the gap.
- **Files owned:** `packages/desktop/src/windows-jobs.ts` (new), `packages/desktop/src/windows-jobs.test.ts` (new)
- **Success criteria:**
  - `[test] the line protocol: assign, close, a 10 s silence, a dead helper — packages/desktop/src/windows-jobs.test.ts › helper protocol`
  - `[test] on Windows, close ends an assigned process and the detached child it started, and its port closes — packages/desktop/src/windows-jobs.test.ts › close ends the job`
  - `[test] on Windows, killing the helper ends every assigned process — packages/desktop/src/windows-jobs.test.ts › helper exit ends the jobs`
  - `[test] the helper starts hidden, and only on Windows — packages/desktop/src/windows-jobs.test.ts › hidden and Windows only`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### M2: Model: resume check, resume action, session label
- **Scope:** §4's types and `sessionLabel` in `@openaflow/model`. Pure. Nothing reads `resume` yet.
- **Files owned:** `packages/model/src/board.ts`, `packages/model/src/actions.ts`, `packages/model/src/hosted.ts`, `packages/model/src/hosted.test.ts`, `packages/model/src/index.ts`
- **Success criteria:**
  - `[test] the label names the joined run, or no plan yet on the repo row — packages/model/src/hosted.test.ts › session label`
  - `[test] a session with any resume value reads the same row state and word as without — packages/model/src/hosted.test.ts › resume leaves rows alone`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### C2: Resume command and the Linux run wrapper
- **Scope:** §6: `resumeCommand` in `session-command.ts` (`sessionCommand` stays as it is), and `run-wrapper.ts` with `scopeProbe`, `wrapStart(cmd, marker, probe)` → `{ program, args, stop? }`. Tools found with `resolveBin` (absolute PATH entries only). Run the probe with the same env a session gets (check that `childEnv` keeps what `systemd-run --user` needs, such as `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`).
- **Files owned:** `packages/server/src/session-command.ts`, `packages/server/src/session-command.test.ts`, `packages/server/src/run-wrapper.ts` (new), `packages/server/src/run-wrapper.test.ts` (new)
- **Success criteria:**
  - `[test] resume args are exactly --resume <id> --plugin-dir <dir>, with no prompt and no --session-id; bad ids and paths are refused — packages/server/src/session-command.test.ts › resume args`
  - `[test] the resume env is the session env with its own marker — packages/server/src/session-command.test.ts › the session env`
  - `[test] Windows resume: npm shim through node; an unreadable shim through cmd.exe with no typeYourself — packages/server/src/session-command.test.ts › windows shims`
  - `[test] probe on: the wrapped argv and stop name the marker's unit; off on exit 1, a 5 s hang, a missing tool, and Windows — packages/server/src/run-wrapper.test.ts › wrapper and probe`
  - `[test] the probe runs once per server start and logs one line when off — packages/server/src/run-wrapper.test.ts › probe once`
  - `[test] on Linux with a user bus, a wrapped program runs in its unit, and the stop ends it; else it skips with the reason — packages/server/src/run-wrapper.test.ts › real scope`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### S3: Server: Resume route, saved screens, sweep and labels, 504
- **Scope:** §3's server side, §4's `resume` on the Board and `resumedFrom`, §5's routes, and §6's wrapper on New session and Resume (probe at start). The reconcile sends `sweep`; the Board rebuild sends `labels`. Update `hosted-sessions.md`.
- **Files owned:** `packages/server/src/session-routes.ts`, `packages/server/src/session-routes.test.ts`, `packages/server/src/session-store.ts`, `packages/server/src/session-store.test.ts`, `packages/server/src/terminal-channel.ts`, `packages/server/src/terminal-channel.test.ts`, `packages/server/src/screen-route.ts` (new), `packages/server/src/screen-route.test.ts` (new), `packages/server/src/board-service.ts`, `packages/server/src/board-service.test.ts`, `packages/server/src/start-server.ts`, `packages/server/src/start-server.test.ts`, `packages/server/src/app.ts`, `packages/server/src/action-log.ts`, `packages/server/src/action-log.test.ts`, `pod-docs/feature-details/hosted-sessions.md`
- **Success criteria:**
  - `[test] Resume starts the resume command with the wrapper, stop, and screen file, then removes the old record, its hook and screen files, and disposes the old id — packages/server/src/session-routes.test.ts › resume starts`
  - `[test] each resume error in order, including can't resume with each reason — packages/server/src/session-routes.test.ts › resume errors`
  - `[test] a refused start keeps the old record; a second press gives session starting; a repeat after success gives no session — packages/server/src/session-routes.test.ts › resume edges`
  - `[test] a Resume 504 keeps the new record starting and the old record as it was — packages/server/src/session-routes.test.ts › resume edges`
  - `[test] dismiss also deletes the screen file; a missing one is fine — packages/server/src/session-routes.test.ts › dismiss`
  - `[test] resume reads ok, no folder, no conversation, and in use, in that order, only on ended and stopped — packages/server/src/board-service.test.ts › resume check`
  - `[test] the screen route gives the text with a token, 404 for an unknown or non-UUID marker or no file, 403 without a token — packages/server/src/screen-route.test.ts › saved screen`
  - `[test] reconcile sends one sweep with the app-closed records and their stop argv; none sends nothing; no channel never sends — packages/server/src/start-server.test.ts › sweep after reconcile`
  - `[test] labels go at start and only when the open list changes — packages/server/src/board-service.test.ts › labels`
  - `[test] resumedFrom survives a reload and is dropped at started — packages/server/src/session-store.test.ts › resumed records`
  - `[test] resume-session entries survive a restart — packages/server/src/action-log.test.ts › session entries`
- **Depends on:** M2, C2, H2
- **One-way door:** terminal text, which can hold secrets you typed or Claude printed, is now saved to disk in the app's config folder (`screens/`, owner-only files) every 10 s for each session, until you Dismiss or Resume it. Undo: revert the slice's merge commit, then delete the `screens` folder in the config folder.
- **Model:** opus

### D2: Main: quit dialog, ending sessions, leftovers, window events
- **Scope:** §3's main side (relay: `stop`, `sweep`, `labels`, `lost` → roster, silence after a confirm; starter: `flush`, pids in the live set), §8 (quit dialog glue in `quit-main.ts`, `endSessions` on `ShellContext`, overlay event, `terminalHostState`, the test hook), and the wiring in `shell-main.ts` (roster, ender, `JobControl` on Windows only). Update `desktop.md`, and scope its "never a tree kill or Job Object" rule to resumed `-p` runs.
- **Files owned:** `packages/desktop/src/terminal-relay.ts`, `packages/desktop/src/terminal-relay.test.ts`, `packages/desktop/src/pty-host-starter.ts`, `packages/desktop/src/pty-host-starter.test.ts`, `packages/desktop/src/quit-flow.ts`, `packages/desktop/src/quit-flow.test.ts`, `packages/desktop/src/quit-main.ts` (new), `packages/desktop/src/shell-main.ts`, `packages/desktop/src/preload-main.ts`, `packages/desktop/src/terminal-port.ts`, `packages/desktop/src/terminal-port.test.ts`, `packages/desktop/src/terminal-port-main.ts`, `packages/desktop/src/test-hooks-main.ts`, `packages/desktop/src/bundle-desktop.test.ts`, `packages/desktop/src/real-folder-bridge.test.ts`, `packages/desktop/src/real-session.test.ts`, `pod-docs/feature-details/desktop.md`
- **Success criteria:**
  - `[test] started with a valid stop reaches the roster; a bad stop starts with none and one log line — packages/desktop/src/terminal-relay.test.ts › start stop argv`
  - `[test] sweep skips held ids and sweeps the rest; lost ids are swept; bad shapes log one line — packages/desktop/src/terminal-relay.test.ts › sweeps`
  - `[test] labels are kept, cut, and cleaned; the last list stays after the server goes — packages/desktop/src/terminal-relay.test.ts › labels`
  - `[test] the spec reaches the host unchanged, screenFile included — packages/desktop/src/terminal-relay.test.ts › start answers once`
  - `[test] from a confirm on, no exit or lost reaches the server — packages/desktop/src/terminal-relay.test.ts › silent after the quit`
  - `[test] a quit with a live session, through the harness, answers end with no box and the restart reads stopped · app closed — packages/desktop/src/real-session.test.ts › app restart`
  - `[test] flush resolves at flushed, or after 2 s — packages/desktop/src/pty-host-starter.test.ts › flush`
  - `[test] no live session: no dialog, today's stops — packages/desktop/src/quit-flow.test.ts › a quit stops the server and the terminal host together`
  - `[test] the dialog text, labels, and Cancel default; Cancel changes nothing and the next quit asks again; a quit during the dialog is ignored — packages/desktop/src/quit-flow.test.ts › quit with live sessions`
  - `[test] confirm sends quitting, ends sessions before the stops, then quits — packages/desktop/src/quit-flow.test.ts › confirm ends sessions first`
  - `[test] after the server failed for good, the quit ends sessions with no dialog — packages/desktop/src/quit-flow.test.ts › server failed`
  - `[test] endSessions: true with no dialog when none is live, false on Cancel, true after a confirm with no second ask — packages/desktop/src/quit-flow.test.ts › end sessions`
  - `[test] session-end starts flush and endAll and waits for nothing — packages/desktop/src/quit-flow.test.ts › session end`
  - `[test] terminalHostState answers the current state; another sender gets forbidden — packages/desktop/src/terminal-port.test.ts › host state`
  - `[test] the page sees pickFolder, connectTerminals, onTerminalHost, onQuitting, terminalHostState — packages/desktop/src/real-folder-bridge.test.ts › the folder bridge in real Electron`
  - `[test] the quit answer hook exists only in a test-hooks bundle — packages/desktop/src/bundle-desktop.test.ts › test hooks exist only in a test-hooks bundle`
- **Depends on:** H2, E1, J1
- **One-way door:** after you confirm Quit, the app ends every program a session started, dev servers included, and anything they hadn't saved is lost. At the next start after a crash, it ends a crashed session's leftover programs with no question. Undo: revert the slice's merge commit; programs it already ended stay ended.
- **Model:** opus

### W2: Terminal tab: Resume, can't resume, saved screen, untested paths
- **Scope:** §9's stop bar, Resume flow, and the screen under the bar, inside `TerminalTab.tsx` (its props stay as they are; it takes focus after its own Resume). Tests for queue 2026-11-15 T1's untested paths: `starting` holds the attach until `live`, `failed` shows "This terminal is not available.", `restarted` recovers, and the 409 alert under the bar. Logic in `.ts` files. Read `DESIGN.md`; tokens only. Update `runs-and-pipeline.md`.
- **Files owned:** `packages/web/src/screens/runs/TerminalTab.tsx`, `packages/web/src/screens/runs/TerminalView.tsx`, `packages/web/src/screens/runs/terminal-tab.ts`, `packages/web/src/screens/runs/terminal-tab.test.ts`, `packages/web/src/screens/runs/dismiss-flow.ts`, `packages/web/src/screens/runs/dismiss-flow.test.ts`, `packages/web/src/screens/runs/resume-session-flow.ts` (new), `packages/web/src/screens/runs/resume-session-flow.test.ts` (new), `packages/web/src/screens/runs/terminal.css`, `packages/web/src/actions-client.ts`, `packages/web/src/actions-client.test.ts`, `packages/desktop/src/real-terminal-tab.test.ts`, `packages/desktop/test/fixtures/tab-claude.mjs`, `pod-docs/feature-details/runs-and-pipeline.md`
- **Success criteria:**
  - `[test] in Electron the fake's exit still reads Ended · Claude exited, never Can't resume, because the test writes its transcript file; this holds before and after S3 merges — packages/desktop/src/real-terminal-tab.test.ts › ended and dismissed`
  - `[test] resume ok gives the line, Resume then Dismiss; each can't resume reason gives its line, the blocked dot, and Dismiss only; no resume field gives Dismiss only — packages/web/src/screens/runs/terminal-tab.test.ts › stop bar`
  - `[test] under the bar: the replay while held, else the saved screen, else nothing — packages/web/src/screens/runs/terminal-tab.test.ts › screen under the bar`
  - `[test] the browser view never offers Resume — packages/web/src/screens/runs/terminal-tab.test.ts › browser rule`
  - `[test] Resume posts once, stays busy, waits for the new marker, and gives up after 10 s with no move — packages/web/src/screens/runs/resume-session-flow.test.ts › resume`
  - `[test] each error goes to the box in its words, and a retry is allowed — packages/web/src/screens/runs/resume-session-flow.test.ts › errors`
  - `[test] starting holds the attach until live; failed shows the unavailable line; restarted attaches again — packages/web/src/screens/runs/terminal-tab.test.ts › host paths`
  - `[test] a 409 on Dismiss shows the alert under the bar and keeps the bar — packages/web/src/screens/runs/dismiss-flow.test.ts › dismiss`
  - `[test] resumeSession and savedScreen send the token and read the answers — packages/web/src/actions-client.test.ts › session calls`
  - `[manual] the stop bar with Resume, the can't resume bar, and the faded saved screen match the draft's section 3, light and dark, at 1280 and 800 px in pnpm desktop, and at 375 px by setViewportSize — on the wave head `session-life-w2` (it needs S3): kill -9 the host pid while a session runs; a fake `claude` reads Can't resume, so for Resume write its transcript file or use your own `claude``
- **Depends on:** M2
- **One-way door:** none
- **Model:** opus

### W3: Host banner, Ending overlay, hosted Waiting rows, reply card
- **Scope:** §9's banner and overlay in `RunsScreen.tsx` (desktop only); `desktop-bridge.ts` gains `onQuitting` and `terminalHostState`. Queue 2026-11-15 N1: a hosted reply or waiting card in the Waiting tab's rest list gets **Open terminal** (`requestTab`), never Copy or Run it yourself. The reply card on a stopped hosted run reads `This run's terminal has stopped. Resume it in the Terminal tab, then type <word>.` when `resume` is `ok`, else today's dismiss line. The engineer view's tab request gets a test (move its logic out of `RunsScreen.tsx`). Action log word: `Resumed session`. Read `DESIGN.md`; tokens only. Update `app-shell.md`.
- **Files owned:** `packages/web/src/screens/runs/RunsScreen.tsx`, `packages/web/src/screens/runs/runs-screen.test.ts`, `packages/web/src/screens/runs/tab-panels.test.ts`, `packages/web/src/screens/runs/tab-memory.ts`, `packages/web/src/screens/runs/tab-memory.test.ts`, `packages/web/src/screens/runs/HostBanner.tsx` (new), `packages/web/src/screens/runs/QuitOverlay.tsx` (new), `packages/web/src/screens/runs/host-banner.ts` (new), `packages/web/src/screens/runs/host-banner.test.ts` (new), `packages/web/src/screens/runs/host-banner.css` (new), `packages/web/src/screens/runs/WaitingTab.tsx`, `packages/web/src/screens/runs/waiting-tab.ts`, `packages/web/src/screens/runs/waiting-tab.test.ts`, `packages/web/src/screens/runs/next-step.ts`, `packages/web/src/screens/runs/next-step.test.ts`, `packages/web/src/screens/runs/reply-view.ts`, `packages/web/src/screens/runs/reply-view.test.ts`, `packages/web/src/screens/runs/action-log-view.ts`, `packages/web/src/screens/runs/action-log-view.test.ts`, `packages/web/src/desktop-bridge.ts`, `packages/web/src/desktop-bridge.test.ts`, `pod-docs/feature-details/app-shell.md`
- **Success criteria:**
  - `[test] the banner shows on unresponsive, hides on ready and restarted, reads the state at load, and never shows without a bridge — packages/web/src/screens/runs/host-banner.test.ts › banner`
  - `[test] the overlay words for 1 and 3 sessions, as a status with no buttons — packages/web/src/screens/runs/host-banner.test.ts › overlay`
  - `[test] the bridge gives onQuitting and terminalHostState, or undefined when the page lacks them — packages/web/src/desktop-bridge.test.ts › terminal bridge`
  - `[test] a hosted reply or waiting card in the rest list gives Open terminal and no Copy or Run it yourself; the browser gives the desktop note — packages/web/src/screens/runs/waiting-tab.test.ts › hosted rows`
  - `[test] a stopped hosted run says to resume when resume is ok, else to dismiss first — packages/web/src/screens/runs/next-step.test.ts › stopped hosted reply`
  - `[test] a tab request on an engineer view opens the Terminal tab of that run — packages/web/src/screens/runs/tab-memory.test.ts › terminal tab`
  - `[test] resume-session rows read Resumed session · <skill> · <marker> — packages/web/src/screens/runs/action-log-view.test.ts › session actions`
  - `[manual] the banner matches the draft's section 4 and the overlay its section 5, light and dark, at 1280 and 800 px, and 375 px by setViewportSize — banner: kill -STOP the host pid, wait 12 s, then kill -CONT; overlay, on the wave head `session-life-w2` (it needs D2): quit with a session whose program ignores SIGHUP`
- **Depends on:** M2
- **One-way door:** none
- **Model:** sonnet

### U2: Restart now asks the quit question
- **Scope:** §8's last bullet in `update-flow.ts` (a `endSessions` option) and `updater-main.ts` (passes `ctx.endSessions`). Update `installer-and-updates.md` (the flow chart and Why).
- **Files owned:** `packages/desktop/src/update-flow.ts`, `packages/desktop/src/update-flow.test.ts`, `packages/desktop/src/updater-main.ts`, `pod-docs/feature-details/installer-and-updates.md`
- **Success criteria:**
  - `[test] Restart now with live sessions and Cancel: no stop, no install, logged kept, and no second ask this run — packages/desktop/src/update-flow.test.ts › restart with live sessions`
  - `[test] a confirm ends sessions before the server stop and the install — packages/desktop/src/update-flow.test.ts › restart after the quit question`
  - `[test] no live session: today's restart with no question; the last chance follows the same rule — packages/desktop/src/update-flow.test.ts › restart with no sessions`
- **Depends on:** D2
- **One-way door:** none
- **Model:** opus

### X2: Electron checks for quit, crashes, and Resume; CI; docs
- **Scope:** §10 through the harness (its `dir` option for restarts). `life-claude.mjs`: prints its args, writes its `SessionStart` line for `--session-id` or `--resume`, echoes input, and on request starts a detached child (and on Linux an env-cleared `setsid` child) that listens on `127.0.0.1` and records its pid and port. The test writes the transcript file Resume needs. Add a real-`claude` proof that Resume brings back the conversation to `real-claude-start.test.ts` (skips without X1's folder). Update `terminal-host.md` (Proved where, protocol lines) and `codebase-structure.md` (Parts, Smoke recipe: quit, Resume, banner; CI; a quit still never ends a resumed `-p` run). Human checks for the wave PR: real `claude` Resume after a host kill in `pnpm desktop` on Linux; on Windows, a detached child of a session ends at quit.
- **Files owned:** `packages/desktop/src/real-quit.test.ts` (new), `packages/desktop/src/real-resume.test.ts` (new), `packages/desktop/test/fixtures/life-claude.mjs` (new), `packages/desktop/test/electron-harness.ts`, `packages/pty-host/test/real-claude-start.test.ts`, `.github/workflows/pod-ci.yml`, `packages/desktop/src/ci-workflow.test.ts`, `pod-docs/feature-details/terminal-host.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] a quit with no session asks nothing — packages/desktop/src/real-quit.test.ts › no session, no question`
  - `[test] Cancel keeps the app, the session, and the child's port — packages/desktop/src/real-quit.test.ts › cancel keeps everything`
  - `[test] confirm leaves no fake, no child, and no open port within 10 s, and the screen file holds the fake's output — packages/desktop/src/real-quit.test.ts › quit ends the session tree`
  - `[test] with a user scope, the env-cleared child ends too; else it skips with the reason — packages/desktop/src/real-quit.test.ts › scope`
  - `[test] a host kill ends the detached child within 10 s — packages/desktop/src/real-quit.test.ts › host crash leftovers`
  - `[test] after a main-process kill, the next start reads stopped · app closed, ends the leftover child, and starts nothing — packages/desktop/src/real-quit.test.ts › app crash leftovers`
  - `[test] Resume after a host kill starts --resume <id> with no prompt, and the old record and hook file go — packages/desktop/src/real-resume.test.ts › resume through the route`
  - `[test] after a restart the tab shows the saved screen and Resume, and a click makes it live — packages/desktop/src/real-resume.test.ts › resume from the tab`
  - `[test] no transcript reads can't resume, and the route answers 409 — packages/desktop/src/real-resume.test.ts › can't resume`
  - `[test] on Linux, SIGSTOP on the host shows the banner and SIGCONT hides it — packages/desktop/src/real-resume.test.ts › host banner`
  - `[test] with real claude, Resume brings back a word from the first turn — packages/pty-host/test/real-claude-start.test.ts › resume brings back the conversation`
  - `[test] both electron jobs run real-quit and real-resume, then real-resume packaged — packages/desktop/src/ci-workflow.test.ts › electron jobs`
- **Depends on:** H2, C2, S3, D2, W2, W3
- **One-way door:** none
- **Model:** opus
