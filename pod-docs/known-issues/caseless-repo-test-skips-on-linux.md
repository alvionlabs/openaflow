# The caseless repo test skips on Linux

_Found: 2026-11-14 · sprint host-core (`board-service.test.ts`)_

**Symptom:** on Linux, `board-service.test.ts › two spellings of one repo on a file system that ignores case are one repo, with no suffix` failed with `expected [ 'registered' ] to deeply equal [ 'both' ]`. It now skips on Linux.

**Cause:** the test registers a repo, writes a claim for the same path in upper case, and fakes `ignoresCase` to `true`. The claim reader (`readClaims` in `claims.ts`) keeps a claim only when its repo folder exists, by a real `stat`. On a case-sensitive file system, the default on Linux, the upper-case path is not a folder, so the claim is dropped and the repo stays `registered`. The product code is correct: on Linux the two spellings are two folders.

**Workaround:** none needed. The test runs on Windows and macOS, whose default file systems ignore case. To run it on Linux, put the temp folder on a file system that ignores case (for example a FAT or `ext4` casefold volume) and remove the `skipIf`.
