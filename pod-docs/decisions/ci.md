# CI: what runs, when, and why

_Owner: the human · Last changed: 2026-11-20 · Index entries: [decisions.md, 2026-11-17](../decisions.md#2026-11-17--ci-once-per-sprint-not-per-wave-pr-human) and [decisions.md, 2026-11-20](../decisions.md#2026-11-20--ci-keeps-verify-and-electron-on-linux-and-windows-human)_

This file holds every CI decision in full, with the evidence. `decisions.md` keeps a short entry for each, linked here. Read this file before you propose a change to `.github/workflows/pod-ci.yml`.

## The rules today

| What | Rule |
|---|---|
| Workflow | `.github/workflows/pod-ci.yml` |
| Runs on | PRs into `pod-staging` or `main`, and a push to `pod-staging` |
| Doesn't run on | Wave PRs into a plan branch, fix PRs into a plan branch, or task branches |
| How often | About once per sprint: the sprint-end check, or the final plan PR in a plan's last sprint, then the staging PR into `main` |
| Jobs | `verify (ubuntu-latest)`, `verify (windows-latest)`, `electron (ubuntu-latest)`, `electron (windows-latest)` |
| Time | About 4 minutes of wall-clock time (the jobs run side by side), at most about 5.5 |
| Cost | Free: the repo is public |
| Before CI | Each engineer, the orchestrator's wave check, and the reviewer run `pnpm verify` and the `real-*` Electron tests on Linux |

## What each job does

| Job | Runs | Catches |
|---|---|---|
| `verify (<os>)` | `pnpm verify`, which runs `pnpm typecheck`, `pnpm test`, and `pnpm build`: a type check of every package, about 2,800 unit tests, and the build. On Windows it also runs the Windows-only tests that skip on Linux (`packages/pty-host/test/real-pty.test.ts`, and the real-jobs part of `packages/desktop/src/windows-jobs.test.ts`). | Logic and type errors, build breaks, and Windows terminal and job-object bugs |
| `electron (<os>)` | `pnpm build`, then each `real-*` test file one at a time: the real Electron app with a fake `claude` starts sessions, types, quits, crashes on purpose, resumes, and changes settings. Then `pnpm package --test-hooks`, and four of the files again on the packaged app. | Wiring, process, window, and timing bugs that no unit test sees |

`electron` doesn't run the unit tests, and `verify` never starts the app, so neither one replaces the other.

## Decision 1 — CI once per sprint, not per wave PR (2026-11-17, human)

**Decision:** wave PRs into the plan branch run no CI. They merge on the orchestrator's local wave check (`pnpm verify` and `pnpm test:electron` on Linux). CI on Linux and Windows runs on PRs into `pod-staging` or `main`, and on a push to `pod-staging`. At each sprint end, the orchestrator opens a draft PR from the plan branch into `pod-staging` (`ci: sprint <slug> check`) and closes it when green. A red run halts before the next sprint. In the last sprint, the final plan PR is that check. Engineers don't open `wip: … CI check` draft PRs.

**Why:**
- A wave is a piece of a feature, not a feature: two to five parts built side by side in one to two hours, often not wired together yet. For example, session-life wave 1 changed nothing a user could see. Only a sprint holds a real part of the feature, so a full CI run at the end of a sprint tests something the engineers' own tests didn't.
- The CI run on each wave, plus the engineers' draft CI rounds, cost about 10 minutes of waiting per wave. The minutes are free, so the waiting was the real cost.

**Sizes (plan terminal-host):**

| Unit | Holds | Time |
|---|---|---|
| Plan | One feature, 4 sprints | Days |
| Sprint | 2–3 waves | About 4–8 h |
| Wave | 2–5 parts | About 1–2 h |
| Part | One engineer | 10–30 min |

**Rejected:**

| Option | Why not |
|---|---|
| CI on every PR | Slow, and it tests pieces |
| Non-blocking CI per wave | Still tests pieces |
| CI only on risky waves, chosen with a `ci` label | One more rule to get right |
| Windows-only CI per wave | Saves runners, not time |
| A manual `workflow_dispatch` trigger | It works only once the workflow is on `main` |
| CI on every push | Wave PRs would run twice |
| A nightly scheduled run | GitHub schedules only from the default branch |

**Risk accepted:** a Windows bug shows only at the end of a sprint, mixed with up to three waves of changes. Revisit if that bites.

**For autopilot:** a wave PR with zero checks meets the "CI passed" rule because of this decision. The sprint-end check and the final plan PR still need passing checks.

## Decision 2 — keep `verify` and `electron` on Linux and Windows (2026-11-20, human)

**Decision:** keep all four jobs, with their names. Asked after a flaky Windows failure on staging PR #157, and after the question "are the verify jobs needed?"

**Why:**
- Almost every real bug that CI caught after the local checks had passed was on Windows, and both Windows jobs caught some (see [Evidence: our runs](#evidence-our-runs)).
- The Linux jobs catch little while the agents work on Linux, because every engineer runs `pnpm verify` and the `real-*` tests on Linux before CI. When the human works on Windows, Linux is the platform no one checks locally, and the Linux jobs cover it. They add no wall-clock time, because the jobs run side by side.
- The similar Electron apps do the same: unit tests and real-app tests on each platform they ship to (see [Evidence: similar projects](#evidence-similar-projects)).

**Rejected:**

| Option | Saves | Loses |
|---|---|---|
| Drop `verify (ubuntu)` | About 1 min of runner time, no wall-clock time | Linux unit tests on the days the human works on Windows |
| Drop both Linux jobs | About 3 min of runner time, no wall-clock time | Linux coverage on Windows days, and the packaged Linux app check |
| Drop `verify (windows)` | About 2.3 min of runner time, no wall-clock time | The Windows-only terminal and job-object tests (4 real catches) |
| Rename to `unit (<os>)` and `e2e (<os>)` | — | A change to `pod-ci.yml`, `ci-workflow.test.ts`, and any required check that names the jobs, for no new coverage (see [How other projects name jobs](#how-other-projects-name-jobs)) |

## Evidence: our runs

These are the job results of the 120 most recent finished `pod-ci` runs, from 2026-11-14 to 2026-11-20 (`gh run list --workflow pod-ci.yml`, then each run's jobs). The failure causes come from each failed job's log.

| Job | Median | Slowest | Runs | Failures | What they were |
|---|---|---|---|---|---|
| `verify (ubuntu)` | 60 s | 72 s | 53 | 3 | One Linux-only test (`install-check` › `processesUnder`, host-core P1). Two came from an engineer's unfinished `pod-ci.yml` change (terminal-tab E2), which also failed on Windows. |
| `electron (ubuntu)` | 117 s | 220 s | 49 | 1 | One session-life test bug (X2). |
| `verify (windows)` | 137 s | 171 s | 120 | 6 | Two real Windows terminal bugs in `real-pty`: a terminal that didn't pause under load (host-core H1) and no output reported (host-core wave 1). Two job-object races during the session-life and settings wave fixes. Two from the unfinished `pod-ci.yml` change. |
| `electron (windows)` | 232 s | 337 s | 49 | 10 | Each one a Windows process-ending bug at quit or after a crash: children left running (session-life wave 3 and its fix rounds), the job helper's start race, `error 87` when a program ended before its job (settings wave 1), and the crash-before-the-job race (PR #157). |

**Flaky test:** `real-quit › app crash leftovers` on Windows fails now and then. It is a real bug, not CI noise: if main crashes before the job helper's first assign, the leftovers aren't found. See [known-issues/real-quit-app-crash-flaky-on-windows.md](../known-issues/real-quit-app-crash-flaky-on-windows.md). Fixing it ends the false reds.

## Evidence: similar projects

From each project's `.github/workflows`, read 2026-11-20.

| Project | Unit tests on | Real-app tests on | When |
|---|---|---|---|
| VS Code | Linux, Windows (macOS turned off) | Electron integration and smoke tests, Linux and Windows | PRs to main run Linux only; the merge queue adds Windows |
| Signal Desktop | macOS, Linux, Windows | Electron tests and release tests, all three | Every PR and push |
| GitHub Desktop | macOS, Windows | Packaged E2E smoke tests, macOS and Windows | Every PR and push |
| Hyper (terminal) | macOS, Linux, Windows | E2E tests, all three | Every PR and push |
| node-pty (our pty library) | 6 runners: 3 OSes, x64 and ARM | — | Every PR |
| Tabby (terminal) | Linux only | None (builds on all three) | Every PR and push |
| Wave Terminal | None | None (builds and signs on all three) | Release builds only |
| **OpenAFlow** | **Linux, Windows** | **Electron, unpackaged and packaged, Linux and Windows** | **Once per sprint** |

**What this shows:**
- The common shape for an Electron app with native parts is unit tests plus real-app tests on each platform it ships to. Tabby and Wave, which skip real-app tests, are the exceptions.
- We ship no macOS build, so Linux and Windows is the full set.
- VS Code also keeps its Windows run out of each PR, much as we keep all CI for the end of a sprint.
- Most projects run CI on every PR. We run it less often, which is cheaper but finds bugs later (Decision 1).

## How other projects name jobs

| Project | Unit layer | Real-app layer | OS in the name |
|---|---|---|---|
| VS Code | `Electron-Unit`, `Electron (node.js)` | `Electron-Smoke (shard 1/3)`, `Agent-Host-E2E`, integration tests | Groups `Linux` and `Windows` |
| Signal Desktop | Step "Run node tests" | Steps "Run electron tests", "Run release tests" | One job per OS: `MacOS`, `Linux`, `Windows` |
| GitHub Desktop | Unit tests in the build job `<OS> <arch>` | `E2E Smoke <OS> <arch>` | OS and arch |
| Hyper | Step "Lint and Run Unit Tests" | Step "Run E2E Tests" | `build (<os>)` |
| node-pty | `Build & Test (<os>)` | — | OS in brackets |
| **OpenAFlow** | **`verify (<os>)`** | **`electron (<os>)`** | **OS in brackets** |

The common words are **unit** for the fast layer and **e2e**, **smoke**, or **integration** for the real-app layer, with the OS in the name. Our `verify` is named after the `pnpm verify` script it runs, and `electron` names the real app it drives. We keep both names (Decision 2).

## When to look at this again

Re-open these decisions only if one of these happens:
- A macOS build ships. Then add macOS to both jobs.
- CI minutes stop being free.
- A Linux job goes a whole plan without a catch while the human works on Windows.
- A Windows bug found at sprint end costs more than the waiting that Decision 1 saves.

## History

- 2026-11-14 — CI gains the `electron` jobs on Linux and Windows (plan terminal-host, host-core).
- 2026-11-17 — Decision 1: CI once per sprint (PR #152).
- 2026-11-20 — Decision 2: keep all four jobs and their names. This file is created, and the two `decisions.md` entries link here.
