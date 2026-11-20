// Glue: the pty host in a second `utilityProcess`, run by the starter. The logic is in pty-host-starter.ts and
// pty-host-launch.ts. A host that fails for good leaves the board running: terminals answer `terminals unavailable`.

import { dirname } from 'node:path'
import { utilityProcess, type MessagePortMain } from 'electron'
import { ptyHostEnv } from './pty-host-launch.ts'
import { createPtyHostStarter, type HostProcess, type PtyHostStarter } from './pty-host-starter.ts'
import { PTY_HOST_SERVICE_NAME } from './shell-config.ts'

function forkHost(entry: string, env: NodeJS.ProcessEnv): HostProcess {
  const child = utilityProcess.fork(entry, [], {
    stdio: 'pipe',
    cwd: dirname(entry),
    env: ptyHostEnv(env),
    serviceName: PTY_HOST_SERVICE_NAME,
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', (text: string) => console.log(text.trimEnd()))
  }
  // An `exit` always follows, and an `error` with no listener would throw in the main process.
  child.on('error', () => {})
  return {
    get pid() {
      return child.pid
    },
    postMessage: (m, transfer) => child.postMessage(m, transfer as MessagePortMain[] | undefined),
    kill: () => child.kill(),
    onMessage: (fn) => void child.on('message', fn),
    onExit: (fn) => void child.on('exit', fn),
  }
}

/** Made at the start; `start()` forks the first host. */
export function createPtyHost(o: { entry: string; env: NodeJS.ProcessEnv }): PtyHostStarter {
  return createPtyHostStarter({ fork: () => forkHost(o.entry, o.env), log: (line) => console.log(line) })
}
