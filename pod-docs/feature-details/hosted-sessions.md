# Hosted sessions

## What it is

A hosted session is an interactive `claude` that the app starts in the desktop's terminal host. The server keeps a record of each one, puts it on the Board as `repo.hosted`, and has two routes: New session and Dismiss. The shapes are in [the sprint's shared contract](../sprints/terminal-tab.md) (§2, §3, §5). The terminal host is in [terminal-host.md](terminal-host.md); main's side of the link is in [desktop.md](desktop.md) (Server terminal link); the rows and words the page shows are in [runs-and-pipeline.md](runs-and-pipeline.md).

## How it works

- **Terminal channel** (`terminal-channel.ts`). Only a server that the desktop's main process started has one: `linkParent` gives it when `OPENAFLOW_TERMINALS=1` and the process has a real `parentPort`. Dev and `pnpm start` have none. The server sends `start {req, spec}`, `list {req}`, and `dispose {id}`. Main answers each `start` and `list` once. It also sends `exit {id, exitCode}` once per session and `lost {ids}` at each host crash. The channel gives every `started`, `start-failed`, `exit`, and `lost` to its listeners before the request that waits on it settles, so the store is current when a route goes on. A `start` or `list` with no answer in 30 s rejects (`NoAnswer`: `terminals unavailable` for a start, `no answer` for a list). A late answer still reaches the listeners. A bad message of type `openaflow:terminal` logs one line, `openaflow: terminal channel ignored a bad message: <reason>`, that never holds the message. Ids the store doesn't hold are ignored.
- **Session store** (`session-store.ts`, `<config dir>/sessions.json`). Memory changes at once; the file is written whole to a temp file, then renamed, one write at a time. Only a server with a channel writes it. A server with no channel reads it again when its size or time changes, so a dev server shows what the desktop's server wrote. A missing file is empty. A file that doesn't parse is empty with one log line, and it stays as it is until the next real change. A record that breaks a rule (a marker that isn't a UUID v4, an unknown state) is left out. A failed write logs one line and keeps the change in memory.
- **Transitions.** Saved as `starting` before `start` goes out. `started` → `live` with its `pid`. `start-failed` → the record goes. `exit` → `ended` with `exitCode` and `endedAt`. `lost` → `stopped · terminals restarted` with `endedAt`. Dismiss → the record goes. `ended` and `stopped` never change. Each change rebuilds the Board.
- **Reconcile** at each start with a channel, after the bind, never awaited: `list`. Listed and live → `live` (with the listed `pid`); listed and not live → `ended` with no `exitCode`; not listed → `stopped · app closed` with no `endedAt`. Only the `starting` and `live` records there were when it asked, and only while they keep that state: a New session or an `exit` during the wait keeps its own state. `list-failed terminals unavailable` → `stopped · terminals restarted`. Any other failure, or no answer, asks once more 30 s later, then changes nothing.
- **Board.** Each repo's records (matched by `sameRepoPath`), oldest first, as `HostedSession`: with the hook file `<config dir>/hooks/<marker>.jsonl`, read with `readHookState` and cached by size and time. `hooked`: a `SessionStart` line exists. `prompted`: a `UserPromptSubmit` line exists. `sessions`: the start id, then every other `SessionStart` id once. `liveSession`: the newest `SessionStart` id, else the start id. No `pid` and no text. A repo whose folder is gone still lists its sessions. The watcher watches `sessions.json` and the `hooks` folder (through the config folder until the plugin makes it).
- **`POST /api/actions/new-session {repoId, skill, text, cols?, rows?}`.** Errors, first match: `400 bad request` (shape; `cols` 2–500, `rows` 1–200, default 120 × 30); `409 no terminal host` (no channel, or no `OPENAFLOW_HOOKS_PLUGIN`); `404 not a repo`; `409 claude not found` (the tool finder's `claude`); `409 session starting` (this repo has a `starting` record); `409 too many sessions` (10 `starting` or `live` in all); `400 <sessionCommand word>`; `502 start failed: <host word>`; `504 terminals unavailable`. Both ids come from `crypto.randomUUID()`. The spec is `sessionCommand`'s, with the tool finder's env. `200 {outcome:'started', marker, logged, typeYourself?}`: `typeYourself` is only in the answer; the record keeps `typeYourself: true`. Refusals before the start change nothing and aren't logged. A start logs one `new-session` entry (`started`, or `failed` with the host's word or `no answer`), rebuilds the Board, then answers.
- **`POST /api/actions/dismiss-session {repoId, marker}`.** Errors: `400 bad request`; `409 no terminal host`; `404 no session` (not this repo's record, also a repeat); `409 session is live` (`starting` or `live`). It removes the record, deletes the hook file (a missing file is fine), sends `dispose`, logs one `dismiss-session` entry, rebuilds, then answers `200 {outcome:'dismissed', logged}`.
- **Log targets:** `<skill command or plain> · <marker first 8>`, never the text.

## Why it's this way

- **Only a real `parentPort` turns the channel on:** every `OPENAFLOW_*` reaches a resumed `claude -p`, so the env alone would turn it on in a process main never answers.
- **The reconcile never blocks the start:** main forks the terminal host only after the server's first ready.
- **The reconcile leaves records that changed during its wait:** a `list` can wait up to 20 s for the host, and a New session in that time is unlisted but new.
- **No text on disk or the Board:** the start line holds what the user typed. Only the start itself carries it.

## Watch out

- A `504` leaves the record `starting`, so that repo answers `409 session starting` until a late answer or the next start's reconcile. Its log entry reads `failed` (`no answer`) even if a late `started` makes it live.
- A record whose repo leaves the Board still counts toward the 10, and nothing can dismiss it until the repo is back.
- `stopped · app closed` has no `endedAt`: the server doesn't know when the app closed.
- Tests start sessions only with a fake `claude` behind `OPENAFLOW_CLAUDE_BIN`. Never the real `claude` with `~/.claude`.

## History

- 2026-11-15 · terminal-tab S1 · added: the session store, the terminal channel, the reconcile, the New session and Dismiss routes, `hosted` on the Board, the watch on hook files, and the two action log kinds.
