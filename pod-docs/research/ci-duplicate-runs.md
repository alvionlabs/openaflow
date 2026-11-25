# Research: Avoiding duplicate GitHub Actions CI runs when promoting pod-staging to main

_Generated: 2026-11-22 · Depth: standard · Researchers: 1 · Searches: 2 · Pages read: 23_

**Assumptions:**
- Your repo is owned by a personal account or a GitHub Free/Team organization. You did not state the plan. Merge queue (item 5) turns on this.
- "Duplicate" means: the push run after a PR merges into `pod-staging`, plus the pull_request run on the staging PR into `main`. Both test the same code.
- Nobody pushes straight to `main`, so `main` stays an ancestor of `pod-staging`. See the caveat in item 6.
- Lines marked `(inference)` or `(own idea)` are mine, not from a page.

## What exists
| Name | Link | What it does | Alive? (last release · stars · users) | License | How close to the idea |
|------|------|--------------|---------------------------------------|---------|-----------------------|
| `on: push` limited to one branch + `pull_request` | [adamj.eu](https://adamj.eu/tech/2025/05/14/github-actions-avoid-simple-on/) | Limit `push` to `main` and keep `pull_request`. One run per PR instead of two. | n/a (pattern, 2025-05-14 post) | n/a | High. The same idea, applied to a different branch. |
| fkirc/skip-duplicate-actions | [repo](https://github.com/fkirc/skip-duplicate-actions) | Skips a run if a finished duplicate exists (`skip_after_successful_duplicate`, default true) or a same-content run is newer (`same_content_newer`). Also path skipping. | v5.3.2 (the page shows "19 Jul", no year) · 540 stars · latest commit 2026-11-07 | License file exists, type not read | Medium. It works, but it adds a dependency and a permission. |
| `concurrency` groups | [GitHub docs](https://docs.github.com/en/actions/using-jobs/using-concurrency) | One running run per group. `cancel-in-progress: true` cancels the running one. | built in | n/a | Low for this problem. See Gaps. |
| Merge queue (`merge_group`) | [GitHub docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | Tests each PR on a temporary branch with the PRs ahead of it. | built in | n/a | Low. Meant for busy branches with many PRs; plan limits unconfirmed. |
| Fast-forward / rebase promotion | [merge docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges) | Moves `main` to the tested commit. See item 6. | built in | n/a | Medium. It removes the new, untested merge commit. |

## Gaps and angles
- **1. Drop `push` on staging.** You lose the post-merge run on `pod-staging`. Pull_request runs test the merge result of the PR with its base at PR time (`GITHUB_SHA` is "the last merge commit on the merge branch"), so a PR that is later merged after the base moved can differ from what was tested. A pull_request run does not start if the PR has a merge conflict. — [events docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- **1. Drop `pull_request` for `main`.** The push run tests the head SHA, not a merge with `main`. The PR page lists checks from both push and pull_request runs for the same commit, so a push-run result shows on the staging PR. — [adamj.eu](https://adamj.eu/tech/2025/05/14/github-actions-avoid-simple-on/). You lose a run on the merge result with `main`. If `main` is an ancestor of `pod-staging`, that merge result has the same tree as the head `(inference)`. You also lose any run if the PR head was never pushed to a watched branch.
- **2. `concurrency` does not fix cross-event duplicates.** A group is a string; runs share a group only if the string is equal, and at most one runs at a time. The default replaces only a *pending* run; `cancel-in-progress: true` cancels the *running* one. The docs say `github.head_ref` exists only on `pull_request`. — [concurrency docs](https://docs.github.com/en/actions/using-jobs/using-concurrency). The default `github.ref` differs by event (`refs/heads/pod-staging` vs `refs/pull/N/merge`) `(inference; the concurrency page does not state it, the events page lists both refs)`. A shared group keyed on SHA would cancel one run and keep the other, but only if both overlap in time. If the first one already finished, the second one still runs `(inference)`. Docs do not address different events in one group.
- **3. skip-duplicate-actions.** It is maintained: the latest commit is 2026-11-07 ("do not path-skip when a commit's changed files are paginated") and there were commits in July 2026. — [commits](https://github.com/fkirc/skip-duplicate-actions/commits/master), [releases](https://github.com/fkirc/skip-duplicate-actions/releases). It compares same-workflow runs by tree hash; the page does not say it works across push vs pull_request. Test before you trust it. A pull_request run's tree is the merge ref, so for pod-staging → main it matches only when the merge ref has the same tree `(inference)`. It needs `actions: write` if the default token is read-only. — [README](https://github.com/fkirc/skip-duplicate-actions)
- **3. Path filters.** A workflow skipped by path or branch filter leaves its required checks "Pending" and blocks merging. — [GitHub docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks). The skip-duplicate README claims its approach works for required checks. Path filters do not detect "same code already passed" anyway `(inference)`.
- **4. Required checks.** A skipped workflow: checks stay "Pending" and block merging. A job skipped by `if`: reports "Success". A job skipped because a needed job failed may not block, so use `always()` with `needs`. — [GitHub docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks). Docs list success, skipped and neutral as passing. — [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches). You have no required checks today, so none of this bites now. It bites the day you add a required check. Then the safest layout is one always-running workflow with `if` on jobs, plus a final result job as the required check. (skip-duplicate README recommends that "Result" job for skipped matrix jobs.)
- **5. Merge queue.** The 2023 GA post says it is available on "private and public repos on the GitHub Enterprise Cloud plan" and public repos owned by organizations. — [changelog](https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/). It is enabled via "Require merge queue" in branch protection and needs a `merge_group` trigger, or required checks never report. It cannot be used with wildcard branch rules. — [managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue). Plan rule: no evidence found on a current GitHub docs page (fetched Managing a merge queue, Merging a PR with a merge queue, and GitHub's plans). Only the 2023 GA changelog, dated 2023-07-12 and possibly out of date, says private repos need Enterprise Cloud. Check your repo settings. It also adds a third run (`merge_group`), the opposite of your goal `(inference)`. It is built for many PRs racing into one branch. — [how it tests combined state](https://github.blog/news-insights/product-news/github-merge-queue-is-generally-available/)
- **6. Fast-forward promotion.** GitHub's PR "merge commit" always makes a merge commit (`--no-ff`). "Rebase and merge" always rewrites commits with new SHAs, so the tested SHAs are not the ones on `main`. Squash is fast-forward but collapses history. — [merge docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges). So the PR UI cannot fast-forward `main` to the exact tested SHA. A local `git push origin pod-staging:main` can `(inference)`. It needs a fast-forwardable `main`, so no merge commit ever lands on `main` first. If you promote with merge-commit PRs, `main` gets a merge commit `pod-staging` lacks, and the "main is ancestor" premise breaks on the next sprint. With a ff push, a `push: main` trigger would run on a SHA already tested; the safe choice is to not trigger on `main` at all.
- **7. CI after merge.** Pre-merge CI tests the PR with the base at that time. Two PRs that pass alone can break together. Merge queue exists to test the combined state before merge. — [GitHub blog](https://github.blog/news-insights/product-news/github-merge-queue-is-generally-available/). Without a queue, only a push run on the target branch finds it, after the merge. In your flow, the sprint PR is the only code entering `pod-staging` at sprint end, and the staging PR carries the same tree, so skew risk is low `(inference from your flow)`. Risk rises if task PRs also merge straight into `pod-staging` while others are open.

## Best practices
- Pick one event per gate: push for "what landed on branch X", pull_request for "will this PR be fine". — [adamj.eu](https://adamj.eu/tech/2025/05/14/github-actions-avoid-simple-on/)
- Keep skipped checks safe for required checks: skip at job level (`if`), not workflow level, and use a final aggregate job. — [GitHub docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks), [skip-duplicate README](https://github.com/fkirc/skip-duplicate-actions)
- Use `cancel-in-progress` for superseded commits on the same PR or branch, not for dedupe across events. — [concurrency docs](https://docs.github.com/en/actions/using-jobs/using-concurrency)
- If you adopt a merge queue, add `merge_group` to the workflow triggers. — [managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)

## Ideas to consider
- **Recommended: drop `push`, keep both `pull_request` gates.** Matches your kept decision (CI at sprint end into `pod-staging`, and on the staging PR into `main`). Exact lines:
  ```yaml
  on:
    pull_request:
      branches: [pod-staging, main]
  concurrency:
    group: pod-ci-${{ github.event.pull_request.number }}
    cancel-in-progress: true
  ```
  Gives up: no run after a merge into `pod-staging` (merge skew goes unseen until the next PR), no run on `main` after promotion. Still two runs per sprint (sprint PR, staging PR), but each has a clear purpose. Grows from item 1. (own idea, built on [adamj.eu](https://adamj.eu/tech/2025/05/14/github-actions-avoid-simple-on/))
- **Alternative: one gate, push on staging, PR into main reuses it.**
  ```yaml
  on:
    push:
      branches: [pod-staging]
    pull_request:
      branches: [pod-staging]   # only if you want pre-merge CI on the sprint PR
  ```
  Remove `main` from `pull_request`. The staging PR shows the push-run checks on the same head SHA. Gives up: a run on the merge with `main`, and pre-merge feedback if you also drop the second line. (own idea; relies on the PR-lists-push-run claim from adamj.eu)
- Add a `workflow_dispatch` trigger so you can re-run on demand when you skipped a gate. (own idea)
- Promote with `git push origin pod-staging:main` only after CI is green on that SHA, and add no `main` trigger. (own idea; item 6)
- Add skip-duplicate-actions only if you want to keep all triggers; first test whether it skips across push and pull_request. (own idea; item 3)

## Questions for the plan
- Which run do you trust as the release gate: the push run on the merged `pod-staging` tip, or the pull_request run on the staging PR? — why it matters: they test the same tree in your flow, so one can go — options: push-only for staging / pull_request-only (recommended) / keep both and add skip-duplicate-actions
- Will anyone push to `main` or `pod-staging` directly (hotfix)? — why it matters: it breaks the "main is an ancestor" premise and makes the merge-ref run differ from the head run — options: never (then drop the `main` PR run) / sometimes (keep a PR run on `main`)
- Merge-commit PR or ff push to promote? — why it matters: a merge commit puts a new untested SHA on `main`; ff keeps the tested SHA — options: merge-commit PR (simple, UI) / local ff push / rebase merge (new SHAs)
- Will you add required checks or a ruleset later? — why it matters: a skipped workflow leaves required checks pending; job-level skips pass — options: stay informational / required check via an always-run aggregate job
- What plan owns the repo? — why it matters: merge queue and some protection features depend on it; no current docs page found; only the 2023 post — options: personal or Free/Team (queue likely unavailable, per the 2023 post) / Enterprise Cloud org (available)
- Do task PRs ever merge straight into `pod-staging` between sprints? — why it matters: this is where merge skew appears — options: no (sprint PR only) / yes (keep a push run on `pod-staging`)

## Suspect pages
- none

## Sources
- GitHub Actions: concurrency — https://docs.github.com/en/actions/using-jobs/using-concurrency — fetched 2026-11-22
- Troubleshooting required status checks — https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks — 2026-11-22
- Managing a merge queue — https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue — 2026-11-22
- Events that trigger workflows — https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows — 2026-11-22
- About pull request merges — https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges — 2026-11-22
- About protected branches — https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches — 2026-11-22
- fkirc/skip-duplicate-actions — https://github.com/fkirc/skip-duplicate-actions — 2026-11-22
- skip-duplicate-actions releases — https://github.com/fkirc/skip-duplicate-actions/releases — 2026-11-22
- skip-duplicate-actions commits — https://github.com/fkirc/skip-duplicate-actions/commits/master — 2026-11-22
- GitHub Actions: avoid double runs from on: [push, pull_request] — https://adamj.eu/tech/2025/05/14/github-actions-avoid-simple-on/ — 2025-05-14
- GitHub merge queue is generally available — https://github.blog/news-insights/product-news/github-merge-queue-is-generally-available/ — 2026-11-22
- Merging a pull request with a merge queue — https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/merging-a-pull-request-with-a-merge-queue — 2026-11-22 (no plan statement)
- GitHub's plans — https://docs.github.com/en/get-started/learning-about-github/githubs-plans — 2026-11-22 (no plan statement)
- Pull request merge queue GA changelog — https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/ — 2023-07-12
- Available rules for rulesets — https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets — 2026-11-22
