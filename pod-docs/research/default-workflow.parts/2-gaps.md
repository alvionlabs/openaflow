# Research: Default workflow (claude-pod) — pinning, editable defaults, renamed state folder — gaps angle

_Generated: 2026-11-22 · Depth: standard · Researchers: 1 · Searches: 7 · Pages read: 8_

**Assumptions:** Angle is `gaps` only (what goes wrong). Claude Code facts come from the official docs as fetched today (2026-11-22). GitHub issue pages for Claude Code bugs are cited only where fetched; the claudeissues.com mirror did not resolve.

## What exists
Not covered by this angle (see the `existing` part). Failure stories only.

| Name | Link | What it does | Alive? | License | How close to the idea |
|------|------|--------------|--------|---------|-----------------------|
| n/a (gaps angle) | | | | | |

## Gaps and angles

### Claude Code plugins (most relevant to OpenAFlow)
- **`--plugin-dir` silently replaces a same-named installed plugin.** An enabled `--plugin-dir` plugin takes precedence over an installed marketplace plugin of the same manifest name. The marketplace row still shows as enabled in `claude plugin list`; only `--debug` logs record `Plugin "<name>" from --plugin-dir overrides installed version`. So the "loaded twice" worry is, per the docs, a silent override, not a double load, when the manifest names match. If the names differ, both load. — [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading)
- **Docs and behavior were once unclear, and the issue was closed with no maintainer answer.** Issue #35423 asked whether marketplace plus `--plugin-dir` dedupes or loads both. A bot closed it as a duplicate of #32619 ("`--plugin-dir` does not override installed plugin with same name"); no maintainer commented. Titles of the linked issues suggest the precedence had bugs in March 2026; the current docs (above) describe the override as designed. Verify on the pinned Claude Code version. — [GitHub #35423](https://github.com/anthropics/claude-code/issues/35423)
- **Hooks of a same-named second plugin are dropped.** If two enabled plugins share a manifest name from different marketplaces, only one registers its `hooks/hooks.json`; the other shows as enabled but its hooks do not run. Matters for claude-pod hooks if the user also installed it. — [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading)
- **Escape hatch:** set `"<name>@inline": false` in settings to stop a `--plugin-dir` plugin from shadowing the installed one. — [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading)
- **`--plugin-dir` loads in place, never copied.** Good for a bundled dir. But a plugin may not declare components outside its own root: `..` paths and symlinks leading outside are rejected (`path escapes plugin directory`), and the plugin loads without that component. A plugin dir inside an asar or with symlinks to a shared folder would break. — [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading), [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- **Plugin root is not a place for state.** `${CLAUDE_PLUGIN_ROOT}` changes with each version; docs say durable files go in `${CLAUDE_PLUGIN_DATA}`. These variables are not in the environment of Bash-tool commands, only in hooks, MCP/LSP and skill/agent text. So a skill that runs a shell command cannot read `$CLAUDE_PLUGIN_ROOT` from the env. — [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- **A plugin's `CLAUDE.md` is not loaded.** Instructions must live in a skill. — [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- **Plugin name is reserved-checked.** Names starting `claude-` draw an error in `claude plugin validate`, which also checks that the name is not one of Anthropic's own; `claude plugin init`/`tag` refuse such a name, though Claude Code still loads it. The plugin name `claude-pod` starts with `claude-`. Name for the plugin is a risk to check with the claude-pod owner. — [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- **Update problems (marketplace route, not `--plugin-dir`).** Cache is keyed by version string. With a pinned `"version"` in `plugin.json`, users stay on the cached copy however many commits you push. Issue #32983: content changed with same version string, `/plugin update` did nothing, and reinstall left the cache empty; closed by a bot as a duplicate of #29074, no fix shown. Workaround: bump version. — [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading), [GitHub #32983](https://github.com/anthropics/claude-code/issues/32983)
- **Old version directories are deleted 14 days after update.** Sessions on old versions keep running. Not an issue for `--plugin-dir`. — [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading)
- **Plugin npm dependencies from git are not installed.** Claude Code's automatic install accepts registry packages pinned in an npm lockfile only; git, GitHub, folder, workspace and linked deps get no install; lifecycle scripts do not run; 60-second timeout; yarn/pnpm lockfiles are skipped. Relevant if claude-pod needs `node_modules`. For `--plugin-dir` (loaded in place) the docs describe no auto-install for local-path marketplace plugins; for `--plugin-dir` itself, no evidence found. — [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading)

### Submodules
- Submodules do not auto-update, are pinned to a commit (detached HEAD), need `--recurse-submodules` on clone, and URL changes need hand edits to `.gitmodules`. — [Gotchas for Submodules](https://t4d-gmbh.github.io/git-and-science/slides/content/submodules/gotchas.html)
- Fits the decision (hand version bump, pin a tag): these gotchas mainly hurt when people edit inside the submodule. Risk: a CI checkout or a contributor clone without `--recurse-submodules` builds an app without the workflow. (Inference from the above; no fetched failure story for this exact case.)

### Editable defaults overwritten on update
- **Notepad++:** users lost custom themes on update. Experienced members said the outcome depends on the installer option "Don't use %AppData%": when set, theme files extract into the install dir and edits there "can be overwritten by the upgrade"; when unset, modified files live in %AppData% and are safe. Fix: separate user data location from shipped files, or save customizations under a unique name. — [Notepad++ community thread](https://community.notepad-plus-plus.org/post/87779)
- Lesson: shipped default and user copy in the same folder is the failure mode. A read-only bundled layer plus a user layer avoids it, but then updates never reach a user who copied-and-edited (the stale-copy side). No fetched source gave a failure story of stale copies; `no evidence found` for that half.

### Renamed state folder
- **devsy:** a PR moved only `ConfigDir` from `~/.devsy` to `~/.config/devsy`, leaving data/state/cache dirs at `~/.devsy`. After upgrade the app read an empty config from the new dir and every workspace failed with "provider "docker" is not initialized". Fix: revert the move. Users who re-initialized in the interim have a config in the new dir that is no longer read; they must re-init or move the file. Lesson: move all folders together; read the old location when the new one is empty; add a release note. — [devsy PR #598](https://github.com/devsy-org/devsy/pull/598)
- Other rename stories (LibreOffice, AutoArchive, mc) appeared in search results only; not fetched, so not used.

## Best practices
- Keep the bundled workflow outside any user-editable folder, and keep user edits in a separate layer — Notepad++ losses came from shipped and user files sharing a folder. — [Notepad++ thread](https://community.notepad-plus-plus.org/post/87779)
- Bump the plugin `version` for every release; do not rely on commit hashes with a pinned version string — cache keyed by version. — [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading)
- Run `claude plugin validate --strict` in CI on the pinned plugin — catches escaped paths, bad names, bad manifests. — [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- Keep state out of `${CLAUDE_PLUGIN_ROOT}`; use `${CLAUDE_PLUGIN_DATA}` or the project folder. — [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- Move a renamed folder as a whole, with a fallback read of the old name — devsy split-folder failure. — [devsy PR #598](https://github.com/devsy-org/devsy/pull/598)

## Ideas to consider
- Launch with a unique manifest name for the bundled copy, or set `<name>@inline` handling on purpose, so duplicate behavior is known, not accidental — grows from the name-conflict rules ([loading reference](https://code.claude.com/docs/en/plugins/loading)).
- Start each session with `--debug`-free check: in the app, run `claude plugin list --json` once and warn if the same plugin name is installed normally — grows from the silent override (same source). (own idea)
- Build step that fails if the bundled plugin dir is empty (submodule not initialized) — grows from submodule clone gotcha ([gotchas](https://t4d-gmbh.github.io/git-and-science/slides/content/submodules/gotchas.html)). (own idea)
- Write a version stamp file in the user's override layer so the app can tell "user edited" from "stale copy" — grows from Notepad++ overwrite/stale split. (own idea)
- Test the folder rename with an old-name fixture project and an empty-new-folder case — grows from devsy. (own idea)

## Questions for the plan
- Does the claude-pod plugin name conflict with the `claude-` reserved-name check? — why it matters: validate errors on `claude-` prefix; Claude Code still loads it, but `plugin init/tag` refuse it — options: keep name / rename plugin / ask Anthropic docs owner.
- What should happen if the user already installed claude-pod from a marketplace? — why it matters: `--plugin-dir` silently wins when manifest names match; both load when names differ; hooks of one same-named copy are dropped — options: accept silent override / detect and warn / set `@inline` rule.
- Does claude-pod need `node_modules` or files outside its root? — why it matters: path escape is rejected; git deps get no auto-install — options: self-contained plugin / ship deps pre-installed / install from a hook into `${CLAUDE_PLUGIN_DATA}`.
- Where will user edits live later, and is the bundled copy read-only? — why it matters: shared folder was the loss cause — options: bundled read-only plus override layer / copy on first run with version stamp.
- Rename in one step or with fallback? — why it matters: devsy split-folder break — options: hard rename / read both with a warning / one-time migration.

## Suspect pages
- none

## Sources
- Plugin loading reference — https://code.claude.com/docs/en/plugins/loading — fetched 2026-11-22
- Plugin manifest reference — https://code.claude.com/docs/en/plugins-reference — fetched 2026-11-22
- Unclear behavior when same plugin loaded via marketplace and --plugin-dir (#35423) — https://github.com/anthropics/claude-code/issues/35423 — closed 2026-03-21
- Plugin cache not refreshed when version string unchanged (#32983) — https://github.com/anthropics/claude-code/issues/32983 — closed 2026-03-14
- Gotchas for Submodules — https://t4d-gmbh.github.io/git-and-science/slides/content/submodules/gotchas.html — undated
- Notepad++ community thread — https://community.notepad-plus-plus.org/post/87779 — undated
- devsy PR #598 — https://github.com/devsy-org/devsy/pull/598 — undated
