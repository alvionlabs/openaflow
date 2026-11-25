# Idea: Rework the setup dialogs

Status: parked

## The idea
Redesign the two dialogs that set up `.openaflow/` in a repo:
- The Add repo confirm "Create `.openaflow/` in this repo?", with its Details (Folder, Creates) and the warning "Its pod-docs/ runs will no longer show on the board.", and **Not now** / **Create**.
- The "Repo added · Created .openaflow/workflows/claude-pod/" box, which shows after a no-question setup and closes itself after 3 s. A status line in the main screen could replace it (queue entry 2026-11-24, W4-fix).

New session's **Set up** offer uses the same words, so a rework covers it too. Seen in the hands-on test of plan `default-workflow`, wave 4 (PR https://github.com/alvionlabs/openaflow/pull/165).

## Why it's on hold
The dialogs work as specified, and plan `default-workflow` ships them as they are. The human wants to rework their look and flow later.

## What would make it worth building
not given
