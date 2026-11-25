# Research: Default workflow for OpenAFlow (ship claude-pod, pinned, editable later)

_Generated: 2026-11-22 · Depth: standard · Researchers: 3 · Searches: 15 · Pages read: 32_

**Assumptions:**
- claude-pod is a normal Claude Code plugin (`.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/`).
- OpenAFlow starts `claude` in a pty. It can set flags and env vars per session.
- "Build time" means the electron-builder release build.
- This report merges three angles: existing, gaps, building. The `alternatives` and `risks` angles were not run. Legal and platform-rule risks are only covered where the three parts touched them.
- No part found a conflict between angles. Where a part could not verify a point, the point says so.

## What exists
| Name | Link | What it does | Alive? (last release · stars · users) | License | How close to the idea |
|------|------|--------------|---------------------------------------|---------|-----------------------|
| Claude Code `--plugin-dir` / `CLAUDE_CODE_PLUGIN_DIRS` / `--plugin-url` | [cli-reference](https://code.claude.com/docs/en/plugins/cli-reference.md), [loading](https://code.claude.com/docs/en/plugins/loading.md) | Loads a plugin from a directory, a `.zip` (extracted to temp), or a folder of plugins, for one session. `--plugin-url` fetches a `.zip`. Loaded in place, never copied. Id is `<name>@inline`. Replaces a same-named installed plugin. | Official docs, current | no evidence found | Very close: the per-session load path for the bundled workflow |
| Claude Code marketplace plugins (pin by `version`, git `sha`, `sha256`) | [loading](https://code.claude.com/docs/en/plugins/loading.md), [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md) | Installs to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. Manifest `version` pins; else the 12-char commit SHA is the version. Sources `github`, `url`, `git-subdir` take `ref` and 40-char `sha`. `archive` takes an HTTPS zip URL plus `sha256`. `npm` takes `package`, `version`, `registry`. | Official docs | no evidence found | Close: a built-in pin and update model; an alternative to bundling |
| Claude Code plugin manifest (`userConfig`, `${CLAUDE_PLUGIN_DATA}`, `engines`) | [plugins-reference](https://code.claude.com/docs/en/plugins-reference) | Plugin settings, a data dir kept across updates, a Claude Code version range. `claude plugin validate` checks the manifest. | Official docs | `license` field takes an SPDX id | Close: the plugin-side seam for host settings |
| electron-builder `extraResources` | [electron-builder](https://www.electron.build/docs/contents) | Copies a folder (`from`, `to`, `filter`) into `resources/`, outside `app.asar`. Read through `process.resourcesPath`. | Docs current | not verified | The bundling mechanism |
| Git submodule | [Pro Git](https://git-scm.com/book/en/v2/Git-Tools-Submodules) | Gitlink pins one commit SHA. A plain clone leaves it empty until `git submodule update --init`. | Mature | not verified | Close for pinning; adds a clone step |
| npm git dependency | [npm docs](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#git-urls-as-dependencies) | `git+https://...#<commit-ish>` or `#semver:<range>`. Runs `build`/`prepare`/`install` scripts if present. | Mature | not verified | Works; adds install-time behavior |
| GitHub release asset digests | [GitHub changelog](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/) | GitHub computes a SHA-256 per release asset. Shown in UI, REST, GraphQL, `gh`. | Current (2025-06-03) | n/a | Makes "download tag and verify SHA-256" cheap |
| Copier `update` | [Copier updating](https://copier.readthedocs.io/en/latest/updating/), [configuring](https://copier.readthedocs.io/en/stable/configuring/) | Regenerates old and new template output and merges with local edits. Needs git tags and `.copier-answers.yml`. Conflicts become inline markers or `.rej`. `_migrations` run on update. | Docs current | not verified | Partial: a model for update-after-edit |
| Terraform `TF_DATA_DIR` | [Terraform env vars](https://developer.hashicorp.com/terraform/cli/config/environment-variables) | Env var that replaces the per-directory data folder (default `.terraform`). | Official docs, current | no evidence found | Partial: the env-var model for renaming a state folder |
| `CLAUDE_CONFIG_DIR` | [claude-directory](https://code.claude.com/docs/en/claude-directory) | Env var that moves every `~/.claude` path and `.claude.json`. | Official docs, current | no evidence found | Partial: user folder only, not the project folder |
| Git `GIT_DIR`, Cargo `CARGO_HOME` | [git](https://git-scm.com/docs/git#_git_commits), [Cargo](https://doc.rust-lang.org/cargo/reference/environment-variables.html) | `GIT_DIR` replaces `.git` and turns off the upward search. `CARGO_HOME` overrides `$HOME/.cargo`; config keys have env forms. | Official docs | not verified | Partial: more env-var-over-default models |

## Gaps and angles

### Q1 Pin and bundle a tool from another repo
- A submodule pins a SHA (detached HEAD), not a tag. It does not auto-update. A clone needs `--recurse-submodules`. URL changes need hand edits to `.gitmodules`. — [Gotchas for Submodules](https://t4d-gmbh.github.io/git-and-science/slides/content/submodules/gotchas.html), [Pro Git](https://git-scm.com/book/en/v2/Git-Tools-Submodules)
- Risk (inference, no failure story fetched): a CI or contributor clone without `--recurse-submodules` builds an app with no workflow. See the "fail the build" idea below.
- npm git URLs run install scripts. Claude Code's own `npm` marketplace source forbids github.com tarball links and git addresses as `package`. That limit applies to Claude Code's fetch, not to your build script. — [npm docs](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#git-urls-as-dependencies), [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md)
- The GitHub post does not say whether old release assets have a digest. A build script should not depend on the API field alone. — [GitHub changelog](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/)
- No published reference script for "download tag, verify hash, feed `extraResources`" was found.
- `--plugin-dir` loads in place. Components outside the plugin root (`..`, escaping symlinks) are rejected with `path escapes plugin directory`. A plugin inside an asar, or one with symlinks outside, would break. — [loading](https://code.claude.com/docs/en/plugins/loading), [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- Auto-install of plugin dependencies accepts registry packages from an npm lockfile only. Git, folder, workspace deps get no install. No lifecycle scripts. 60 s timeout. yarn/pnpm lockfiles are skipped. For `--plugin-dir`: no evidence found. — [loading](https://code.claude.com/docs/en/plugins/loading)
- `CLAUDE_PLUGIN_ROOT` points at the bundled folder in the install dir. That folder may be read-only. An AppImage read-only mount: not verified. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference), [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Marketplace cache is keyed by version string. Issue #32983: content changed with the same version, `/plugin update` did nothing. Closed as a duplicate of #29074, no fix shown. Bump the version. — [loading](https://code.claude.com/docs/en/plugins/loading), [GitHub #32983](https://github.com/anthropics/claude-code/issues/32983)
- Old version directories are deleted 14 days after an update. This does not affect `--plugin-dir`. — [loading](https://code.claude.com/docs/en/plugins/loading)

### Plugin name and same-name collisions
- `claude plugin validate` raises an error for names starting with `claude-`. `claude plugin init` and `tag` refuse the name. Claude Code "still installs and loads" such a plugin. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- A `--plugin-dir` plugin replaces an installed plugin of the same name for the session. The marketplace row still shows enabled in `claude plugin list`. Only `--debug` logs record the override. If names differ, both load. — [loading](https://code.claude.com/docs/en/plugins/loading), [cli-reference](https://code.claude.com/docs/en/plugins/cli-reference.md)
- Escape hatch: `"<name>@inline": false` in settings stops the session plugin from shadowing. Managed settings can lock the name, so the installed copy loads. — [loading](https://code.claude.com/docs/en/plugins/loading), [cli-reference](https://code.claude.com/docs/en/plugins/cli-reference.md)
- Issue #35423 asked whether marketplace plus `--plugin-dir` dedupes or loads both. A bot closed it as a duplicate of #32619. No maintainer comment. Verify on the pinned Claude Code version. — [GitHub #35423](https://github.com/anthropics/claude-code/issues/35423)
- If two enabled plugins share a manifest name from different marketplaces, only one registers its `hooks/hooks.json`. — [loading](https://code.claude.com/docs/en/plugins/loading)
- An administrator can reject `--plugin-dir`, `--plugin-url` and `CLAUDE_CODE_PLUGIN_DIRS` with the managed `disableSideloadFlags` setting. Claude Code prints a message and exits 1 without starting. — [cli-reference](https://code.claude.com/docs/en/plugins/cli-reference.md)
- `claude plugin list` shows session-only plugins only when the flag comes before the subcommand. — [cli-reference](https://code.claude.com/docs/en/plugins/cli-reference.md)
- A plugin's root `CLAUDE.md` is not loaded as context. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)

### Q2 Editable default plus updates
- No documented per-file "host overrides plugin file" layer exists. A same-named plugin replaces the whole plugin. — [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Failure mode: shipped files and user files in one folder. Notepad++ users lost custom themes on update when the "Don't use %AppData%" option put theme files in the install dir. — [Notepad++ thread](https://community.notepad-plus-plus.org/post/87779)
- A read-only bundle plus a user layer avoids the overwrite. But updates never reach a user who copied and edited. No stale-copy failure story was fetched.
- Copier needs git and an answers file in the user's project. — [Copier updating](https://copier.readthedocs.io/en/stable/updating/)
- `${CLAUDE_PLUGIN_ROOT}` changes per version. State must not go there. `${CLAUDE_PLUGIN_DATA}` persists across updates. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_OPTION_<KEY>` go to hooks and MCP/LSP servers. They are not in the Bash tool, the main session or subagents. Skill and agent Markdown gets `${CLAUDE_PLUGIN_ROOT}` substituted inline. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)

### Q3 Rename the state folder
- No way was found in Claude Code to rename a project state folder. `CLAUDE_CONFIG_DIR` moves the `~/.claude` tree and `.claude.json`. The page does not say it moves the project `.claude/` folder. Project settings cannot set it. It takes an absolute path. — [claude-directory](https://code.claude.com/docs/en/claude-directory), [env-vars](https://code.claude.com/docs/en/env-vars.md) (first 100000 characters read)
- `CLAUDE_CODE_PLUGIN_CACHE_DIR` moves the plugins root. — [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Terraform: the data-folder variable must be set the same for every command, from `init` on. — [Terraform env vars](https://developer.hashicorp.com/terraform/cli/config/environment-variables)
- devsy: a PR moved only `ConfigDir` from `~/.devsy` to `~/.config/devsy` and left data, state and cache. After upgrade every workspace failed with "provider "docker" is not initialized". The fix was a revert. — [devsy PR #598](https://github.com/devsy-org/devsy/pull/598)
- No CLI tool was found that documents old-name handling.
- `userConfig` supports a `directory`-type option with a `default`. Whether it works under `--plugin-dir`, or whether a host can preset it: no evidence found. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)

## Best practices
- Bundle as a plain folder via `extraResources`, not in asar. Claude Code is a separate process (inference: it cannot read asar). Resolve with `process.resourcesPath` when packaged and a repo path in dev. — [electron-builder](https://www.electron.build/docs/contents)
- Prefer per-session `--plugin-dir` over a marketplace install: no settings write, no stale cache. Pass `claude --plugin-dir <path>`. — [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Pin by tag and by content hash. Claude Code checks out `sha` when `ref` and `sha` are both set. `archive` with `sha256` refuses a mismatch. Use the same idea in your build script. — [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md)
- Build script shape: read `{repo, tag, sha256}` from one committed file, download, hash, compare, unpack, point `extraResources.from` at it. A bump is a visible diff. — [GitHub changelog](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/), [electron-builder](https://www.electron.build/docs/contents)
- In a submodule setup, CI must use `--recurse-submodules` or `git submodule update --init`. — [Pro Git](https://git-scm.com/book/en/v2/Git-Tools-Submodules)
- Set the manifest `version` on each tagged release. Without it every commit is a new version. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference), [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Run `claude plugin validate <dir> --strict` in CI. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- Never write into `${CLAUDE_PLUGIN_ROOT}`. Persist state in `${CLAUDE_PLUGIN_DATA}` or the project. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- Keep the bundled workflow out of user-editable folders. Keep user edits in a separate layer. — [Notepad++ thread](https://community.notepad-plus-plus.org/post/87779)
- Rename a state folder with one env var that the host sets on every command (`TF_DATA_DIR`), over a default, with an explicit override above that (`GIT_DIR`, `CARGO_HOME`). — [Terraform env vars](https://developer.hashicorp.com/terraform/cli/config/environment-variables), [git](https://git-scm.com/docs/git#_git_commits), [Cargo](https://doc.rust-lang.org/cargo/reference/environment-variables.html)
- Move a renamed folder as a whole. Read the old location when the new one is empty. Write a release note. — [devsy PR #598](https://github.com/devsy-org/devsy/pull/598)
- Copier model for update-after-edit: template in git with tags, stored answers, regenerate old versus new and merge, `check-update`, `recopy` as reset, never hand-edit the answers file. `_migrations` run only on update, in order, `before`/`after`: a pattern for a one-time folder rename. — [Copier updating](https://copier.readthedocs.io/en/latest/updating/), [Copier configuring](https://copier.readthedocs.io/en/stable/configuring/)

## Ideas to consider
All ideas below are proposals from the researchers, not facts. "Grows from" shows the evidence behind each.
- One resolver function for the plugin path. A later user workflow folder then changes one function. — grows from [loading](https://code.claude.com/docs/en/plugins/loading.md), [electron-builder](https://www.electron.build/docs/contents) (the seam is an own idea)
- Seam as an ordered list of plugin dirs. A user "replace" is a folder with the same manifest name. — grows from [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Editable default = read-only bundled plugin plus a user override plugin, no copy. Reset = stop passing the user folder. — (own idea) from [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Committed lock file (`workflow.lock.json`: repo, tag, sha, sha256) and a `bump-workflow <tag>` script. — grows from [GitHub changelog](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/) (own idea)
- Build fails if the bundled plugin dir is empty. — grows from [gotchas](https://t4d-gmbh.github.io/git-and-science/slides/content/submodules/gotchas.html) (own idea)
- CI: validate the bundled dir `--strict` and check the packaged app contains it. — grows from [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- If copying on first run later: store `{base, files: {path: hash}}`. Unchanged files update silently. Changed files get a choice. A version stamp tells "user edited" from "stale copy". — grows from [Copier updating](https://copier.readthedocs.io/en/stable/updating/) (own simplification)
- One host-set env var for the state folder, read by hooks and scripts, default `pod-docs`. Skills cannot read env vars, so skill text needs `${user_config.KEY}` (unverified under `--plugin-dir`). — grows from [Terraform env vars](https://developer.hashicorp.com/terraform/cli/config/environment-variables) (own design)
- Rename on first run: if the new folder is absent and the old exists, ask once, then move. Test with an old-name fixture and an empty-new-folder case. — grows from [git](https://git-scm.com/docs/git#_git_commits), [devsy](https://github.com/devsy-org/devsy/pull/598) (own adaptation)
- At session start, run `claude plugin list --json` once. Warn if the same plugin is installed. Detect a `disableSideloadFlags` failure and tell the user. — grows from [cli-reference](https://code.claude.com/docs/en/plugins/cli-reference.md) (own idea)
- Use a unique manifest name for the bundled copy, or set `@inline` handling on purpose. — grows from [loading](https://code.claude.com/docs/en/plugins/loading)
- Check the plugin `name` against the reserved prefix before release. — grows from [plugins-reference](https://code.claude.com/docs/en/plugins-reference)

## Questions for the plan
1. Manifest `name` and the `claude-` prefix — why it matters: validate errors on it; Claude Code still loads it ([plugins-reference](https://code.claude.com/docs/en/plugins-reference)). Renaming changes skill ids to `<new>:<skill>`. — options: keep and skip validate / rename / manifest name differs from repo name
2. How to pin and bundle (Q1) — why it matters: all three end as a folder for `extraResources`; they differ in clone step, hash check, and install scripts. — options: A submodule (pins SHA, needs recurse on clone) / B download tag tarball plus committed SHA-256 (no reference script exists) / C npm `github:` dep (runs scripts)
3. Which copy wins when the user also installed the plugin? — why it matters: a session plugin silently replaces a same-named one; issue #35423 is unresolved. — options: accept / detect and warn / different manifest name / set `@inline` rule
4. What if an organization sets `disableSideloadFlags`? — why it matters: Claude Code exits 1 and does not start. — options: clear error / project `.claude/` plugin location (untested) / unsupported
5. Does claude-pod need `node_modules` or files outside its root? — why it matters: auto-install covers npm lockfile registry deps only, and no evidence for `--plugin-dir`. — options: self-contained / pre-installed deps / install from a hook into `${CLAUDE_PLUGIN_DATA}`
6. Where do user edits live later (Q2)? Is the bundle read-only? — why it matters: no per-file override exists; a copy never gets updates unless merged. — options: replace-whole-plugin only with read-only bundle / copy on first run with base hashes / per-file override layer / folder under `.openaflow/`
7. Is the bundled folder writable on all targets? — why it matters: AppImage mount not verified. — options: forbid plugin writes outside the project and `CLAUDE_PLUGIN_DATA` / copy to a user data dir on version change
8. How does the plugin learn the state folder name (Q3)? — why it matters: skills cannot read env vars; `userConfig` under `--plugin-dir` is unverified. — options: host env var for hooks plus `userConfig` for skills / marker or config file in the project / hard-code `.openaflow/` in a new claude-pod release
9. Existing `pod-docs/` folders? — why it matters: devsy broke on a partial move. — options: detect and offer one-time move / read both, write new / leave old name, opt in / hard rename
10. Minimum Claude Code version? — why it matters: no evidence found; `engines` field exists. — options: test the oldest build / read the changelog

## Suspect pages
- none

## Sources
- Plugin commands reference — https://code.claude.com/docs/en/plugins/cli-reference.md — 2026-11-22
- Plugin loading reference — https://code.claude.com/docs/en/plugins/loading.md — 2026-11-22
- Plugin loading reference (no `.md`) — https://code.claude.com/docs/en/plugins/loading — 2026-11-22
- Plugin manifest reference — https://code.claude.com/docs/en/plugins-reference — 2026-11-22
- Marketplace reference — https://code.claude.com/docs/en/plugins/marketplace-reference.md — 2026-11-22
- Create a marketplace — https://code.claude.com/docs/en/plugin-marketplaces — 2026-11-22
- Explore the .claude directory — https://code.claude.com/docs/en/claude-directory — 2026-11-22
- Claude Code environment variables — https://code.claude.com/docs/en/env-vars.md — 2026-11-22 (partial)
- Claude Code environment variables (no `.md`) — https://code.claude.com/docs/en/env-vars — 2026-11-22 (partial)
- GitHub issue #35423 — https://github.com/anthropics/claude-code/issues/35423 — closed 2026-03-21
- GitHub issue #32983 — https://github.com/anthropics/claude-code/issues/32983 — closed 2026-03-14
- electron-builder application contents — https://www.electron.build/docs/contents — 2026-11-22
- Copier: updating a project — https://copier.readthedocs.io/en/latest/updating/ — 2026-11-22
- Copier: updating (stable) — https://copier.readthedocs.io/en/stable/updating/ — 2026-11-22
- Copier: configuring a template — https://copier.readthedocs.io/en/stable/configuring/ — 2026-11-22
- Terraform CLI environment variables — https://developer.hashicorp.com/terraform/cli/config/environment-variables — 2026-11-22
- GitHub changelog: releases expose digests — https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/ — 2025-06-03
- Cargo environment variables — https://doc.rust-lang.org/cargo/reference/environment-variables.html — 2026-11-22
- npm package.json (git URLs) — https://docs.npmjs.com/cli/v10/configuring-npm/package-json#git-urls-as-dependencies — 2026-11-22
- Git (GIT_DIR) — https://git-scm.com/docs/git#_git_commits — 2026-11-22
- Pro Git: Submodules — https://git-scm.com/book/en/v2/Git-Tools-Submodules — 2026-11-22
- Gotchas for Submodules — https://t4d-gmbh.github.io/git-and-science/slides/content/submodules/gotchas.html — undated
- Notepad++ community thread — https://community.notepad-plus-plus.org/post/87779 — undated
- devsy PR #598 — https://github.com/devsy-org/devsy/pull/598 — undated
