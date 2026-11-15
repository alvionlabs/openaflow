// The terminal checks' program (src/real-terminal.test.ts). It prints `line <n>` every 100 ms from 1, and answers
// each line it reads with `got:<line>`, which the pty's own echo of the keys never shows. It ends on its own after
// 5 minutes, or when its input ends, so a session that a host crash leaves behind doesn't run on.

let n = 0
setInterval(() => process.stdout.write(`line ${++n}\r\n`), 100)
setTimeout(() => process.exit(0), 300_000)

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
