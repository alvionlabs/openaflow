# Idea: Drop `pod-docs/` support

Status: parked

## The idea
Remove the `pod-docs/` fallback, so the board reads only `.openaflow/`. Plan `default-workflow` reads `pod-docs/` only in repos that have no `.openaflow/`. Remove the shared folder picker's fallback branch and its tests in `packages/model` and `packages/server`.

## Why it's on hold
The human, 2026-11-23: "we will eventually drop the support." Repos still on claude-pod, including this repo's own history, would leave the board.

## What would make it worth building
This repo and your other repos develop with OpenAFlow and have `.openaflow/`.
