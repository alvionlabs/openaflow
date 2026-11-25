# Idea: Edit or replace the default workflow

Status: parked

## The idea
Let users edit OpenAFlow's default workflow or replace it with their own. This includes a setting that uses an installed claude-pod instead of the bundled copy (Q5 c in plan `default-workflow`). The seam (plan `default-workflow`): each repo has `.openaflow/workflows/<name>/workflow.json`, and a resolver in `packages/desktop` maps its `source` to the bundled folder passed to `--plugin-dir`. A team's edited workflow can go in a `plugin/` folder beside `workflow.json`, which the resolver then loads instead. A workflow picker in New session belongs here too, once a second workflow exists. Also: download the version a repo pins when the app ships another. Research ([default-workflow.md](../research/default-workflow.md)): Claude Code has no per-file override layer; a plugin with the same manifest name replaces the whole plugin. Options there: a read-only bundle plus a user plugin folder (reset = stop passing it), or copy-on-first-run with base hashes (Copier-style update).

## Why it's on hold
Too big for v0.1.0 (decision 2026-11-22). Plan `default-workflow` ships the fixed default first.

## What would make it worth building
Users ask to change steps of the workflow, or you want to develop claude-pod and test it inside OpenAFlow.
