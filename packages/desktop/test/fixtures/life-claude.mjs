#!/usr/bin/env node
// A fake `claude` for the quit and Resume checks (src/real-quit.test.ts, src/real-resume.test.ts; sprint session-life
// §10). Each test copies it into its own temp folder, beside which it works:
// - It appends `{pid, execPath, args, cgroup}` to `starts.jsonl` there, one line per start (`cgroup`: Linux's
//   /proc/self/cgroup, so a test sees whether the session runs in its systemd scope).
// - It prints its args as `life-claude args: <JSON>` and writes its `SessionStart` line for its `--session-id`
//   (source `startup`) or its `--resume` (source `resume`) to `$OPENAFLOW_HOOKS_DIR/$OPENAFLOW_RUN.jsonl`, as the
//   hooks plugin would. It answers each line it reads with `got:<line>`.
// - On request: when a `child-gate` file holding a JSON list of kinds shows up, it takes the file and starts each
//   child. `detached` is a detached child with the session's env. `setsid` (Linux) is started through `setsid -f`
//   with an empty env, so it has its own session, is no child of the fake, and holds no OPENAFLOW_RUN. Each child
//   listens on 127.0.0.1 and appends `{kind, pid, port, spawnedAt}` to `children.jsonl` (`spawnedAt`: the fake's
//   clock at the spawn call, so a test can compare it with when the session joined its Windows job).
// Everything ends on its own after 5 minutes, so a leftover never runs on. The fake also ends when its input ends.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'

const LIFE_MS = 300_000
const script = process.argv[1]
const args = process.argv.slice(2)

if (args[0] === '--life-child') child(args[1], args[2], Number(args[3]))
else fake()

function child(kind, here, spawnedAt) {
  setTimeout(() => process.exit(0), LIFE_MS)
  // A probe may close at once: the reset must not end the child.
  const server = createServer((socket) => {
    socket.on('error', () => {})
    socket.end()
  })
  server.listen(0, '127.0.0.1', () => {
    appendFileSync(join(here, 'children.jsonl'), JSON.stringify({ kind, pid: process.pid, port: server.address().port, spawnedAt }) + '\n')
  })
}

function fake() {
  const here = dirname(script)
  let cgroup
  try {
    cgroup = readFileSync('/proc/self/cgroup', 'utf8')
  } catch {
    cgroup = undefined
  }
  appendFileSync(join(here, 'starts.jsonl'), JSON.stringify({ pid: process.pid, execPath: process.execPath, args, cgroup }) + '\n')
  setTimeout(() => process.exit(0), LIFE_MS)
  process.stdout.write(`life-claude args: ${JSON.stringify(args)}\r\n`)

  const at = args.indexOf('--session-id')
  const resumed = args.indexOf('--resume')
  const session = at >= 0 ? args[at + 1] : resumed >= 0 ? args[resumed + 1] : undefined
  const { OPENAFLOW_HOOKS_DIR: hooks, OPENAFLOW_RUN: run } = process.env
  if (session && hooks && run) {
    mkdirSync(hooks, { recursive: true })
    const payload = { session_id: session, hook_event_name: 'SessionStart', source: at >= 0 ? 'startup' : 'resume', cwd: process.cwd() }
    appendFileSync(join(hooks, `${run}.jsonl`), JSON.stringify({ v: 1, at: Date.now(), payload }) + '\n')
  }

  const gate = join(here, 'child-gate')
  setInterval(() => {
    if (!existsSync(gate)) return
    const taken = `${gate}.${process.pid}`
    try {
      renameSync(gate, taken)
    } catch {
      return // Another start took it.
    }
    const kinds = JSON.parse(readFileSync(taken, 'utf8'))
    for (const kind of kinds) startChild(kind, here)
    process.stdout.write(`children asked: ${kinds.join(', ')}\r\n`)
  }, 100)

  let typed = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (text) => {
    typed += text
    // Linux's line discipline turns the Enter key's `\r` into `\n`; Windows' console gives `\r\n`.
    const lines = typed.split(/\r\n|\r|\n/)
    typed = lines.pop() ?? ''
    for (const line of lines) process.stdout.write(`got:${line}\r\n`)
  })
  process.stdin.on('end', () => process.exit(0))
}

function startChild(kind, here) {
  const childArgs = [script, '--life-child', kind, here, String(Date.now())]
  if (kind === 'setsid') {
    const setsid = ['/usr/bin/setsid', '/bin/setsid'].find((p) => existsSync(p))
    if (!setsid) return process.stdout.write('no setsid\r\n')
    spawn(setsid, ['-f', process.execPath, ...childArgs], { env: {}, stdio: 'ignore' }).unref()
    return
  }
  spawn(process.execPath, childArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}
