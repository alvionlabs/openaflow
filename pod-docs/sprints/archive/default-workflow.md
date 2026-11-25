# Sprint: Default workflow

_From plan: pod-docs/plans/default-workflow.md · Slug: default-workflow · Status: active · Generated: 2026-11-23_


## Status board

| Wave | Slice | Title | Branch | PR | Status | Confidence | Depends on |
|------|-------|-------|--------|----|--------|------------|------------|
| 1 | F1 | Workflow lock, bump, fetch and transform | default-workflow-F1 | merged | done | medium | — |
| 1 | M1 | Model: repo workflows and the per-folder run model | default-workflow-M1 | merged | done | medium | — |
| 1 | S1 | Server: read and watch every state folder; workflow resolver | default-workflow-S1 | merged | done | medium | — |
| 1 | D1 | App bundle: ship the plugin, env to the server, notices | default-workflow-D1 | merged | done | medium | — |
| 2 | S2 | Queue writes go to the entry's state folder | default-workflow-S2 | merged | done | medium | M1 |
| 2 | S3 | Session start with the workflow plugin; sideload stop; Board version | default-workflow-S3 | merged | done | medium | M1, S1, F1, D1 |
| 3 | R1 | Setup and Use-version routes; README | default-workflow-R1 | merged | done | medium | M1, S1, S3 |
| 3 | T1 | Terminal tab: the sideload stop line | default-workflow-T1 | merged | done | medium | M1, S3 |
| 4 | N1 | New session: bare names, init, version line, mismatch, setup offer | default-workflow-N1 | merged | done | medium | M1, S3, R1 |
| 4 | A1 | Add repo: ask to create `.openaflow/` | default-workflow-A1 | merged | done | medium | R1 |

No `L1`: the plan's `## Look` asks for no new look. UI slices use only the tokens in `packages/web/src/theme/tokens.css` and follow `DESIGN.md`.

## Shared contract

### 1. Names and paths
- **Lock:** `packages/workflow/workflow.lock.json`, exactly `{ "repo": "<https git URL>", "tag": "<tag>", "commit": "<40 lowercase hex>" }`, keys in that order, 2-space JSON, final newline. Tag rule: `^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$` (claude-pod tags its releases `v<version>`). A tag's **version** is the tag without the `v`. First pin: `https://github.com/iamphduc/claude-pod.git` at the newest `v*` tag (0.11.10 when this doc was written). F1 reads the commit with `git ls-remote`.
- **Build output:** `packages/workflow/dist/claude-pod/` (git-ignored) holds only `.claude-plugin/`, `skills/`, `agents/`, `docs/`, and `LICENSE`. Beside it, `packages/workflow/dist/claude-pod.stamp.json` holds the lock text it was built from.
- **Repo layout:** `.openaflow/workflows/<name>/workflow.json` and `.openaflow/workflows/<name>/state/`. Name rule: `^[a-z0-9][a-z0-9-]{0,63}$`. A folder with another name is not a workflow.
- **Template state:** `<plugin>/skills/init/scaffold/.openaflow/workflows/claude-pod/state/`. This is claude-pod's `skills/init/scaffold/pod-docs/` after the rename.
- **Bundle place:** packaged `<resources>/workflows/claude-pod/`; unpackaged `<appPath>/../workflow/dist/claude-pod/`. The env `OPENAFLOW_WORKFLOWS_DIR` names the folder that holds `claude-pod/`. Desktop main always sets it and replaces an inherited value. `pnpm dev` and `pnpm start` use it when it is set (the smoke recipe sets `<repo>/packages/workflow/dist`). Unset or empty → no bundle.
- **Bundled version:** `version` in `<bundle>/claude-pod/.claude-plugin/plugin.json`. It must match `x.y.z` (digits, no leading zero), else no bundle. Versions compare as strings: not equal is a mismatch.
- **Known sources:** `['claude-pod']`; the default is `claude-pod`. A `source` maps to a folder only through this list. A source string is never joined into a path.
- **Tests** build every temp path from `realpath(mkdtemp(...))` (see `pod-docs/known-issues/temp-paths-resolve-differently.md`).

### 2. Fetch and transform (F1)
- `pnpm build` runs the workflow build (the `packages/workflow` `build` script). If the stamp equals the lock and `dist/claude-pod/.claude-plugin/plugin.json` exists, it makes no git call. Else it clones the tag shallow into a temp folder. It fails unless `git rev-parse HEAD` equals the lock's commit, and the message names both commits. No `git` → it fails with `git not found: the workflow build needs git`.
- It copies the five parts. In each copied file, each `pod-docs` becomes `.openaflow/workflows/claude-pod/state`. In each path, a segment `pod-docs` becomes those four segments. The match is case-sensitive.
- The build fails when an output file or path holds `pod-docs` (the message names each file), when the `plugin.json` version differs from the tag's version, or when the template state or `LICENSE` is missing. It builds into a temp folder and then renames, so a failure leaves no `dist/claude-pod` and no stamp.
- `pnpm bump-workflow <tag>` (root script → `pnpm --filter @openaflow/workflow bump`) refuses a tag outside the rule before git runs. It reads the commit with `git ls-remote <repo> refs/tags/<tag> refs/tags/<tag>^{}`; for an annotated tag, the peeled `^{}` line wins. It writes only the lock. An unknown tag → exit 1, and the lock stays as it was. Tests use local git repos in temp folders, never the network.

### 3. Repo files and the `.openaflow/` signal (S1 reads, M1 parses; the model has no I/O)
- `readRepoFiles` checks `<repo>/.openaflow`. When it is a real folder inside the repo's real path, it adds the key `.openaflow/` (value `''`). For each subfolder of `.openaflow/workflows/` that meets the name rule, it adds the key `.openaflow/workflows/<name>/` (value `''`), and `.openaflow/workflows/<name>/workflow.json` with its text when it can read it. Then it reads each workflow's state files: today's file set, with `pod-docs` replaced by `.openaflow/workflows/<name>/state`. It then reads no `pod-docs/` file.
- `.openaflow` missing, a file, or a link that leaves the repo → no markers, and `pod-docs/` is read as today.
- Research reports (`<state>/research/*.md`) are keyed with `''`, because the model uses only their names (queue entry 2026-10-30 on `MD_FOLDERS`; this applies to `pod-docs/research` too).
- Every guard stays: real path inside the repo, plain files only, the 5 MB limit.

### 4. Model shapes (M1)
- `type RepoWorkflow = { name: string; stateDir: string; source?: string; version?: string; legacy?: true }`. `repoWorkflows(files)` with no `.openaflow/` key → `[{ name: 'pod-docs', stateDir: 'pod-docs', legacy: true }]`. With the key → one per `.openaflow/workflows/<name>/` key, sorted by name, with `stateDir` = `.openaflow/workflows/<name>/state`. With no folder keys → an empty list. `source` is set only when `workflow.json` parses to an object whose `source` is a string that meets the name rule. `version` is set only when its `version` is a string that meets `x.y.z`.
- **Legacy stays the same:** with no `.openaflow/` key, `buildRepoModel` returns exactly today's model, with no new field. Existing tests and fixtures pass unchanged.
- With the key, `buildRepoModel` builds today's model once per workflow, then merges in workflow order. It sets `RepoModel.openaflow: true` and `RepoModel.workflows`. Each `PlanModel` and `QueueItem` gets `stateDir`. `research` joins. `docs` is the first workflow whose docs are supported, else the first one's, else unsupported. `staging` is the first one found. When two workflows have the same plan slug, the first workflow's plan stays and the other is left out. A workflow with no state files gives an empty part, not an error.
- New optional fields: `RepoModel.openaflow?: true`, `RepoModel.workflows?: RepoWorkflow[]`, `PlanModel.stateDir?`, `QueueItem.stateDir?` (absent means `pod-docs`), `Board.workflow?: { source: 'claude-pod'; version: string }` (the bundle; absent with no bundle), and `HostedSession.blocked?: 'sideload'`. Action log names gain `setup-workflow` and `use-workflow-version`.

### 5. Queue writes (S2)
- `writeAnswer` and `writeResolution` take `stateDir` and write `<stateDir>/handoff-queue.md`. `stateDir` must be `pod-docs` or `.openaflow/workflows/<name>/state` with a valid name. Anything else → `failed`, and nothing is written.
- The routes take `stateDir` from the matched Board item (absent → `pod-docs`), never from the request. A line that is answerable in more than one state folder → outcome `changed` with the message `Two entries read the same. Answer it in the chat.`, and nothing is written.

### 6. Session start (S3)
- **Not set up starts as today** (human, 2026-11-24, see `decisions.md`): New session and Resume in a repo without `model.openaflow` (a `pod-docs/` repo, or a repo with no docs) start exactly as today: `--plugin-dir <hooks>` only, no workflow plugin, so an installed claude-pod writes `pod-docs/`. They never answer `not set up`. The bundled plugin never creates `.openaflow/` by itself.
- **Folder (set-up repos only):** `resolver.forRepo(workflows)` gives the bundle of the first workflow (by name) with a known source. A workflow with no `source`, or zero workflow folders, uses the default. Only unknown sources, or no bundle → `409 {"error":"workflow missing"}`, with no record and no log entry.
- **Args (set-up repos):** `--session-id <id> --plugin-dir <hooks> --plugin-dir <workflow>`, then the prompt, last. Resume: `--resume <id> --plugin-dir <hooks> --plugin-dir <workflow>`. The workflow folder must be absolute (`bad path`) and passes the Windows `CMD_UNSAFE` check (`unsafe claude path`). The settings preview shows both flags.

### 7. Sideload block (S3 sets, T1 shows)
- Managed settings file: linux `/etc/claude-code/managed-settings.json`, win32 `C:\Program Files\ClaudeCode\managed-settings.json`, darwin `/Library/Application Support/ClaudeCode/managed-settings.json`. Tests inject the path.
- `blocked: 'sideload'` when the session is `ended`, `hooked` and `prompted` are false, and the file parses to an object with `disableSideloadFlags === true`. A missing, unreadable, or invalid file, or any other value → no `blocked`. The server reads the file at most once per Board build, and only when a session qualifies. The app never matches Claude Code's printed text.
- Stop line: **"Claude couldn't start. Your organization's `disableSideloadFlags` setting blocks the plugins OpenAFlow loads."** That session gets no Resume, and Dismiss stays.

### 8. Setup and Use-version routes (R1 builds them; N1 and A1 call them with `postAction`)
- Both routes sit behind the action guard (token, Origin, JSON object) and append one log entry.
- `POST /api/repos` → `201 { path, openaflow: boolean }`. `openaflow` is true when `<path>/.openaflow` exists as anything.
- `POST /api/actions/setup-workflow { path }`: `path` must be a repo on the current Board or in the config file (the same identity rule as Add repo's duplicate check), else `404 {"error":"not a repo"}`. `<repo>/.openaflow` exists as anything → `409 {"error":"already set up"}`. No bundle or no template → `409 {"error":"workflow missing"}`. The route builds `workflows/claude-pod/workflow.json` (`{ "source": "claude-pod", "version": "<bundled>" }`, 2-space JSON, final newline) and a copy of the template as `workflows/claude-pod/state/` in `<repo>/.openaflow.tmp-<hex>`, then renames that folder to `.openaflow`. On a failure it removes the temp folder → `500 {"error":"setup failed: <code>"}`. One setup per repo at a time: a second one → `409 {"error":"setup in progress"}`. Success → rebuild, then `200 {"outcome":"created","logged":bool}`.
- `POST /api/actions/use-workflow-version { repoId, name }`: the repo must be on the Board, and `name` must be one of its `model.workflows` with source `claude-pod`, else `404 {"error":"not a workflow"}`. No bundle → `409 {"error":"workflow missing"}`. A `workflow.json` that can't be read, isn't a JSON object, or has a real path outside the repo → `409 {"error":"workflow.json unreadable"}`. Same version → `409 {"error":"already current"}`. The route sets `version`, keeps every other key, and writes through a temp file and a rename → rebuild, then `200 {"outcome":"updated","logged":bool}`.

- **Changed 2026-11-24 (human, wave 4 fix):** `POST /api/repos` also returns `podDocs`. Add repo on a repo with neither `.openaflow/` nor `pod-docs/` sets it up with no question (a "Repo added · Created .openaflow/workflows/claude-pod/" modal closes itself after 3 s). A repo with `pod-docs/` gets the confirm plus `Its pod-docs/ runs will no longer show on the board.`, and New session's Set up offer shows that warning too. See `decisions.md`.

### 9. UI words (N1, A1)
- **Skills:** `SkillId` gains `init`. Each skill with a command gains `name`, its bare name. Order: `init`, `plan`, `ship`, `task`, `research`, `idea`, then `plain`. `init` = `{ name: 'init', command: '/pod:init', label: 'Map the project', line: 'Map the codebase and write the smoke recipe.' }`. The list shows `name` where it showed the command. Commands keep `/pod:`. The default pick stays `plan`.
- **Version line**, muted, under the button: `Workflow: claude-pod <bundled version>`. Only for a repo with `model.openaflow`. With no `Board.workflow`, or a repo without `.openaflow/`, there is no line.
- **Mismatch**, muted, above the button: `This repo uses claude-pod <x>; the app has <y>`, with a secondary **Use <y>** button. It shows when the repo's first `claude-pod` workflow has a `version` that differs from the bundle's. It never blocks a start.
- **Setup offer:** for a repo without `model.openaflow` (docs or not), New session is reachable (the start card and the ⋯ menu). The form shows `Create .openaflow/ in this repo?` (`.openaflow/` in mono) with **Set up**. New session stays on and starts as today (§6). The empty message of a repo with no docs and no `.openaflow/` is `This repo has no workflow yet. Set it up to use the app's claude-pod.` No screen names pod's install steps (`POD_INSTALL` goes). `already set up` reads `This repo already has a .openaflow file or folder.`
- **Add repo confirm,** after a `201` with `openaflow: false`: the modal shows `Create .openaflow/ in this repo?`, the facts list (Folder; Creates `.openaflow/workflows/claude-pod/`), and **Not now** and **Create**.

## Per-slice detail

### F1: Workflow lock, bump, fetch and transform
- **Scope:** §1 and §2. A new package `@openaflow/workflow` with no runtime exports. It joins `pnpm -r build` and `pnpm -r typecheck`. Update the brief (the `workflow` part, `OPENAFLOW_WORKFLOWS_DIR` in env and in the smoke recipe), and add `pod-docs/feature-details/workflow.md`.
- **Files owned:** `packages/workflow/package.json` (new), `packages/workflow/tsconfig.json` (new), `packages/workflow/workflow.lock.json` (new), `packages/workflow/.gitignore` (new), `packages/workflow/src/lock.ts` (new), `packages/workflow/src/bump.ts` (new), `packages/workflow/src/fetch.ts` (new), `packages/workflow/src/transform.ts` (new), `packages/workflow/scripts/build.ts` (new), `packages/workflow/scripts/bump.ts` (new), `packages/workflow/src/lock.test.ts` (new), `packages/workflow/src/bump.test.ts` (new), `packages/workflow/src/fetch.test.ts` (new), `packages/workflow/src/transform.test.ts` (new), `packages/workflow/src/build.test.ts` (new), `package.json`, `pnpm-lock.yaml`, `pod-docs/codebase-structure.md`, `pod-docs/feature-details/workflow.md` (new)
- **Success criteria:**
  - `[test] a lock with a bad repo, tag, or commit, or an extra key, is refused, and the error names the field — packages/workflow/src/lock.test.ts › readLock refuses a bad field`
  - `[test] bump writes the peeled commit of an annotated tag and changes only the lock — packages/workflow/src/bump.test.ts › bump writes the peeled commit`
  - `[test] bump with an unknown tag exits 1 and keeps the lock byte for byte — packages/workflow/src/bump.test.ts › unknown tag keeps the lock`
  - `[test] bump refuses a tag outside the rule before any git call — packages/workflow/src/bump.test.ts › bad tag runs no git`
  - `[test] the CLI with --lock and --repo bumps a temp lock from a local repo — packages/workflow/src/bump.test.ts › cli bumps a temp lock`
  - `[test] a tag at the locked commit is fetched — packages/workflow/src/fetch.test.ts › fetches the locked commit`
  - `[test] a tag moved to another commit fails, naming both commits — packages/workflow/src/fetch.test.ts › moved tag fails`
  - `[test] a stamp equal to the lock skips git; another stamp fetches again — packages/workflow/src/fetch.test.ts › stamp skips the fetch`
  - `[test] no git on PATH fails with the git-not-found message — packages/workflow/src/fetch.test.ts › git missing`
  - `[test] only the five parts are copied — packages/workflow/src/transform.test.ts › copies only the plugin parts`
  - `[test] pod-docs is renamed in file text and in the scaffold path — packages/workflow/src/transform.test.ts › renames text and paths`
  - `[test] a leftover pod-docs in a file or a path fails, naming each file — packages/workflow/src/transform.test.ts › leftover fails the build`
  - `[test] a plugin.json version unlike the tag's, a missing template, or a missing LICENSE fails — packages/workflow/src/transform.test.ts › bad source fails`
  - `[test] a failed build leaves no dist/claude-pod and no stamp; a rerun leaves no stale file — packages/workflow/src/transform.test.ts › output is all or nothing`
  - `[test] build() on a local fixture repo writes dist/claude-pod and the stamp — packages/workflow/src/build.test.ts › build writes dist and stamp`
- **Depends on:** —
- **One-way door:** none
- **Model:** top

### M1: Model: repo workflows and the per-folder run model
- **Scope:** §4. Pure, with no I/O; export from the model index. Do not change the pod-flow parsers or the skills list (N1 owns it).
- **Files owned:** `packages/model/src/repo-workflows.ts` (new), `packages/model/src/repo-workflows.test.ts` (new), `packages/model/src/run-model.ts`, `packages/model/src/run-model.test.ts`, `packages/model/src/board.ts`, `packages/model/src/actions.ts`, `packages/model/src/index.ts`, `pod-docs/feature-details/run-model.md`
- **Success criteria:**
  - `[test] no .openaflow/ key → one legacy pod-docs workflow — packages/model/src/repo-workflows.test.ts › legacy fallback`
  - `[test] with the key → one workflow per folder key, sorted, never pod-docs; no folder keys → empty — packages/model/src/repo-workflows.test.ts › one per folder`
  - `[test] a missing, unparseable, or wrong-typed workflow.json, or a bad version, leaves source and version unset — packages/model/src/repo-workflows.test.ts › bad workflow.json`
  - `[test] a folder key outside the name rule is no workflow — packages/model/src/repo-workflows.test.ts › name rule`
  - `[test] a pod-docs repo gives a model deep-equal to today's, with no new field — packages/model/src/run-model.test.ts › legacy model unchanged`
  - `[test] plans, sprints, and the queue come from a state folder, and pod-docs files are ignored when the key is there — packages/model/src/run-model.test.ts › reads a workflow state folder`
  - `[test] two workflows merge, each plan and entry carries its stateDir, and a repeated plan slug keeps the first — packages/model/src/run-model.test.ts › two workflows merge`
  - `[test] docs come from the first supported workflow; an empty state folder gives an empty part — packages/model/src/run-model.test.ts › docs and empty folders`
- **Depends on:** —
- **One-way door:** none
- **Model:** top

### S1: Server: read and watch every state folder; workflow resolver
- **Scope:** §3 in `readRepoFiles`. The watcher watches `<repo>/.openaflow` at depth 5 (keeping `.md` files and `workflow.json`) beside `pod-docs`, through the nearest existing parent as today. A new `workflow-resolver.ts`: `createWorkflowResolver({ root })` gives `bundled()` (source, version, absolute `dir`, `template`) and `forRepo(workflows: { source?: string }[] | undefined)`, per §1 and §6. It reads `plugin.json` once and keeps the result. S3 wires it.
- **Files owned:** `packages/server/src/repo-files.ts`, `packages/server/src/repo-files.test.ts`, `packages/server/src/watcher.ts`, `packages/server/src/watcher.test.ts`, `packages/server/src/workflow-resolver.ts` (new), `packages/server/src/workflow-resolver.test.ts` (new), `pod-docs/feature-details/server.md`
- **Success criteria:**
  - `[test] with a .openaflow folder, the markers, workflow.json, and each state folder's files are read, and no pod-docs file — packages/server/src/repo-files.test.ts › reads workflow state folders`
  - `[test] no .openaflow, or .openaflow as a file or a link out of the repo → pod-docs is read as before — packages/server/src/repo-files.test.ts › pod-docs fallback`
  - `[test] a workflow folder outside the name rule is skipped — packages/server/src/repo-files.test.ts › skips bad workflow names`
  - `[test] a state file whose real path leaves the repo is left out — packages/server/src/repo-files.test.ts › state link outside the repo`
  - `[test] research reports are keyed with empty text — packages/server/src/repo-files.test.ts › research names only`
  - `[test] watchTargets adds .openaflow at depth 5, keeping .md files and workflow.json — packages/server/src/watcher.test.ts › watches .openaflow`
  - `[test] a .openaflow folder made while the watcher runs rebuilds the Board, which then reads it — packages/server/src/watcher.test.ts › .openaflow appears`
  - `[test] bundled() reads the version; an unset root, a missing plugin.json, or a bad version → undefined — packages/server/src/workflow-resolver.test.ts › bundled version`
  - `[test] forRepo gives the first known source; no source, no workflows, or undefined → claude-pod; only unknown sources → undefined; "../x" builds no path — packages/server/src/workflow-resolver.test.ts › forRepo`
- **Depends on:** —
- **One-way door:** none
- **Model:** top

### D1: App bundle: ship the plugin, env to the server, notices
- **Scope:** `workflowsRoot(place)` beside `hooksPluginDir`, and `OPENAFLOW_WORKFLOWS_DIR` in the server env (§1). `extraResources` copies `../workflow/dist/claude-pod` to `workflows/claude-pod`, dot folders included. The install check lists the new parts. The release check fails on any `pod-docs` under `resources/workflows`. `pnpm package` stops with `run pnpm build first: packages/workflow/dist/claude-pod is missing` when the folder is missing. The notices list claude-pod with its version and its MIT `LICENSE`. Change the size limits only if a real package needs it. Add the bump note to the release checklist in `installer-and-updates.md`: bump only when wanted (`pnpm bump-workflow <tag>`), then smoke `init`, `plan`, and `task` in a test repo.
- **Files owned:** `packages/desktop/src/pty-host-launch.ts`, `packages/desktop/src/pty-host-launch.test.ts`, `packages/desktop/src/server-launch.ts`, `packages/desktop/src/server-launch.test.ts`, `packages/desktop/src/build-config.ts`, `packages/desktop/src/build-config.test.ts`, `packages/desktop/src/install-check.ts`, `packages/desktop/src/install-check.test.ts`, `packages/desktop/src/licence-notices.ts`, `packages/desktop/src/licence-notices.test.ts`, `packages/desktop/scripts/package.ts`, `packages/desktop/src/release-rules.ts`, `pod-docs/feature-details/desktop.md`, `pod-docs/feature-details/installer-and-updates.md`
- **Success criteria:**
  - `[test] workflowsRoot is <resources>/workflows packaged and <appPath>/../workflow/dist unpackaged — packages/desktop/src/pty-host-launch.test.ts › workflowsRoot`
  - `[test] the server env holds OPENAFLOW_WORKFLOWS_DIR, and an inherited value is replaced — packages/desktop/src/server-launch.test.ts › workflows dir env`
  - `[test] extraResources copies the workflow dist to workflows/claude-pod, with a filter that keeps dot folders — packages/desktop/src/build-config.test.ts › ships the workflow`
  - `[test] missingParts names workflows/claude-pod/.claude-plugin/plugin.json, its LICENSE, and the template README when absent — packages/desktop/src/install-check.test.ts › workflow parts`
  - `[test] a pod-docs under resources/workflows fails the release check, naming the file — packages/desktop/src/install-check.test.ts › leftover pod-docs fails`
  - `[test] workflowNotice titles claude-pod with its version and holds its LICENSE text; a missing dist throws the pnpm build message — packages/desktop/src/licence-notices.test.ts › workflow notice`
  - `[manual] the release checklist names the bump command and the smoke run — read pod-docs/feature-details/installer-and-updates.md`
- **Depends on:** —
- **One-way door:** none
- **Model:** sonnet

### S2: Queue writes go to the entry's state folder
- **Scope:** §5 in `queue-writer.ts` and in both routes of `answer-routes.ts` (`answer` and `resolve`). Keep every other guard.
- **Files owned:** `packages/server/src/queue-writer.ts`, `packages/server/src/queue-writer.test.ts`, `packages/server/src/answer-routes.ts`, `packages/server/src/answer-routes.test.ts`, `packages/server/src/resolve-routes.test.ts`, `pod-docs/feature-details/actions.md`
- **Success criteria:**
  - `[test] an answer writes <stateDir>/handoff-queue.md of a workflow state folder — packages/server/src/queue-writer.test.ts › writes the state folder queue`
  - `[test] the pod-docs path works as before — packages/server/src/queue-writer.test.ts › pod-docs queue`
  - `[test] a stateDir outside the two shapes fails and writes nothing — packages/server/src/queue-writer.test.ts › bad stateDir`
  - `[test] a state queue whose real path leaves the repo is not touched — packages/server/src/queue-writer.test.ts › state queue outside the repo`
  - `[test] the answer goes to the matched entry's folder, and a stateDir in the request counts for nothing — packages/server/src/answer-routes.test.ts › answer goes to its folder`
  - `[test] a line answerable in two state folders → changed, the two-entries message, nothing written — packages/server/src/answer-routes.test.ts › same line in two folders`
  - `[test] Close and Keep write to the entry's state folder — packages/server/src/resolve-routes.test.ts › resolve goes to its folder`
- **Depends on:** M1
- **One-way door:** none
- **Model:** top

### S3: Session start with the workflow plugin; sideload stop; Board version
- **Scope:** §6 and §7. `sessionCommand` and `resumeCommand` take `workflowDir`. The session routes take the resolver. A new `managed-settings.ts`. `board-service` sets `Board.workflow` and `HostedSession.blocked`. `start-server.ts` reads `OPENAFLOW_WORKFLOWS_DIR`, makes one resolver, and passes it to the board service, the session routes, and the settings deps. Update the Electron tests that pin the arg list (they need F1's dist and D1's env after `pnpm build`). Add one gated real-`claude` proof that skips without `OPENAFLOW_REAL_CLAUDE=1` and `OPENAFLOW_REAL_CLAUDE_CONFIG_DIR`, as `real-claude-start.test.ts` does.
- **Files owned:** `packages/server/src/session-command.ts`, `packages/server/src/session-command.test.ts`, `packages/server/src/session-routes.ts`, `packages/server/src/session-routes.test.ts`, `packages/server/src/settings-routes.ts`, `packages/server/src/settings-routes.test.ts`, `packages/server/src/run-wrapper.test.ts`, `packages/server/src/managed-settings.ts` (new), `packages/server/src/managed-settings.test.ts` (new), `packages/server/src/board-service.ts`, `packages/server/src/board-service.test.ts`, `packages/server/src/start-server.ts`, `packages/server/src/start-server.test.ts`, `packages/desktop/src/real-session.test.ts`, `packages/desktop/src/real-resume.test.ts`, `packages/desktop/src/real-settings.test.ts`, `packages/pty-host/test/real-workflow-start.test.ts` (new), `pod-docs/feature-details/hosted-sessions.md`
- **Success criteria:**
  - `[test] new session args are --session-id, --plugin-dir hooks, --plugin-dir workflow, then the prompt — packages/server/src/session-command.test.ts › two plugin dirs`
  - `[test] resume args hold both plugin dirs and no prompt — packages/server/src/session-command.test.ts › resume two plugin dirs`
  - `[test] a relative workflow dir → bad path; a CMD_UNSAFE character in it with a Windows cmd shim → unsafe claude path — packages/server/src/session-command.test.ts › workflow dir rules`
  - `[test] New session passes the repo's resolved workflow folder — packages/server/src/session-routes.test.ts › starts with the workflow`
  - `[test] New session and Resume in a repo with no .openaflow/ start with the hooks plugin only (today's args), even with no bundle — packages/server/src/session-routes.test.ts › not set up starts as today`
  - `[test] no bundle, or only unknown sources → 409 workflow missing, with no record and no log entry — packages/server/src/session-routes.test.ts › workflow missing`
  - `[test] Resume starts with the workflow folder — packages/server/src/session-routes.test.ts › resume with the workflow`
  - `[test] the settings preview shows both --plugin-dir flags — packages/server/src/settings-routes.test.ts › preview shows both plugin dirs`
  - `[test] the managed settings path per platform — packages/server/src/managed-settings.test.ts › path per platform`
  - `[test] Board.workflow is the bundle's source and version, and absent with no bundle — packages/server/src/board-service.test.ts › board workflow`
  - `[test] an ended, unhooked, unprompted session with disableSideloadFlags true → blocked sideload — packages/server/src/board-service.test.ts › sideload blocked`
  - `[test] a missing, invalid, or false setting, or a live or hooked session → no blocked; with no such session the file is not read — packages/server/src/board-service.test.ts › sideload edges`
  - `[test] OPENAFLOW_WORKFLOWS_DIR reaches the Board and the session routes — packages/server/src/start-server.test.ts › workflows dir wired`
  - `[test] in the real app, a new session starts the fake claude with both plugin dirs — packages/desktop/src/real-session.test.ts › two plugin dirs`
  - `[test] in the real app, a resume passes both plugin dirs — packages/desktop/src/real-resume.test.ts › resume args`
  - `[test] real claude with both plugin dirs runs /pod:idea in a set-up temp repo, writes only under .openaflow/workflows/claude-pod/state/, and its hook file gets a SessionStart line (skips without the env) — packages/pty-host/test/real-workflow-start.test.ts › bundled workflow writes the state folder`
- **Depends on:** M1, S1, F1, D1
- **One-way door:** none
- **Model:** top

### R1: Setup and Use-version routes; README
- **Scope:** §8 in a new `setup-routes.ts`, mounted in `start-server.ts` with S3's resolver. `POST /api/repos` adds `openaflow`. README: replace "it never writes inside a repo" with what the app writes and when (`.openaflow/` after you agree, and the queue line). Fold in queue entry 2026-11-05 on the README: add `packages/desktop` and `packages/workflow` to `## Layout`, and fix the `## Add repos` line.
- **Files owned:** `packages/server/src/setup-routes.ts` (new), `packages/server/src/setup-routes.test.ts` (new), `packages/server/src/app.ts`, `packages/server/src/app.test.ts`, `packages/server/src/start-server.ts`, `packages/server/src/start-server.test.ts`, `README.md`, `pod-docs/feature-details/actions.md`, `packages/model/src/actions.ts`, `packages/server/src/action-log.ts`, `packages/server/src/action-log.test.ts`, `packages/web/src/screens/runs/action-log-view.ts`
- **NOTE for R1 (from M1, 2026-11-24):** M1 left `setup-workflow` and `use-workflow-version` out of the `ActionEntry` union in `packages/model/src/actions.ts`. Add them here, together with `created` and `updated` in `action-log-view.ts` `OUTCOME_CLS`, and teach `action-log.ts` `parseEntry` to read both back. The result types (`SetupWorkflowResult`, `UseWorkflowVersionResult`) already exist.
- **Success criteria:**
  - `[test] setup writes workflow.json at the bundled version and copies the template as state/ — packages/server/src/setup-routes.test.ts › creates .openaflow`
  - `[test] a path on neither the Board nor the config → 404 not a repo — packages/server/src/setup-routes.test.ts › not a repo`
  - `[test] .openaflow as a folder, a file, or a link → 409 already set up, nothing changed — packages/server/src/setup-routes.test.ts › already set up`
  - `[test] no bundle or no template → 409 workflow missing — packages/server/src/setup-routes.test.ts › workflow missing`
  - `[test] a copy that fails midway leaves no .openaflow and no temp folder → 500 setup failed — packages/server/src/setup-routes.test.ts › failed copy leaves nothing`
  - `[test] a second setup while one runs → 409 setup in progress — packages/server/src/setup-routes.test.ts › one at a time`
  - `[test] setup logs setup-workflow and rebuilds before it answers — packages/server/src/setup-routes.test.ts › logs and rebuilds`
  - `[test] Use sets the version and keeps source and every other key — packages/server/src/setup-routes.test.ts › use rewrites version`
  - `[test] Use with the same version → 409 already current; bad JSON or a link out of the repo → 409 workflow.json unreadable; an unknown name → 404 not a workflow — packages/server/src/setup-routes.test.ts › use edges`
  - `[test] both routes refuse a missing token or a foreign Origin — packages/server/src/setup-routes.test.ts › behind the action guard`
  - `[test] POST /api/repos answers 201 with openaflow true or false — packages/server/src/app.test.ts › add repo reports openaflow`
  - `[test] the setup routes are mounted with the resolver from OPENAFLOW_WORKFLOWS_DIR — packages/server/src/start-server.test.ts › setup routes wired`
  - `[manual] README no longer says the app never writes inside a repo, and its Layout lists packages/desktop and packages/workflow — read README.md`
- **Depends on:** M1, S1, S3
- **One-way door:** none
- **Model:** top

### T1: Terminal tab: the sideload stop line
- **Scope:** §7's stop line in the Terminal tab's stop bar for a session with `blocked: 'sideload'`, with `disableSideloadFlags` in mono. Other ended and stopped sessions read as today.
- **Files owned:** `packages/web/src/screens/runs/terminal-tab.ts`, `packages/web/src/screens/runs/terminal-tab.test.ts`, `packages/web/src/screens/runs/TerminalTab.tsx`, `packages/web/src/screens/runs/terminal.css`
- **Success criteria:**
  - `[test] a blocked session's stop line names disableSideloadFlags, offers no Resume, and keeps Dismiss — packages/web/src/screens/runs/terminal-tab.test.ts › sideload stop line`
  - `[test] an ended session with no blocked field reads as before — packages/web/src/screens/runs/terminal-tab.test.ts › other ends unchanged`
  - `[manual] the stop line wraps cleanly at desktop width and at 375 px — the desktop shell with a fake claude that exits 1 and a managed settings file at the injected path`
- **NOTE for T1 (from S3, 2026-11-24):** a `blocked: 'sideload'` session still carries `resume` on the Board, and the Resume route still accepts it. Hide Resume in the page when `blocked` is set (§7).
- **Depends on:** M1, S3
- **One-way door:** none
- **Model:** sonnet

### N1: New session: bare names, init, version line, mismatch, setup offer
- **Scope:** §9 except the Add repo confirm. The skills change lives in `packages/model/src/skills.ts`. Thread `Board.workflow` from `RunsScreen`. **Use <y>** and **Set up** post through `postAction`. Map the new route errors (`workflow missing`, `already set up`, `already current`, `setup in progress`) to short words in the start errors, and a stale token to `RELOAD`. The start card and `menuRepo` follow §9's reach rule. Drop `POD_INSTALL` from `view.ts` and `RunsScreen.tsx`. Logic goes in `.ts` files; components only wire it.
- **Files owned:** `packages/model/src/skills.ts`, `packages/model/test/skills.test.ts`, `packages/web/src/screens/runs/new-session-flow.ts`, `packages/web/src/screens/runs/new-session-flow.test.ts`, `packages/web/src/screens/runs/NewSessionForm.tsx`, `packages/web/src/screens/runs/NewSessionDialog.tsx`, `packages/web/src/screens/runs/new-session.css`, `packages/web/src/screens/runs/next-step.ts`, `packages/web/src/screens/runs/next-step.test.ts`, `packages/web/src/screens/runs/view.ts`, `packages/web/src/screens/runs/view.test.ts`, `packages/web/src/screens/runs/action-log-view.ts`, `packages/web/src/screens/runs/action-log-view.test.ts`, `packages/web/src/screens/runs/RunsScreen.tsx`, `pod-docs/feature-details/runs-and-pipeline.md`
- **Success criteria:**
  - `[test] SKILLS order, bare names, and init's command /pod:init; isSkillId accepts init — packages/model/test/skills.test.ts › bare names and init`
  - `[test] skillItems lists init, plan, ship, task, research, idea, then Plain session, with bare names and no /pod: — packages/web/src/screens/runs/new-session-flow.test.ts › bare skill names`
  - `[test] versionLine reads "Workflow: claude-pod 0.11.10" for a set-up repo, and is absent with no Board.workflow or no .openaflow/ — packages/web/src/screens/runs/new-session-flow.test.ts › version line`
  - `[test] workflowNotice gives the mismatch text and the Use label; none when the versions are equal, the version is unset, or the repo has no .openaflow/ — packages/web/src/screens/runs/new-session-flow.test.ts › mismatch notice`
  - `[test] Use posts use-workflow-version with repoId and name; a refusal shows its words and keeps the form — packages/web/src/screens/runs/new-session-flow.test.ts › use version`
  - `[test] the setup offer shows only without model.openaflow, New session stays on there, and Set up posts setup-workflow with the repo path — packages/web/src/screens/runs/new-session-flow.test.ts › setup offer`
  - `[test] a repo without .openaflow/, with or without docs, gets the start card and menuRepo — packages/web/src/screens/runs/next-step.test.ts › setup start card`
  - `[test] the empty message of a repo with no docs and no .openaflow/ is the set-up line, with no pod install steps — packages/web/src/screens/runs/view.test.ts › no workflow message`
  - `[test] /pod:init reads Map the project in the action log — packages/web/src/screens/runs/action-log-view.test.ts › init label`
  - `[manual] the version line, the mismatch line with Use, and the setup offer match the plan's Look at desktop width and at 375 px — pnpm dev with OPENAFLOW_WORKFLOWS_DIR set, one fixture copy set up and its workflow.json at 0.0.1, one not set up`
- **NOTE for N1 (from R1, 2026-11-24):** a failed Use write answers `500 {"error":"update failed: <code>"}`; map it to short words like the other route errors. `action-log-view.ts` gained the `created` and `updated` chips (`s-ok`) with no test; add one in `action-log-view.test.ts`. Log targets: `.openaflow/workflows/claude-pod · <version>` (setup) and `.openaflow/workflows/<name> · <old or "no version"> → <bundled>` (Use).
- **Depends on:** M1, S3, R1
- **One-way door:** none
- **Model:** top

### A1: Add repo: ask to create `.openaflow/`
- **Scope:** §9's Add repo confirm. After a `201` with `openaflow: false`, the modal moves to the confirm step instead of closing. **Create** posts `setup-workflow { path }` through `postAction`, and success closes. **Not now** closes and writes nothing. A failure shows its words in the modal's alert box and keeps the confirm step; the repo stays added. A `201` with `openaflow: true`, or with no `openaflow` field, closes as today. One post at a time, as today.
- **Files owned:** `packages/web/src/screens/runs/add-repo-flow.ts`, `packages/web/src/screens/runs/add-repo-flow.test.ts`, `packages/web/src/screens/runs/AddRepoDialog.tsx`, `packages/web/src/add-repo.ts`, `packages/web/src/add-repo.test.ts`
- **Success criteria:**
  - `[test] a 201 with openaflow false → the confirm step, not closed — packages/web/src/screens/runs/add-repo-flow.test.ts › asks after add`
  - `[test] Create posts setup-workflow with the added path and closes on 200 — packages/web/src/screens/runs/add-repo-flow.test.ts › create sets up`
  - `[test] Not now closes and posts nothing — packages/web/src/screens/runs/add-repo-flow.test.ts › not now writes nothing`
  - `[test] a failed setup shows its words, keeps the confirm step, and Create works again — packages/web/src/screens/runs/add-repo-flow.test.ts › setup failure`
  - `[test] a 201 with openaflow true, or with no field, closes as before — packages/web/src/screens/runs/add-repo-flow.test.ts › already set up closes`
  - `[test] AddResult reads the openaflow field — packages/web/src/add-repo.test.ts › openaflow field`
  - `[manual] the confirm step, with its facts list and buttons, follows DESIGN.md "Forms and errors" at desktop width and at 375 px — pnpm dev, Add repo on a fresh folder`
- **NOTE for A1 (from R1, 2026-11-24):** `POST /api/repos` answers `openaflow: true` also when the repo folder can't be read, so the page never offers a setup that would fail. Only `openaflow: false` gets the confirm.
- **Depends on:** R1
- **One-way door:** none
- **Model:** sonnet

## Sprint summary
- **Synced with merge-target:** up to date (no new `pod-staging` commits during the sprint)
- **Slices shipped:** F1, M1, S1, D1, S2, S3, R1, T1, N1, A1, plus one wave 4 fix
- **Queue entries:** resolved 1 (Set up hides `pod-docs/` runs → warning added, decision 2026-11-24), deferred 21 (`handoff-queue.md`, `plan: default-workflow`, 2026-11-24)
- **Human decisions during the sprint:** a repo without `.openaflow/` starts sessions as today (wave 2); Add repo sets up with no question unless the repo has `pod-docs/` (wave 4 hands-on test). Both in `decisions.md`.
- **Slice log:**
  - F1: top · medium · test-first yes · runtime real `pnpm build` (clone v0.11.10) and `bump-workflow` · 1 NOTE · time lost none
  - M1: top · medium · test-first yes · runtime board on a `pod-docs` fixture · 2 NOTEs · time lost none
  - S1: top · medium · test-first yes · runtime board while `.openaflow` appears and goes · 6 NOTEs · time lost ~5 min (watcher depth race)
  - D1: sonnet · medium · test-first yes · runtime none (unit only; dist not on its branch) · 3 NOTEs · time lost none; resumed once to own `release-check.ts`
  - S2: top · medium · test-first partly (one criterion guards old behavior) · runtime answer/keep/close by curl and page · 3 NOTEs · time lost ~5 min (zsh word splitting)
  - S3: top · medium · test-first partly (gated real-`claude` test never ran) · runtime Electron tests with the fake `claude` · 4 NOTEs · time lost none
  - R1: top · medium · test-first yes · runtime setup and Use routes on `pnpm start` · 4 NOTEs · time lost none; resumed once to own `docs/development.md`
  - T1: sonnet · medium · test-first yes · runtime static page from real markup (no desktop path) · 2 NOTEs · time lost none
  - N1: top · medium · test-first yes · runtime real desktop app via CDP · 2 NOTEs · time lost none; BLOCKED once on three unowned tests, resumed to own them
  - A1: sonnet · medium · test-first yes · runtime browser build · 2 NOTEs · time lost ~1 min
  - Wave 4 fix (human change request from hands-on test): top · medium · test-first yes · runtime desktop app via CDP · time lost ~1 min (ETXTBSY)
  - No stalls. One Electron run per wave hit `spawn ETXTBSY` after a fresh install; a re-run passed.
- **Agent context at hand-back:** about 1.78 M tokens summed over the 11 engineer hand-backs (each agent's final context size, not tokens billed)
