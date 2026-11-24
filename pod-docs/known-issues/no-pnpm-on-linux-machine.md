# pnpm is not on PATH on the Linux dev machine

_Found: 2026-11-11 · again in sprint default-workflow_

**Symptom:** `pnpm: command not found`. Node 26 (fnm) ships no corepack, so `corepack enable pnpm` fails too.

**Cause:** pnpm is not installed globally on this machine, and the repo pins `pnpm@11.1.2`.

**Workaround:** use the copy the orchestrator installed for this run. Put it first on PATH in each command: `PATH=/tmp/claude-1000/-home-iamphduc-Documents-Projects-alvionlabs-openaflow/9deb36fd-f2b7-4682-bed0-2f0e1de162b0/scratchpad/pnpm/node_modules/.bin:$PATH pnpm <args>`. Root scripts call `pnpm` inside, so PATH must hold it, not an alias. Don't install pnpm globally. After `pnpm install`, if the Electron binary is missing, run `node node_modules/electron/install.js` in `packages/desktop`.
