#!/usr/bin/env node
// A fake `claude` for the hosted-session checks (src/real-session.test.ts; sprint terminal-tab §9). Each test copies
// it into its own temp folder, beside which it works:
// - It appends `{pid, execPath, args}` to `starts.jsonl` there, one line per start.
// - It prints its args, one a line, as `arg <i>: <arg>`, and answers each line it reads with `got:<line>`.
// - Once a `hook-gate` file is there, it appends a `SessionStart` line for its `--session-id` to
//   `$OPENAFLOW_HOOKS_DIR/$OPENAFLOW_RUN.jsonl`, as the hooks plugin would.
// A `-p` start is never a hosted session's: it is recorded, and the program ends at once. It ends on its own after
// 5 minutes, or when its input ends, so a session that a host crash leaves behind doesn't run on.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const here = dirname(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(join(here, 'starts.jsonl'), JSON.stringify({ pid: process.pid, execPath: process.execPath, args }) + '\n')
if (args.includes('-p')) process.exit(0)

process.stdout.write(`fake claude ${process.pid}\r\n`)
args.forEach((arg, i) => process.stdout.write(`arg ${i}: ${arg}\r\n`))
setTimeout(() => process.exit(0), 300_000)

const at = args.indexOf('--session-id')
const session = at >= 0 ? args[at + 1] : undefined
const { OPENAFLOW_HOOKS_DIR: hooks, OPENAFLOW_RUN: run } = process.env
const gate = setInterval(() => {
  if (!existsSync(join(here, 'hook-gate'))) return
  clearInterval(gate)
  if (session === undefined || hooks === undefined || run === undefined) {
    process.stdout.write('no hook line: no --session-id, OPENAFLOW_HOOKS_DIR, or OPENAFLOW_RUN\r\n')
    return
  }
  mkdirSync(hooks, { recursive: true })
  const payload = { session_id: session, hook_event_name: 'SessionStart', source: 'startup', cwd: process.cwd() }
  appendFileSync(join(hooks, `${run}.jsonl`), JSON.stringify({ v: 1, at: Date.now(), payload }) + '\n')
  process.stdout.write('hooked\r\n')
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
