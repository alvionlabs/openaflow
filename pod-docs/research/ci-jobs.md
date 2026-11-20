# CI jobs: are `verify` and `electron` worth it?

_Researched: 2026-11-20 · Asked by: the human, after a flaky Windows failure on staging PR #157 · Decision: [decisions.md, 2026-11-20](../decisions.md#2026-11-20--ci-keeps-verify-and-electron-on-linux-and-windows-human)_

**Answer:** yes. Keep all four jobs: `verify` and `electron`, each on Linux and Windows. Our CI does what the similar Electron apps do, and almost every real bug that CI caught after the local checks had passed was a Windows bug.

## What each job does

| Job | Runs | Catches |
|---|---|---|
| `verify (<os>)` | `pnpm verify`: type check, about 2,800 unit tests, and the build. On Windows it also runs the Windows-only tests that skip on Linux (`packages/pty-host/test/real-pty.test.ts`, the real-jobs part of `windows-jobs.test.ts`). | Logic and type errors, build breaks, and Windows terminal and job-object bugs |
| `electron (<os>)` | `pnpm build`, then each `real-*` test file (the real Electron app with a fake `claude`), then `pnpm package --test-hooks` and four files again on the packaged app | Wiring, process, window, and timing bugs that no unit test sees |

`electron` doesn't run the unit tests, and `verify` never starts the app, so neither one replaces the other.

## Our numbers

These are the job results of the 120 most recent finished `pod-ci` runs, from 2026-11-14 to 2026-11-20. The failure causes come from each failed job's log.

| Job | Median | Slowest | Failures | What they were |
|---|---|---|---|---|
| verify (ubuntu) | 60 s | 72 s | 3 | One Linux-only test (`install-check`, host-core P1). Two came from an engineer's unfinished CI file. |
| electron (ubuntu) | 117 s | 220 s | 1 | One session-life test bug (X2). |
| verify (windows) | 137 s | 171 s | 6 | Two real Windows terminal bugs (`real-pty`, host-core H1 and wave 1), two job-object races during wave fixes, and two from the unfinished CI file. |
| electron (windows) | 232 s | 337 s | 10 | Each one a Windows process-ending bug at quit or after a crash: children left running (session-life wave 3), the job helper's start race, `error 87` (settings wave 1), and the crash-before-the-job race (PR #157). |

- **Wall clock:** the jobs run side by side, so a run takes about 4 minutes, at most about 5.5.
- **Cost:** the repo is public, so the minutes are free. CI runs once per sprint ([2026-11-17](../decisions.md#2026-11-17--ci-once-per-sprint-not-per-wave-pr-human)).
- **Why the Linux jobs stay:** they catch little while the agents work on Linux, because every engineer runs `pnpm verify` and the `real-*` tests on Linux before CI. When the human works on Windows, Linux is the platform no one checks locally. The Linux jobs also add no wall-clock time.
- **Flaky:** `real-quit › app crash leftovers` on Windows fails now and then. It is a real bug (queue, "before hosting": main crashes before the job helper's first assign), not CI noise. Fixing it ends the false reds.

## What similar projects do

From each project's `.github/workflows`, read 2026-11-20.

| Project | Unit tests on | Real-app tests on | When |
|---|---|---|---|
| VS Code | Linux, Windows (macOS turned off) | Electron integration and smoke tests, Linux and Windows | PRs to main run Linux only; the merge queue adds Windows |
| Signal Desktop | macOS, Linux, Windows | Electron tests and release tests, all three | Every PR and push |
| GitHub Desktop | macOS, Windows | Packaged E2E smoke tests, macOS and Windows | Every PR and push |
| Hyper (terminal) | macOS, Linux, Windows | E2E tests, all three | Every PR and push |
| node-pty (our pty library) | 6 runners: 3 OSes, x64 and ARM | — | Every PR |
| Tabby (terminal) | Linux only | none (builds on all three) | Every PR and push |
| Wave Terminal | none | none (builds and signs on all three) | Release builds only |
| **OpenAFlow** | **Linux, Windows** | **Electron, unpackaged and packaged, Linux and Windows** | **Once per sprint** |

The common shape for an Electron app with native parts is unit tests plus real-app tests on each platform it ships to. Tabby and Wave, which skip real-app tests, are the exceptions. We ship no macOS build, so Linux and Windows is the full set. VS Code also keeps its Windows run out of every PR, much as we keep all CI for the end of a sprint.

## How they name the jobs

| Project | Unit layer | Real-app layer | Per-OS naming |
|---|---|---|---|
| VS Code | `Electron-Unit`, `Electron (node.js)` | `Electron-Smoke (shard 1/3)`, `Agent-Host-E2E`, integration tests | Groups `Linux` and `Windows` |
| Signal Desktop | "Run node tests" | "Run electron tests", "Run release tests" | One job per OS: `MacOS`, `Linux`, `Windows` |
| GitHub Desktop | the unit tests in the build job (`<OS> <arch>`) | `E2E Smoke <OS> <arch>` | OS and arch in the name |
| Hyper | "Lint and Run Unit Tests" | "Run E2E Tests" | `build (<os>)` |
| node-pty | `Build & Test (<os>)` | — | OS in brackets |
| OpenAFlow | `verify (<os>)` | `electron (<os>)` | OS in brackets |

The common words are **unit** for the fast layer and **e2e**, **smoke**, or **integration** for the real-app layer, with the OS in the name. Our `verify` matches the `pnpm verify` script it runs, and `electron` names the real app it drives. To match the others more closely, the names would be `unit (<os>)` and `e2e (<os>)`.

**Kept as they are.** A rename costs a change to `pod-ci.yml`, `ci-workflow.test.ts`, and any required check that names the jobs (the workflow's comment notes that `verify (windows-latest)` keeps its name for that reason), and it adds no coverage.

## Options considered

| Option | Saves | Loses | Verdict |
|---|---|---|---|
| Keep all four (chosen) | — | — | Chosen |
| Drop `verify (ubuntu)` | About 1 min of runner time, no wall-clock time | Linux unit tests on the days the human works on Windows | Rejected |
| Drop both Linux jobs | About 3 min of runner time, no wall-clock time | Linux coverage on Windows days, and the packaged Linux app check | Rejected |
| Drop `verify (windows)` | About 2.3 min of runner time, no wall-clock time | The Windows-only terminal and job-object tests (4 real catches) | Rejected |
| Rename to `unit` and `e2e` | — | Churn in the workflow, its test, and the required checks | Rejected for now |
