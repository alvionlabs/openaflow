# Workflow

## What it is

`packages/workflow` (`@openaflow/workflow`) makes the default workflow that the app ships: claude-pod's plugin at one pinned release, with its state folder renamed from `pod-docs` to `.openaflow/workflows/claude-pod/state`. It has no runtime exports. It owns the lock, the `pnpm bump-workflow <tag>` command, and the workflow build that `pnpm build` runs. The app bundle (`packages/desktop`), the workflow resolver, and the session start use its output; see [desktop.md](desktop.md), [server.md](server.md), and [hosted-sessions.md](hosted-sessions.md). The contract is in `pod-docs/sprints/default-workflow.md`, §1 and §2.

## How it works

- **Lock.** `packages/workflow/workflow.lock.json` holds exactly `{ "repo", "tag", "commit" }`, in that order, as 2-space JSON with a final newline. `repo` is an https git URL with no user name, password, query, or fragment. `tag` matches `v<major>.<minor>.<patch>`, with no leading zero. `commit` is 40 lowercase hex characters. `readLock` refuses a bad field or an extra key, and the error names it. The first pin is `https://github.com/iamphduc/claude-pod.git` at `v0.11.10` (`80bd2f78127a287b3de6432ed54b84c9e0edb805`).
- **Bump.** `pnpm bump-workflow <tag>` (root) runs `pnpm --filter @openaflow/workflow bump <tag>`. A tag outside the rule is refused before git runs. It runs `git ls-remote <repo> refs/tags/<tag> refs/tags/<tag>^{}`; for an annotated tag, the peeled `^{}` line wins. It writes only the lock, through a temp file and a rename, and keeps the lock's `repo`. An unknown tag, an unreachable repo, or a bad lock exits 1, and the lock stays byte for byte. Options: `--lock <path>` (another lock file) and `--repo <url or path>` (another git source; the lock's `repo` stays). Tests use these with local repos in temp folders, never the network.
- **Build.** `pnpm build` runs the package's `build` script (`scripts/build.ts`). When `dist/claude-pod.stamp.json` holds exactly the lock's text and `dist/claude-pod/.claude-plugin/plugin.json` exists, it prints `the workflow plugin is current` and makes no git call. Else it removes the old output and stamp, checks `git --version`, clones the tag (`--depth 1 --branch <tag>`) into an OS temp folder, and fails unless `git rev-parse HEAD` is the lock's commit (the message names both commits). The temp clone goes in every case.
- **Transform.** It copies only `.claude-plugin/`, `skills/`, `agents/`, `docs/`, and `LICENSE`; each one must exist. In each file that is valid UTF-8, each `pod-docs` becomes `.openaflow/workflows/claude-pod/state`. Other files are copied byte for byte. In each path, a segment that is exactly `pod-docs` becomes those four segments. Both matches are case-sensitive.
- **Checks.** The build fails when an output path or file's bytes hold `pod-docs` (the message names each one), when `plugin.json` is missing, is not JSON, or has a `version` other than the tag's version, when the template state `skills/init/scaffold/.openaflow/workflows/claude-pod/state/` is missing, when the source holds a link, or when two source files become one path after the rename.
- **All or nothing.** It builds in `dist/.claude-pod.tmp-<random>`, beside the output, so the rename never crosses file systems. After the checks pass, it renames that folder to `dist/claude-pod` and then writes the stamp, last. A failure removes the temp folder, so it leaves no `dist/claude-pod` and no stamp.
- **Output.** `packages/workflow/dist/` is git-ignored. `dist/claude-pod/` holds only the five parts. `OPENAFLOW_WORKFLOWS_DIR` names the folder that holds `claude-pod/`; for `pnpm dev` and `pnpm start` that is `<repo>/packages/workflow/dist`.

## Why it's this way

- claude-pod's repo stays the one source (decision 2026-11-22). The app pins a commit as well as a tag, so a moved tag fails the build instead of shipping other code.
- The stamp holds the whole lock text, so any change to the lock (even the repo) builds again, and an offline `pnpm build` works once the output exists.
- Files that are not UTF-8 are not rewritten, because a byte rename could break a binary file. The leftover check scans raw bytes, so such a file with `pod-docs` in it still fails the build.
- Links are refused, because a link could copy a file from outside the checkout into the app.

## Watch out

- A fresh checkout needs `git` and the network for the first `pnpm build`. With no `git` on `PATH` the build fails with `git not found: the workflow build needs git`.
- Bump only when you want a new claude-pod. After `pnpm bump-workflow <tag>`, run `pnpm build` and smoke `init`, `plan`, and `task` in a test repo.
- A new claude-pod release that drops one of the five parts, or adds a path such as `pod-docs-old`, fails the build on purpose. Read what changed before you change the rules.

## History

- 2026-11-23 · default-workflow F1 · added: the `@openaflow/workflow` package, the lock pinned to claude-pod `v0.11.10`, `pnpm bump-workflow <tag>`, and the fetch and transform build in `pnpm build`.
