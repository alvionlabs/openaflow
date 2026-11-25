# Idea: OpenAFlow names for `pod-ports` and `pod-staging`

Status: parked

## The idea
Give the port claim folder (`<temp>/pod-ports`, set by `OPENAFLOW_PORTS_DIR`) and the staging branch (`pod-staging`, read in `packages/model` formats) OpenAFlow names. The bundled workflow would need the same rename in the build-time transform of plan `default-workflow`.

## Why it's on hold
The human, 2026-11-23: "keep everything as is, we can change them later." Shared port claims also stop a hosted run and a claude-pod run from taking the same port.

## What would make it worth building
OpenAFlow no longer runs beside claude-pod, or the `pod` names confuse users.
