# Research: Default workflow for OpenAFlow (angle: existing)

_Generated: 2026-11-22 · Depth: standard · Researchers: 1 · Searches: 6 · Pages read: 8_

**Assumptions:** The workflow ships as a Claude Code plugin loaded per session. Every claim below rests on a page I fetched. Search results I did not fetch are leads only and are not cited. For question 1 I found no fetched source. For question 3 I fetched only Terraform and the Claude Code docs. See the "no evidence found" lines.

## What exists
| Name | Link | What it does | Alive? | License | How close to the idea |
|------|------|--------------|--------|---------|-----------------------|
| Claude Code `--plugin-dir` / `CLAUDE_CODE_PLUGIN_DIRS` / `--plugin-url` | https://code.claude.com/docs/en/plugins/cli-reference.md | Loads a plugin from a directory, a `.zip`, or a folder of plugins for one session. `--plugin-url` fetches a `.zip` from a URL. Both flags are repeatable. Loaded in place, never copied. Id is `<name>@inline`. | Official docs, current | no evidence found | Very close: the per-session load path for the bundled workflow |
| Claude Code marketplace plugins (pin by `version`, git SHA, `sha256` for archive sources) | https://code.claude.com/docs/en/plugins/loading.md | Installs to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. A manifest `version` pins; otherwise the 12-char commit SHA is the version. A marketplace can be added pinned to a branch, tag or SHA (`owner/repo#ref`). | Official docs | no evidence found | Close: a built-in pin and update model, an alternative to bundling |
| Claude Code plugin manifest (`userConfig`, `${CLAUDE_PLUGIN_DATA}`, `engines`) | https://code.claude.com/docs/en/plugins-reference | Plugin settings, a data dir kept across updates, and a Claude Code version range. | Official docs | `license` field takes an SPDX id | Close: the plugin-side seam for host settings |
| Copier | https://copier.readthedocs.io/en/latest/updating/ | Template engine. `copier update` regenerates old and new template output and merges with local edits. Needs git tags and `.copier-answers.yml`. | Docs current (`latest`) | no evidence found | Partial: a model for update-after-edit, not a runtime fit for an Electron app |
| Terraform `TF_DATA_DIR` | https://developer.hashicorp.com/terraform/cli/config/environment-variables | Env var that replaces the per-working-directory data folder, which defaults to `.terraform` in the current directory. | Official docs, current | no evidence found | Partial: the env-var model for renaming a tool's state folder |
| `CLAUDE_CONFIG_DIR` | https://code.claude.com/docs/en/claude-directory | Env var that moves every `~/.claude` path and `.claude.json` to another directory. | Official docs, current | no evidence found | Partial: the same model, but for the user folder, not the project folder |

## Gaps and angles
- A session-only plugin (`--plugin-dir`) with the same name as an installed plugin replaces it for that session. The installed copy loads instead if you disable `<name>@inline` or managed settings lock the name. `claude plugin list` shows session-only plugins only when the flag precedes the subcommand. So "loaded twice" is replacement, not duplication, if manifest names match. — [cli-reference](https://code.claude.com/docs/en/plugins/cli-reference.md), [loading](https://code.claude.com/docs/en/plugins/loading.md)
- An administrator can reject `--plugin-dir`, `--plugin-url` and `CLAUDE_CODE_PLUGIN_DIRS` with the managed `disableSideloadFlags` setting. Claude Code then prints a message and exits 1 without starting. OpenAFlow sessions in such organizations would fail to start. — [cli-reference](https://code.claude.com/docs/en/plugins/cli-reference.md)
- Name risk: `claude plugin validate` raises an error for names starting with `claude-`. The text says Claude Code "still installs and loads" such a plugin, and `claude plugin init`/`tag` refuse the name. The plan names "claude-pod". — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- `${CLAUDE_PLUGIN_ROOT}` changes per version, so state must not go there. `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) persists across updates. These variables are not in the Bash tool environment. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- Plugin components cannot point outside the plugin root (`..` or escaping symlinks are rejected). A submodule works only if it sits inside the plugin folder. — [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Plugin dependency auto-install works only with an npm lockfile; yarn/pnpm lockfiles and git dependencies get no install. — [loading](https://code.claude.com/docs/en/plugins/loading.md)
- A root `CLAUDE.md` in a plugin is not loaded as context. Put instructions in a skill. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- `CLAUDE_CONFIG_DIR` moves the `~/.claude` tree and `.claude.json`. The page treats the project `.claude/` folder as a separate in-repo folder and does not say the variable moves it. Project settings cannot set `CLAUDE_CONFIG_DIR`; it must come from the shell, user or managed settings, and takes an absolute path. So I found no way in Claude Code to rename a project state folder. — [claude-directory](https://code.claude.com/docs/en/claude-directory), [env-vars](https://code.claude.com/docs/en/env-vars.md) (first 100000 characters only)
- `CLAUDE_CODE_PLUGIN_CACHE_DIR` moves the plugins root. — [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Terraform: the data-folder variable must be set the same for every command, from `init` on, or Terraform may not find providers and modules. A state-folder rename needs the host to set it every time. — [Terraform env vars](https://developer.hashicorp.com/terraform/cli/config/environment-variables)
- Question 1 (submodule vs release download with checksum vs npm from git tag; electron-builder `extraResources`/asar; license notices): no evidence found.
- Question 3 beyond Terraform and Claude Code (git `GIT_DIR`, Husky, XDG, migration or fallback of old names): no evidence found.

## Best practices
- Pin by explicit `version` in the manifest: users stay on that version until you change the string. Without it, each commit is a new version. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference), [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Use `sha256` pins for archive sources: the digest becomes the version. — [loading](https://code.claude.com/docs/en/plugins/loading.md)
- Run `claude plugin validate` in CI (`--strict` turns warnings into failures). — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- Copier model for editable defaults: keep the template in git with tags, store the answers, regenerate old vs new and merge; `check-update` for automation; `recopy` as "reset to default"; do not hand-edit the answers file. — [Copier updating](https://copier.readthedocs.io/en/latest/updating/)
- Persist generated state in `${CLAUDE_PLUGIN_DATA}` or the project, not the plugin root. — [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- Rename a state folder with one env var that the host sets on every command, as Terraform does with `TF_DATA_DIR`. — [Terraform env vars](https://developer.hashicorp.com/terraform/cli/config/environment-variables)

## Ideas to consider
- Keep the seam as "a plugin folder path": OpenAFlow passes `--plugin-dir <dir>`; the dir is the bundled copy by default, and a later user override is a different path. — grows from the in-place `--plugin-dir` load ([cli-reference](https://code.claude.com/docs/en/plugins/cli-reference.md))
- Copy-on-first-run into a user folder with a recorded base version, then Copier-style old/new/user merge on version bump. — grows from [Copier](https://copier.readthedocs.io/en/latest/updating/)
- Check the plugin `name` against the reserved-prefix rule before release. — grows from [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- Detect a same-named installed plugin or a `disableSideloadFlags` failure at session start and tell the user. — grows from [cli-reference](https://code.claude.com/docs/en/plugins/cli-reference.md)
- Let the plugin read its state folder name from one host-set env var, set on every session like `TF_DATA_DIR`, with the old name as default. — grows from [Terraform env vars](https://developer.hashicorp.com/terraform/cli/config/environment-variables) (own design for the plugin side; no fetched doc shows a plugin doing this)

## Questions for the plan
- Keep the name `claude-pod`? — why it matters: names starting with `claude-` fail `claude plugin validate`; init/tag refuse them; loading still works — options: keep and skip validate / rename / test on the target Claude Code version
- When a user also installed the plugin, which copy wins? — why it matters: a session-only plugin replaces a same-named installed one — options: accept replacement / different manifest name for the bundled copy / warn in the app
- Where does the editable copy live? — why it matters: `--plugin-dir` loads in place; cache versions change path per update — options: read-only bundle plus override path / copy on first run with base-version record / folder under `.openaflow/`
- What if an organization sets `disableSideloadFlags`? — why it matters: Claude Code exits 1 without starting — options: show a clear error / use a plugin folder under the project's `.claude/skills/` (the loading page lists it as another plugin location, with a trust check; not tested against this setting) / document as unsupported
- How does the plugin learn the state folder name? — why it matters: `CLAUDE_CONFIG_DIR` does not rename a project folder, and no fetched source shows another way — options: host-set env var / marker file in the project root / hard-code `.openaflow/` in a new plugin version
- Which minimum Claude Code version? — why it matters: no evidence found for the versions that added zip, folder-of-plugins and `CLAUDE_CODE_PLUGIN_DIRS` (earlier figures cut as unconfirmed) — options: test on the oldest supported build / read the changelog

## Suspect pages
- none

## Sources
- Plugin commands reference — https://code.claude.com/docs/en/plugins/cli-reference.md — fetched 2026-11-22 (from offset 45000)
- Plugin loading reference — https://code.claude.com/docs/en/plugins/loading.md — fetched 2026-11-22
- Plugin manifest reference — https://code.claude.com/docs/en/plugins-reference — fetched 2026-11-22
- Explore the .claude directory — https://code.claude.com/docs/en/claude-directory — fetched 2026-11-22
- Claude Code environment variables — https://code.claude.com/docs/en/env-vars.md — fetched 2026-11-22 (first 100000 characters)
- Copier: Updating a project — https://copier.readthedocs.io/en/latest/updating/ — fetched 2026-11-22
- Terraform CLI environment variables reference — https://developer.hashicorp.com/terraform/cli/config/environment-variables — fetched 2026-11-22
