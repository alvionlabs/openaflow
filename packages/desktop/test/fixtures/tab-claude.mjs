#!/usr/bin/env node
// A fake `claude` for real-terminal-tab.test.ts (sprint terminal-tab §9). It prints its args, appends a `SessionStart`
// line for its `--session-id` (or its `--resume`, with source `resume`) to `$OPENAFLOW_HOOKS_DIR/$OPENAFLOW_RUN.jsonl`
// as the hooks plugin would, then answers each line it reads with `got:<line>`. The line `bye` ends it with code 0.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const at = args.indexOf('--session-id')
const resumed = args.indexOf('--resume')
const session = at >= 0 ? args[at + 1] : resumed >= 0 ? args[resumed + 1] : undefined
const source = at >= 0 ? 'startup' : 'resume'
process.stdout.write(`tab-claude args: ${JSON.stringify(args)}\r\n`)

const dir = process.env.OPENAFLOW_HOOKS_DIR
const run = process.env.OPENAFLOW_RUN
if (dir && run && session) {
  mkdirSync(dir, { recursive: true })
  const line = { v: 1, at: Date.now(), payload: { hook_event_name: 'SessionStart', session_id: session, source } }
  appendFileSync(join(dir, `${run}.jsonl`), `${JSON.stringify(line)}\n`)
}
process.stdout.write('ready> ')

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'bye') {
    process.stdout.write('bye\r\n')
    process.exit(0)
  }
  process.stdout.write(`got:${line}\r\nready> `)
})
