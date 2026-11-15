# Sprint: Terminal tab

_From plan: pod-docs/plans/terminal-host.md · Slug: terminal-tab · Status: active · Generated: 2026-11-14_
<!-- autopilot-run: started=2026-11-14T23:07:20Z sprints=1 waves=4 -->

## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | M1 | Model: hosted sessions on the Board, the join, row states, skill labels | terminal-tab-M1 | — | pending | — | — |
| 1 | D1 | Main ↔ server terminal link, per-session exit, starter clean-up | terminal-tab-D1 | — | pending | — | — |
| 1 | X1 | Real `claude` proofs in a separate signed-in config folder | terminal-tab-X1 | — | pending | — | — |
| 1 | L1 | Look: terminal theme from tokens, the Start with listbox, xterm deps | terminal-tab-L1 | — | pending | — | — |
| 1 | F1 | Web terminal link: bridge, port client, open-tab request | terminal-tab-F1 | — | pending | — | — |
| 2 | S1 | Server: session store, terminal channel, New session and Dismiss routes, Board | terminal-tab-S1 | — | pending | — | M1, D1 |
| 2 | R1 | No `-p` send to a hosted session | terminal-tab-R1 | — | pending | — | M1 |
| 2 | N1 | New session form, ⋯ New session, Open terminal on the Next step card | terminal-tab-N1 | — | pending | — | M1, L1, F1 |
| 3 | T1 | Terminal tab: xterm view, stop bar, Dismiss, browser rule | terminal-tab-T1 | — | pending | — | M1, L1, F1, S1, N1 |
| 3 | E2 | Electron product-path checks, the `cmd.exe` route on Windows, CI, docs | terminal-tab-E2 | — | pending | — | D1, S1 |

## Shared contract

**0. Split with session-life.** Here: New session, the Terminal tab, the states `starting`, `live`, `waiting`, `ended`, `stopped · terminals restarted`, `stopped · app closed`, and **Dismiss** (which also deletes the hook file, queue 2026-11-14 "nothing deletes the hook state files"). Not here: **Resume**, `can't resume`, saved screens (the last screen once the host no longer holds it), quit, tree kills, leftovers, the heartbeat banner, updates. No slice draws a Resume button.

**1. Machine notes (every slice).** As host-core §1: Fedora, no Windows machine (Windows proof is a green `windows-latest` job on the wave PR); pnpm 11.1.2 from `<scratchpad>/pnpm/node_modules/.bin`; Electron binary via `node node_modules/electron/install.js` in `packages/desktop`; `DISPLAY=:0`, no `xvfb`; always temp `OPENAFLOW_CONFIG_DIR`, `OPENAFLOW_PORTS_DIR`, `OPENAFLOW_CLAUDE_DIR`, `OPENAFLOW_DESKTOP_DATA_DIR`. Ports by board order (i = 0 for M1 … 9 for E2): API `8400 + 10i`, web `8401 + 10i`. Engineers start sessions only with a fake `claude` behind `OPENAFLOW_CLAUDE_BIN`; only X1 runs real `claude`, and never with `~/.claude`. UI checks: `pnpm build`, then `pnpm desktop` with the smoke recipe's temp folders; 375 px means the window resized to 375 px wide.

**2. Main ↔ server terminal messages.** Over the server's existing parent channel (`process.parentPort`). Every message is `{ type: 'openaflow:terminal', op, ... }`; anything else on that type is ignored with one log line.
```ts
// server → main
{ op: 'start', req: number, spec: StartSpec } | { op: 'list', req: number } | { op: 'dispose', id: string }
// main → server
{ op: 'started', req, id, pid } | { op: 'start-failed', req, id, error: string }
| { op: 'list', req, sessions: SessionInfo[] } | { op: 'list-failed', req, error: string }
| { op: 'exit', id, exitCode: number } | { op: 'lost', ids: string[] }
```
- `StartSpec`, `SessionInfo`: `@openaflow/pty-host/protocol` (host-core §4). `req` is a positive integer, unique per server process.
- Main answers each `start` and `list` once. A start before the host is ready waits (the starter's queue); after `failed` it answers `start-failed` `terminals unavailable`; a host crash during a start answers `start-failed` `terminal host exited`.
- `exit` goes once per session; `lost` on each host crash, with the live ids. A message for a server process that is gone is dropped; the next server's `list` covers it.
- Main sets two env vars on the server: `OPENAFLOW_TERMINALS=1` and `OPENAFLOW_HOOKS_PLUGIN=<absolute hooks plugin dir>` (`hooksPluginDir`). A server without `OPENAFLOW_TERMINALS=1` (dev, `pnpm start`) has no terminal channel.

**3. Session store** (`<config dir>/sessions.json`, written only by a server with a terminal channel; written whole to a temp file, then renamed).
```ts
type SessionsFile = { v: 1; sessions: StoredSession[] }
type StoredSession = {
  marker: string; repoPath: string; sessionId: string; skill: SkillId; startedAt: number
  state: 'starting' | 'live' | 'ended' | 'stopped'
  pid?: number; endedAt?: number; exitCode?: number
  stopReason?: 'terminals restarted' | 'app closed'   // only with state 'stopped'
  typeYourself?: true                                  // the start line went to the user, never stored as text
}
```
- A missing file is empty. A file that doesn't parse reads as empty with one log line and is not overwritten until the next real change.
- Transitions: saved as `starting` before `start` is sent; `started` → `live` with `pid`; `start-failed` → record removed; `exit` → `ended` with `exitCode`, `endedAt`; `lost` → `stopped · terminals restarted`; Dismiss → record removed.
- Reconcile, at each start of a server with a channel, after it is listening and never blocking the start (the host forks only after the server's first ready): send `list`; listed and live → `live`; listed and not live → `ended` (no `exitCode`); not listed and `starting` or `live` → `stopped · app closed`. `ended` and `stopped` records never change. `list-failed terminals unavailable` (the host failed for good) → every `starting` or `live` record is `stopped · terminals restarted`; any other failure or no answer retries once 30 s later, then changes nothing. A server with no channel never writes the file.
- A start with no `started` or `start-failed` in 30 s: the route answers 504; the record stays `starting` until an answer or the next reconcile.
- Hook state per record: `<config dir>/hooks/<marker>.jsonl`, read with `readHookState`, cached by size and modified time.

**4. Board and model.**
```ts
type HostedSession = {
  marker: string; sessionId: string; liveSession: string; sessions: string[]; skill: SkillId; startedAt: number
  state: StoredSession['state']; stopReason?: StoredSession['stopReason']; endedAt?: number; exitCode?: number
  hooked: boolean      // a SessionStart line exists
  prompted: boolean    // a UserPromptSubmit line exists
  typeYourself?: true
}
// BoardRepo gains: hosted?: HostedSession[]   (oldest first; absent when none)
// ActionEntry gains: { action: 'new-session'; result: 'started' | 'failed' } | { action: 'dismiss-session'; result: 'dismissed' | 'failed' }
//   target: '<skill command or plain> · <marker first 8>' (never the text)
```
- `liveSession`: the newest `SessionStart`'s session, else `sessionId`. `sessions`: `sessionId` first, then every other `SessionStart` session, once each.
- **Hosted** means listed in `repo.hosted` (any state). `isHostedSession(repo, id)`: `id` is in some `sessions`.
- **Join** (each session on exactly one row of its repo): the plan or one-off run whose `runAgents` holds an agent with `session` in the session's `sessions`; with several, the run of the newest such agent `lastAt`, then run order. None → the repo row. A repo with an unjoined session gets its repo row (`plan` undefined) even when it has runs; one repo row at most.
- **Shown session** of a row: the newest `starting` or `live` by `startedAt`, else the newest.
- **View** of a session at `now`: `starting` → `starting`; `live`, `hooked` false and `now − startedAt ≥ 10_000` → `waiting`; `live` → `live`; `ended`; `stopped`. Words: `Starting`, `Live`, `Waiting for you`, `Ended · Claude exited` (plus ` with code N` when N ≠ 0), `Stopped · app closed`, `Stopped · terminals restarted`. Dots: run, run, you, idle, idle.
- **Row state**: on a repo row from its shown session: `starting`/`live` → `running`, where `session · no plan yet`; `waiting` → `needs-you`, where `session · waiting for you`; `ended` → `idle`, `session ended`; `stopped` → `idle`, `session stopped`. On a plan or one-off run: a shown `waiting` session raises `idle` or `running` to `needs-you`; nothing else changes.
- **Skills**: `SKILLS` gains `label` and `line`: Plan · "Interview, then write a plan." / Ship an idea · "Research, plan, and build in one go." / One task · "One change, one engineer, one PR." / Research · "Look into a question and write a report." / Park an idea · "Save an idea for later." / Plain session · "Claude with no prompt."

**5. Routes** (under `/api/actions/`, behind the existing guard and token).
- `POST /new-session {repoId, skill, text, cols?, rows?}` → `200 {outcome:'started', marker, logged, typeYourself?: string}`. Errors, first match: `400 {error:'bad request'}` (shape; `cols` 2–500, `rows` 1–200, default 120 × 30); `409 no terminal host`; `404 not a repo`; `409 claude not found`; `409 session starting` (this repo has a `starting` record); `409 too many sessions` (10 `starting` or `live` in all); `400 {error:<sessionCommand word>}`; `502 {error:'start failed: <host error>'}`; `504 terminals unavailable`. Logs one `new-session` entry (`started` or `failed`), then rebuilds the Board before it answers.
- `POST /dismiss-session {repoId, marker}` → `200 {outcome:'dismissed', logged}`. Errors: `400 bad request`; `409 no terminal host`; `404 no session` (not in this repo's records, also a repeat); `409 session is live` (`starting` or `live`). Removes the record, deletes the hook file (missing is fine), sends `dispose`, logs, rebuilds.
- `POST /resume` with a hosted session → `409 {error:'hosted session'}` (§6).

**6. No `-p` send to a hosted session.** The resume route, the automatic check (`autoSends`), and `runResume` each refuse a session for which `isHostedSession` is true, for `continue` and `go`, in any state. The automatic check skips it with no log entry and no `lastFailed`; `runResume` logs one `resume` entry, `failed`, message `hosted session`. After Dismiss the session is no longer hosted, and today's rules apply. So on a run whose shown session is `ended` or `stopped`, the reply card says to dismiss the stopped terminal first (N1).

**7. Web side.**
- `terminalBridge(win)` (desktop-bridge.ts): `{ connect(): Promise<void>, onHostState(fn) }` from `window.openaflow.connectTerminals` and `onTerminalHost`, else `undefined`. **Browser rule:** no bridge → no Terminal tab, no New session form, no ⋯ New session; a hosted session still shows its view word and line, with "Open the desktop app to use the terminal." in place of buttons.
- `createTerminalLink(bridge, win)`: takes the port from a `window` message `{type:'openaflow:terminal-port'}` whose `source` is `win`; `open(id, {cols, rows}, handlers)` sends `resize` then `attach`; `replay` is written with no ack; each `data` is acked with its length after the write callback; `input`, `resize`, `close` (= `detach`); on `restarted` it connects again and re-opens each open id; `error no session` → `handlers.gone()`; `failed` → `handlers.unavailable()`.
- `requestTab('terminal')` / `onTabRequest(fn)` (open-tab.ts): a `window` CustomEvent `openaflow:open-tab`. The run screen opens the named tab on it.
- After a started New session: wait until `repo.hosted` lists the marker (at most 10 s), then go to `#/<repoId>` and `requestTab('terminal')`. A new session joins no run yet, so it sits on the repo row.

**8. Look.** No new tokens. Terminal: background `--surface`, text `--fg`, cursor `--focus`, selection `--border-strong`, font `--mono` 13 px; ANSI colors stay xterm's defaults. Light and dark follow the page's theme. "Start with" is a listbox button (label, slash command, one muted line per option; Plain session after a divider). Stop bar: status dot, stop word, one muted line, **Dismiss**.

**9. Electron checks and CI.** New `real-*` files gate as host-core §7. A fake `claude` is a Node script the test sets up in a temp folder and names in `OPENAFLOW_CLAUDE_BIN` (the desktop passes env through to the production server, whose tool finder takes that absolute path only): on Linux a copy named `claude` with a `#!/usr/bin/env node` first line and mode 0755; on Windows a `claude.cmd` in the npm shim form `shimTarget` reads, so `sessionCommand` runs it as `node` plus the script. It echoes input as `got:<line>`, prints its args, and appends a `SessionStart` line for its `--session-id` to `$OPENAFLOW_HOOKS_DIR/$OPENAFLOW_RUN.jsonl`, as the plugin would. Each test sets up its own. E2 adds `real-session` and `real-terminal-tab` steps (unpackaged, then `real-session` packaged) to both `electron` jobs; T1 creates `real-terminal-tab.test.ts` in the same wave.

## Per-slice detail

### M1: Model: hosted sessions, join, row states, skill labels
- **Scope:** §4 in `@openaflow/model`: the `HostedSession` type and `BoardRepo.hosted`, the two action kinds, `hosted.ts` (`isHostedSession`, the join, shown session, view and words), `listRuns` row states and the repo row, skill `label` and `line`. Pure; no I/O. Keep every existing runs and state-agreement test green; add hosted cases to the agreement file. Update `runs-and-pipeline.md` (the repo row with a session).
- **Files owned:** `packages/model/src/board.ts`, `packages/model/src/actions.ts`, `packages/model/src/hosted.ts` (new), `packages/model/src/hosted.test.ts` (new), `packages/model/src/runs.ts`, `packages/model/src/runs.test.ts`, `packages/model/src/skills.ts`, `packages/model/test/skills.test.ts`, `packages/model/src/replies.ts` (export `runAgents` only), `packages/model/src/index.ts`, `packages/web/src/screens/runs/run-state-agreement.test.ts`, `pod-docs/feature-details/runs-and-pipeline.md`
- **Success criteria:**
  - `[test] a session joins the run whose agent holds its start id; after /clear its new id still joins that run — packages/model/src/hosted.test.ts › join follows every id the session held`
  - `[test] two runs hold its ids: the newest agent wins; none, even beside a new plan doc with no agent yet: the repo row — packages/model/src/hosted.test.ts › join edges`
  - `[test] the shown session is the newest starting or live, else the newest — packages/model/src/hosted.test.ts › shown session`
  - `[test] live and unhooked reads waiting at 10 s, live at 9.999 s; hooked reads live — packages/model/src/hosted.test.ts › waiting after 10 s`
  - `[test] each state's word and dot, exit code 0 and 3 — packages/model/src/hosted.test.ts › words`
  - `[test] isHostedSession is true for every held id in any state — packages/model/src/hosted.test.ts › hosted ids`
  - `[test] an unjoined session adds one repo row beside a plan run, with §4's where and state — packages/model/src/runs.test.ts › a repo row for an unjoined session`
  - `[test] a waiting session raises a plan run to needs-you; a blocked run stays blocked — packages/model/src/runs.test.ts › waiting on a run`
  - `[test] no hosted field reads as today — packages/model/src/runs.test.ts › no hosted sessions`
  - `[test] each skill has its label and line in order — packages/model/test/skills.test.ts › labels and lines`
  - `[test] a hosted waiting session reads needs-you in the sidebar and the card — packages/web/src/screens/runs/run-state-agreement.test.ts › hosted sessions`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### D1: Main ↔ server terminal link
- **Scope:** §2's main side: a plain `terminal-relay.ts` (no `electron`) between the server host and the starter; `server-host.ts` gains `send(m)` and `onMessage(fn)` for the current process; the starter gains a per-session `exit` event and `dispose(id)`, and uses `protocol.ts` types in place of its local `ListAnswer` and `SessionInfo`; delete the dead `createPtyHostClient` and its test (queue 2026-11-15, S1's note); `server-launch.ts` sets §2's env. No kill from the server. Update `desktop.md`.
- **Files owned:** `packages/desktop/src/terminal-relay.ts` (new), `packages/desktop/src/terminal-relay.test.ts` (new), `packages/desktop/src/server-host.ts`, `packages/desktop/src/server-host.test.ts`, `packages/desktop/src/host-main.ts`, `packages/desktop/src/server-launch.ts`, `packages/desktop/src/server-launch.test.ts`, `packages/desktop/src/pty-host-starter.ts`, `packages/desktop/src/pty-host-starter.test.ts`, `packages/desktop/src/pty-host-launch.ts`, `packages/desktop/src/pty-host-launch.test.ts`, `packages/desktop/src/shell-main.ts`, `packages/desktop/src/test-hooks-main.ts`, `pod-docs/feature-details/desktop.md`
- **Success criteria:**
  - `[test] a start answers started with the pid, or start-failed with the host's word — packages/desktop/src/terminal-relay.test.ts › start answers once`
  - `[test] a start before ready goes through at ready; after failed it answers terminals unavailable — packages/desktop/src/terminal-relay.test.ts › start timing`
  - `[test] a host crash during a start answers terminal host exited, and sends lost with the live ids — packages/desktop/src/terminal-relay.test.ts › host crash`
  - `[test] each session exit reaches the server once — packages/desktop/src/terminal-relay.test.ts › exit once`
  - `[test] bad shapes and unknown ops change nothing and log one line — packages/desktop/src/terminal-relay.test.ts › bad messages`
  - `[test] after a server restart, messages go to the new process only — packages/desktop/src/server-host.test.ts › send and onMessage follow the current process`
  - `[test] the server env has OPENAFLOW_TERMINALS=1 and the plugin dir, dev and packaged — packages/desktop/src/server-launch.test.ts › terminal env`
  - `[test] dispose posts dispose; the exit event fires once per id — packages/desktop/src/pty-host-starter.test.ts › dispose and exit events`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### X1: Real `claude` proofs in a separate config folder
- **Scope:** Queue 2026-11-15 A1 entries (the hooks that never fired; real runs writing to `~/.claude`). Change `real-claude-start.test.ts` to run only with `OPENAFLOW_REAL_CLAUDE=1` and `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR`, an absolute folder the human signed in to once; it sets `CLAUDE_CONFIG_DIR` to it and refuses `~/.claude` and the caller's own `CLAUDE_CONFIG_DIR`. The test never reads, copies, or links a login file. Unset: skip with a printed reason. Add proofs: no `SessionStart` line while the trust prompt shows; in a trusted folder the first `SessionStart` comes within 10 s (§4's wait; log the time); one Bash tool call under `permissions.defaultMode: "default"` (in the scratch repo's settings, never a flag) fires `PreToolUse`, then `PermissionRequest`, and the test denies it with Escape. Haiku, at most 4 turns. If the folder is missing here, file a `PENDING → human` with the sign-in steps; don't fall back to `~/.claude`. Update the Proved where rows of `terminal-host.md`.
- **Files owned:** `packages/pty-host/test/real-claude-start.test.ts`, `packages/pty-host/test/fixtures/proof-skill/`, `pod-docs/feature-details/terminal-host.md`
- **Success criteria:**
  - `[test] with no config folder set, or with ~/.claude, it skips and starts nothing — packages/pty-host/test/real-claude-start.test.ts › refuses the real config folder`
  - `[test] the trust prompt shows with no SessionStart line yet — packages/pty-host/test/real-claude-start.test.ts › no SessionStart before the trust answer`
  - `[test] in a trusted folder SessionStart comes within 10 s — packages/pty-host/test/real-claude-start.test.ts › SessionStart within the waiting time`
  - `[test] a Bash call fires PreToolUse, then PermissionRequest, and nothing runs after the deny — packages/pty-host/test/real-claude-start.test.ts › tool hooks fire`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### L1: Look: terminal theme, Start with listbox, xterm deps
- **Scope:** §8. Add `@xterm/xterm` 6.0.0 (same major as `@xterm/headless`) and its matching `@xterm/addon-fit`, pinned exact, to `packages/web`; add their notices (override text only if they ship no licence file). `terminal-theme.ts`: tokens → xterm theme and font, read from the page's computed style, for light and dark. `Listbox.tsx` plus pure `listbox.ts` (open, close, arrow keys, Home, End, Enter, Escape, typeahead, the divider skipped) and `listbox.css`, from tokens only. No screen uses them yet (N1, T1).
- **Files owned:** `packages/web/package.json`, `pnpm-lock.yaml`, `packages/web/src/theme/terminal-theme.ts` (new), `packages/web/src/theme/terminal-theme.test.ts` (new), `packages/web/src/components/Listbox.tsx` (new), `packages/web/src/components/listbox.ts` (new), `packages/web/src/components/listbox.test.ts` (new), `packages/web/src/components/listbox.css` (new), `packages/desktop/src/licence-notices.ts`, `packages/desktop/src/licence-notices.test.ts`
- **Success criteria:**
  - `[test] the theme takes --surface, --fg, --focus, --border-strong, and --mono at 13 px, in light and dark — packages/web/src/theme/terminal-theme.test.ts › theme from tokens`
  - `[test] text on the terminal and on the selection reaches 4.5:1, the cursor 3:1, in both themes — packages/web/src/theme/terminal-theme.test.ts › contrast`
  - `[test] keys move, wrap, skip the divider, pick, and close; Escape keeps the old pick — packages/web/src/components/listbox.test.ts › keyboard`
  - `[test] listbox.css uses only theme tokens and no status color as text — packages/web/src/components/listbox.test.ts › tokens only`
  - `[test] the notices name @xterm/xterm and its fit addon — packages/desktop/src/licence-notices.test.ts › the notices name the web terminal`
- **Depends on:** —
- **One-way door:** none
- **Model:** opus

### F1: Web terminal link
- **Scope:** §7's `terminalBridge`, `createTerminalLink`, and `requestTab`/`onTabRequest`. Plain `.ts`, tested with a fake bridge and a fake port; no xterm, no screen change.
- **Files owned:** `packages/web/src/desktop-bridge.ts`, `packages/web/src/desktop-bridge.test.ts`, `packages/web/src/terminal-link.ts` (new), `packages/web/src/terminal-link.test.ts` (new), `packages/web/src/open-tab.ts` (new), `packages/web/src/open-tab.test.ts` (new)
- **Success criteria:**
  - `[test] no window.openaflow, or no connectTerminals, gives undefined — packages/web/src/desktop-bridge.test.ts › terminal bridge`
  - `[test] open sends resize, then attach — packages/web/src/terminal-link.test.ts › resize before attach`
  - `[test] data is acked with its length after the write; replay never — packages/web/src/terminal-link.test.ts › acks`
  - `[test] a port message from another source is ignored — packages/web/src/terminal-link.test.ts › port source`
  - `[test] restarted connects again and re-opens each open id; no session calls gone — packages/web/src/terminal-link.test.ts › host restart`
  - `[test] close sends detach and no more data reaches the handlers — packages/web/src/terminal-link.test.ts › close`
  - `[test] a rejected connect (terminals unavailable, forbidden) calls unavailable, also for a page that loads after the host failed — packages/web/src/terminal-link.test.ts › connect refused`
  - `[test] a request reaches each listener once; an unknown tab is ignored — packages/web/src/open-tab.test.ts › tab requests`
- **Depends on:** —
- **One-way door:** none
- **Model:** sonnet

### S1: Server: store, channel, routes, Board
- **Scope:** §3, §5's two new routes, and §2's server side (`terminal-channel.ts` on the channel `parent-link.ts` exposes). `sessionCommand` gets production's found `claude` and `OPENAFLOW_HOOKS_PLUGIN`; both UUIDs come from `crypto.randomUUID()`; `typeYourself` goes in the answer only. The Board gets `hosted` from the store and hook files; the watcher also watches `<config dir>/hooks/`; the action log reads the two new kinds. Write `pod-docs/feature-details/hosted-sessions.md`.
- **Files owned:** `packages/server/src/session-store.ts` (new), `packages/server/src/session-store.test.ts` (new), `packages/server/src/terminal-channel.ts` (new), `packages/server/src/terminal-channel.test.ts` (new), `packages/server/src/session-routes.ts` (new), `packages/server/src/session-routes.test.ts` (new), `packages/server/src/parent-link.ts`, `packages/server/src/parent-link.test.ts`, `packages/server/src/start-server.ts`, `packages/server/src/start-server.test.ts`, `packages/server/src/board-service.ts`, `packages/server/src/board-service.test.ts`, `packages/server/src/watcher.ts`, `packages/server/src/watcher.test.ts`, `packages/server/src/action-log.ts`, `packages/server/src/action-log.test.ts`, `pod-docs/feature-details/hosted-sessions.md` (new), `pod-docs/feature-details/server.md`
- **Success criteria:**
  - `[test] a start saves starting first, then live with the pid; a refused start removes the record — packages/server/src/session-store.test.ts › start transitions`
  - `[test] exit gives ended with its code; lost gives stopped · terminals restarted; ended and stopped never change — packages/server/src/session-store.test.ts › exit and lost`
  - `[test] reconcile: listed live stays live, listed exited is ended, unlisted is stopped · app closed; terminals unavailable stops starting and live; another failure retries once, then changes nothing — packages/server/src/session-store.test.ts › reconcile`
  - `[test] the server listens before the reconcile answers — packages/server/src/start-server.test.ts › reconcile never blocks the start`
  - `[test] a broken sessions.json reads empty with one log line and is not overwritten by the read — packages/server/src/session-store.test.ts › unreadable file`
  - `[test] a server with no channel never writes sessions.json and still serves its records — packages/server/src/session-store.test.ts › read-only without a channel`
  - `[test] no answer in 30 s rejects terminals unavailable; a late started still makes the record live — packages/server/src/terminal-channel.test.ts › answer limit`
  - `[test] each §5 new-session error, in order — packages/server/src/session-routes.test.ts › new-session errors`
  - `[test] a started session sends the exact sessionCommand spec, logs no text, and the Board lists it before the answer — packages/server/src/session-routes.test.ts › new-session starts`
  - `[test] a second start in the same repo while one is starting gives session starting; the 11th live gives too many sessions — packages/server/src/session-routes.test.ts › repeats and the cap`
  - `[test] dismiss removes the record and the hook file and sends dispose; live refuses; a repeat gives no session — packages/server/src/session-routes.test.ts › dismiss`
  - `[test] no token gives 403 on both routes — packages/server/src/session-routes.test.ts › guarded`
  - `[test] hosted carries liveSession, sessions, hooked, prompted from the hook file, and no prompt text — packages/server/src/board-service.test.ts › hosted sessions`
  - `[test] a new hook line rebuilds the Board — packages/server/src/watcher.test.ts › hook files`
  - `[test] new-session and dismiss-session entries survive a restart — packages/server/src/action-log.test.ts › session entries`
- **Depends on:** M1, D1
- **One-way door:** none
- **Model:** opus

### R1: No `-p` send to a hosted session
- **Scope:** §6 in the model's `autoSends`, the server's `runResume`, and the resume route. `runResume` refuses before the runner starts, with result `failed` and message `hosted session`. Update `resume.md`. The header's Auto-continue button stays; on a hosted run it sends nothing.
- **Files owned:** `packages/model/src/auto-continue.ts`, `packages/model/src/auto-continue.test.ts`, `packages/server/src/auto-continue.ts`, `packages/server/src/auto-continue.test.ts`, `packages/server/src/resume-routes.ts`, `packages/server/src/resume-routes.test.ts`, `pod-docs/feature-details/resume.md`
- **Success criteria:**
  - `[test] a toggled run whose session is hosted, live or stopped, gets no send — packages/model/src/auto-continue.test.ts › hosted sessions get no automatic send`
  - `[test] after /clear the new id is refused too — packages/model/src/auto-continue.test.ts › every held id`
  - `[test] /resume with continue or go on a hosted session gives 409 hosted session and starts nothing — packages/server/src/resume-routes.test.ts › hosted session`
  - `[test] runResume never calls the runner for a hosted session and logs one failed entry — packages/server/src/auto-continue.test.ts › runResume refuses a hosted session`
  - `[test] the check skips it with no log entry and no lastFailed — packages/server/src/auto-continue.test.ts › the check skips hosted sessions quietly`
  - `[test] after Dismiss the same session is sent again by today's rules — packages/server/src/auto-continue.test.ts › dismissed is not hosted`
- **Depends on:** M1
- **One-way door:** none
- **Model:** opus

### N1: New session form and Open terminal
- **Scope:** In the desktop app (bridge present): a repo row's Next step card (title "No active plan", detail "Pick what to start, then describe it.") holds the New session form: "Start with" (L1 listbox, default Plan), a text field ("What to build"; "Message (optional)" for Plain session; 2,000 characters max), and a primary **New session**. The ⋯ menu gets **New session**, opening the same form in a modal; pass `newSession` from `RunsScreen.tsx` (that line only). A row's shown session in `waiting` gets the card "Claude waits for you in the terminal" / "It may ask you to trust this folder or to sign in. The app never answers for you." with **Open terminal** (tier as a pending entry: no toast). A hosted run's reply card keeps its title and swaps Continue, Copy, and Run it yourself for **Open terminal** (`requestTab`): with the shown session `starting`, `live` or `waiting` it reads "Open the terminal and type `<word>`."; with it `ended` or `stopped` it reads "This run's terminal has stopped. Dismiss it in the Terminal tab, then Continue works as before." (§6). `typeYourself` shows "Type `<line>` in the terminal." until the next Board shows `prompted`. Browser build: the card reads "Open the desktop app to start a session." and no form or ⋯ item. Busy: the button reads "Starting…" and is off. `bad text` goes under the field; other errors in the alert box. Action log words for the two new kinds. No `/pod:ship` warning (the line says what it does).
- **Files owned:** `packages/web/src/screens/runs/next-step.ts`, `packages/web/src/screens/runs/next-step.test.ts`, `packages/web/src/screens/runs/NextStepCard.tsx`, `packages/web/src/screens/runs/next-step.css`, `packages/web/src/screens/runs/NewSessionForm.tsx` (new), `packages/web/src/screens/runs/NewSessionDialog.tsx` (new), `packages/web/src/screens/runs/new-session-flow.ts` (new), `packages/web/src/screens/runs/new-session-flow.test.ts` (new), `packages/web/src/screens/runs/new-session.css` (new), `packages/web/src/screens/runs/BarMenu.tsx`, `packages/web/src/screens/runs/bar-menu.test.ts`, `packages/web/src/screens/runs/RunsScreen.tsx`, `packages/web/src/screens/runs/reply-view.ts`, `packages/web/src/screens/runs/reply-view.test.ts`, `packages/web/src/screens/runs/action-log-view.ts`, `packages/web/src/screens/runs/action-log-view.test.ts`, `packages/web/src/actions-client.ts`, `packages/web/src/actions-client.test.ts`, `packages/web/src/screens/runs/run-state-agreement.test.ts`, `packages/web/src/screens/runs/runs-screen.test.ts`, `packages/web/src/screens/runs/elsewhere.test.ts`, `packages/desktop/src/attention.test.ts`, `pod-docs/feature-details/runs-and-pipeline.md`
- **Success criteria:**
  - `[test] a repo row with no live session gets the start card; with a live one it doesn't — packages/web/src/screens/runs/next-step.test.ts › start card`
  - `[test] a hosted run whose session ended or stopped says to dismiss first, never to type the word — packages/web/src/screens/runs/next-step.test.ts › stopped hosted reply`
  - `[test] the start and waiting cards raise no toast and no urgent banner — packages/desktop/src/attention.test.ts › hosted cards send no toast`
  - `[test] a waiting session gives the Open terminal card at the pending tier — packages/web/src/screens/runs/next-step.test.ts › waiting card`
  - `[test] a hosted run's sendable reply becomes Open terminal with the typed word; an outside run keeps Continue — packages/web/src/screens/runs/next-step.test.ts › hosted reply`
  - `[test] the flow posts skill and text once, stays busy, then waits for the marker and goes to the repo row's Terminal tab — packages/web/src/screens/runs/new-session-flow.test.ts › start`
  - `[test] a marker not on the Board in 10 s still ends busy, with no move — packages/web/src/screens/runs/new-session-flow.test.ts › marker never shows`
  - `[test] bad text is a field error; 409, 502, 504 and a network failure go to the box; a retry is allowed — packages/web/src/screens/runs/new-session-flow.test.ts › errors`
  - `[test] typeYourself shows until prompted — packages/web/src/screens/runs/new-session-flow.test.ts › type it yourself`
  - `[test] ⋯ shows New session only with the bridge — packages/web/src/screens/runs/bar-menu.test.ts › New session item`
  - `[test] new-session and dismiss-session rows read in words, with no text — packages/web/src/screens/runs/action-log-view.test.ts › session actions`
  - `[manual] the form matches the draft's section 2 at desktop width and at 375 px, light and dark — pnpm desktop, a repo with no plan`
  - `[manual] the open listbox shows label, command and line, with Plain session after the divider, at desktop width and 375 px — pnpm desktop`
  - `[manual] the ⋯ New session modal looks like the card's form, light and dark — pnpm desktop, a repo with a plan run`
- **Depends on:** M1, L1, F1
- **One-way door:** none
- **Model:** opus

### T1: Terminal tab
- **Scope:** In `RunsScreen.tsx`: a **Terminal** tab after Waiting and Log, only in the desktop app and only on a row with a hosted session; closed until opened; a run dot on the tab while the shown session is `starting`, `live` or `waiting`; opens on `onTabRequest('terminal')`. A stored `terminal` on a row with no session, or in the browser, reads closed. `TerminalView.tsx`: xterm with L1's theme and fit, F1's link, resize on container change, input to the port, detach on unmount or row change. `starting`/`live`/`waiting`: the live terminal. `ended`/`stopped`: the stop bar (dot, §4 word, "The terminal ended at HH:MM.", **Dismiss**) over the replayed buffer, faded, while the host still holds it, else the bar alone. Dismiss posts §5 and keeps focus sane. Browser build: under the card, the session's dot, word, line and "Open the desktop app to use the terminal.". Gone or unavailable: "This terminal is not available." Electron check of the tab with a fake `claude` (§9). **Human check** (named in the wave PR, not a criterion): in `pnpm desktop` on Linux, New session with `/pod:plan` and real `claude` in a folder `claude` never trusted reads `Waiting for you`, then `Live` after the human answers in the terminal.
- **Files owned:** `packages/web/src/screens/runs/RunsScreen.tsx`, `packages/web/src/screens/runs/runs-screen.test.ts`, `packages/web/src/screens/runs/tab-panels.test.ts`, `packages/web/src/screens/runs/tab-memory.ts`, `packages/web/src/screens/runs/tab-memory.test.ts`, `packages/web/src/screens/runs/view.ts`, `packages/web/src/screens/runs/view.test.ts`, `packages/web/src/screens/runs/tabs.css`, `packages/web/src/screens/runs/TerminalTab.tsx` (new), `packages/web/src/screens/runs/TerminalView.tsx` (new), `packages/web/src/screens/runs/terminal-tab.ts` (new), `packages/web/src/screens/runs/terminal-tab.test.ts` (new), `packages/web/src/screens/runs/dismiss-flow.ts` (new), `packages/web/src/screens/runs/dismiss-flow.test.ts` (new), `packages/web/src/screens/runs/terminal.css` (new), `packages/web/src/actions-client.ts`, `packages/web/src/actions-client.test.ts`, `packages/desktop/src/real-terminal-tab.test.ts` (new), `packages/desktop/test/fixtures/tab-claude.mjs` (new), `pod-docs/feature-details/runs-and-pipeline.md`
- **Success criteria:**
  - `[test] the tab shows only with a bridge and a hosted session; a stored terminal elsewhere reads closed — packages/web/src/screens/runs/tab-memory.test.ts › terminal tab`
  - `[test] the tab dot shows for starting, live and waiting only — packages/web/src/screens/runs/terminal-tab.test.ts › tab dot`
  - `[test] ended and stopped give the stop bar with Dismiss and no Resume; live gives the terminal — packages/web/src/screens/runs/terminal-tab.test.ts › stop bar`
  - `[test] the browser view gives the word, line and the desktop note, with no button — packages/web/src/screens/runs/terminal-tab.test.ts › browser rule`
  - `[test] Dismiss posts once, 409 session is live shows the box, and a 404 counts as gone — packages/web/src/screens/runs/dismiss-flow.test.ts › dismiss`
  - `[test] the screen lists Terminal after Waiting and Log — packages/web/src/screens/runs/tab-panels.test.ts › tab order`
  - `[test] in Electron, New session opens the Terminal tab, typed text echoes in xterm, and a reload replays it once — packages/desktop/src/real-terminal-tab.test.ts › the tab shows a live session`
  - `[test] in Electron, the fake's exit shows Ended · Claude exited, and Dismiss removes the tab — packages/desktop/src/real-terminal-tab.test.ts › ended and dismissed`
  - `[test] in Electron, the Start with listbox picks Plain session by keys, and ⋯ New session opens the modal with focus in the text field — packages/desktop/src/real-terminal-tab.test.ts › the form by keys`
  - `[manual] the tab, the terminal and the stop bar match the draft's sections 1 and 3 at desktop width and 375 px, light and dark — pnpm desktop`
- **Depends on:** M1, L1, F1, S1, N1
- **One-way door:** none
- **Model:** opus

### E2: Electron product-path checks, CI, docs
- **Scope:** `real-session.test.ts` through the harness with the fake `claude` (`fake-session-claude.mjs`, §9): start by the route; the Board reads `live`, then `hooked`; a server kill keeps the session live and the Board comes back with it `live`; a host kill gives `stopped · terminals restarted`; an app restart on the same folders gives `stopped · app closed` and starts nothing; dismiss frees it. On Windows also: a readable npm shim runs through node; an unreadable `.cmd` goes through `cmd.exe`, gets `--session-id` and `--plugin-dir` and no prompt, and the answer has `typeYourself` (queue 2026-11-15 cmd.exe entry). The harness gains an option to reuse a given temp folder, for the restart. Add the CI steps of §9. Update `terminal-host.md` (Proved where) and `codebase-structure.md` (Parts, How they connect, Smoke recipe: New session with a fake `claude`).
- **Files owned:** `packages/desktop/src/real-session.test.ts` (new), `packages/desktop/test/fixtures/fake-session-claude.mjs` (new), `packages/desktop/test/electron-harness.ts`, `.github/workflows/pod-ci.yml`, `packages/desktop/src/ci-workflow.test.ts`, `pod-docs/feature-details/terminal-host.md`, `pod-docs/codebase-structure.md`
- **Success criteria:**
  - `[test] a route start reads live, then hooked, with the spec's args — packages/desktop/src/real-session.test.ts › a new session through the product path`
  - `[test] a server kill keeps it live and the Board comes back — packages/desktop/src/real-session.test.ts › server crash`
  - `[test] a host kill reads stopped · terminals restarted — packages/desktop/src/real-session.test.ts › host crash`
  - `[test] a restart reads stopped · app closed and starts nothing — packages/desktop/src/real-session.test.ts › app restart`
  - `[test] on Windows the cmd.exe route starts with no prompt and answers typeYourself; the npm shim runs through node — packages/desktop/src/real-session.test.ts › windows shims`
  - `[test] both electron jobs run real-session and real-terminal-tab, then real-session packaged — packages/desktop/src/ci-workflow.test.ts › electron jobs`
- **Depends on:** D1, S1
- **One-way door:** none
- **Model:** opus
