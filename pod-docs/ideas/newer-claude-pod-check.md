# Idea: Flag a newer claude-pod tag

Status: parked

## The idea
A CI check that compares the workflow lock (plan `default-workflow`) with claude-pod's newest tag and flags when a newer one exists. It only informs; the bump stays a hand step with `bump-workflow <tag>`.

## Why it's on hold
The human bumps only when OpenAFlow wants to, not to follow claude-pod (2026-11-23). claude-pod releases about twice a day, so the check would be noisy.

## What would make it worth building
A claude-pod fix that OpenAFlow needed went unnoticed for a long time.
