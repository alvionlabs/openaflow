// Glue: the pty host in a second `utilityProcess`. The logic is in pty-host-launch.ts. A host that fails leaves the
// board running: the failure is one log line, and terminals answer `terminals unavailable`.

import { dirname } from 'node:path'
import { utilityProcess } from 'electron'
import { createPtyHostClient, hostLogLine, ptyHostEnv, type PtyHostClient } from './pty-host-launch.ts'
import { PTY_HOST_SERVICE_NAME } from './shell-config.ts'

export type PtyHost = { client: PtyHostClient; pid(): number | undefined }

export function forkPtyHost(o: { entry: string; env: NodeJS.ProcessEnv }): PtyHost {
  const child = utilityProcess.fork(o.entry, [], {
    stdio: 'pipe',
    cwd: dirname(o.entry),
    env: ptyHostEnv(o.env),
    serviceName: PTY_HOST_SERVICE_NAME,
  })
  const client = createPtyHostClient((m) => child.postMessage(m))
  child.on('message', (m: unknown) => {
    const line = hostLogLine(m)
    if (line !== undefined) console.log(line)
    client.onMessage(m)
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', (text: string) => console.log(text.trimEnd()))
  }
  // An `exit` always follows, and an `error` with no listener would throw in the main process.
  child.on('error', () => {})
  child.on('exit', (code) => {
    console.log(`openaflow desktop: terminal host exited with code ${code}`)
    client.fail('terminal host exited')
  })
  return { client, pid: () => child.pid }
}
