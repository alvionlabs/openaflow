# real-quit's app crash test fails now and then on Windows CI

Severity: medium
Status: open · found 2026-11-15 · seen again on PR #157 (run 44643647866)

**Who it affects:** anyone reading Windows CI. Users too: a Windows app crash in the first ~0.5 s of a session can leave the session's child processes running.

**What you see:** `e2e (windows-latest)` fails (called `electron (windows-latest)` before 2026-11-19, so older logs use that name) `real-quit › app crash leftovers` with `timed out waiting for the leftover child ended`. `desktop.log` has no `session … in a job` line for that session. The same commit can pass in the next run.

**How to reproduce:** not on demand. It is a timing race: the test crashes the app before the Windows job helper's first assign lands (0.4–0.5 s after a session starts).

**Cause:** a known gap, queued as "before hosting" (queue 2026-11-15, settings W1-fix). When main crashes before the session is in a job, the next start's sweep has only the session id, with no pid or start time, so it can't find the leftovers.

**Workaround:** rerun the failed job once. A pass on the rerun with this exact failure means the race, not a new break. Any other `real-quit` failure is not this issue.

**Fix idea:** store each session's pid and start time on its record, and have the sweep in `start-server.ts` and `terminal-channel.ts` end leftovers by them when the session has no job.

**Evidence:** PR #157's pull_request run failed it, while the push run on the same commit (`610f97c`) passed. Details: [decisions/ci.md](../decisions/ci.md).
