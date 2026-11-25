# Idea: Sprint planner gives slices the tests that pin what they change

Status: parked

## The idea
A pod-side change (claude-pod's `sprint-planner`). When a slice changes a behavior on purpose, the planner searches the repo for tests and files that pin the old behavior, and puts them in that slice's **Files owned**. Examples: an assertion on old text, a key press that picked the old first option, or a script that must call a new check. Otherwise the engineer reaches a gate that fails in a file it may not touch, and stops `BLOCKED` until the orchestrator gives it the file.

In plan `default-workflow` this happened three times:
- D1 needed `packages/desktop/scripts/release-check.ts`.
- R1 needed `docs/development.md`.
- N1 needed `bar-menu.test.ts`, `runs-screen.test.ts`, and `real-terminal-tab.test.ts`.

Each one cost a resume of the engineer.

## Why it's on hold
It is a change in claude-pod, not OpenAFlow. OpenAFlow makes no change in claude-pod (decision 2026-11-22), so it waits for work on claude-pod itself.

## What would make it worth building
not given
