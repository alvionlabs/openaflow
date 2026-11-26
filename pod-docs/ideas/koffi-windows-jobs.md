# Idea: Hold the Windows Job Objects in the pty host with koffi

Status: parked

## The idea
An optional Windows add-on. It is not a terminal host: `node-pty` runs Claude Code. The Job Object only ends the processes that Claude Code starts (for example, a dev server) when the app quits.

Today one hidden `powershell.exe` helper, a child of main, holds one job per session. It compiles C# with `Add-Type` (`packages/desktop/src/windows-jobs.ts`). The idea moves the jobs into the pty host and calls the Win32 functions through [koffi](https://koffi.dev/), an FFI library with prebuilt binaries.

The spike branch `spike/terminal-host-windows` (last commit `c0c4e79`, 2026-11-13, now deleted) tested this on Windows 11:

- All 11 spike checks passed with one job per run, held by the pty host. The checks ran with real `claude.exe` and with a fake `claude`.
- Assign gap: 43–60 ms. The helper's gap is about 0.4–0.5 s on a cold start (queue entry W1-fix).
- The jobs end when the host ends, not when the app ends (queue entry D2).
- koffi for `win32_x64` is 1.6 MB. The packaged app loaded it with no node-gyp run. This was not proven on a clean machine.
- In both designs, a process that WMI starts escapes the job.

## Why it's on hold
The human (2026-11-25): "we don't need add one now". The PowerShell helper works, and Windows CI tests it on every PR.

## What would make it worth building
- `Add-Type` fails on a locked-down Windows profile (Constrained Language Mode, AppLocker, or antivirus), so sessions run with no job.
- The W1-fix or D2 gap causes a real problem.
