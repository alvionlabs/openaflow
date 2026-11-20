#!/usr/bin/env node
// A fake `claude` for the settings checks (src/real-settings.test.ts; sprint settings §9). Each test copies it into
// its own temp folder, beside which it works:
// - It appends `{pid, execPath, args}` to `starts.jsonl` there, one line per start.
// - It prints `n <i>` for i from 1 to N, where N comes from `--lines N`: two args, or inside one arg, such as the
//   plain prompt `print --lines 1000` (a plain prompt can't start with `-`, and a Windows shim takes no extra args).
// - Then it prints its args as `settings-claude args: <JSON>`, and answers each line it reads with `got:<line>`.
// It ends on its own after 5 minutes, or when its input ends, so a session that a host crash leaves behind doesn't
// run on.

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const here = dirname(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(join(here, 'starts.jsonl'), JSON.stringify({ pid: process.pid, execPath: process.execPath, args }) + '\n')
setTimeout(() => process.exit(0), 300_000)

/** N from `--lines N`, as two args or inside one; else 0. */
const count = (() => {
  const at = args.indexOf('--lines')
  const word = at >= 0 ? args[at + 1] : args.map((a) => /(?:^|\s)--lines (\d+)(?:\s|$)/.exec(a)?.[1]).find(Boolean)
  const n = Number(word)
  return Number.isInteger(n) && n > 0 ? n : 0
})()
let out = ''
for (let i = 1; i <= count; i++) out += `n ${i}\r\n`
process.stdout.write(out)
process.stdout.write(`settings-claude args: ${JSON.stringify(args)}\r\n`)

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
