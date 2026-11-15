// Glue: the pty host's entry, run by Electron as a utilityProcess (dist/pty-host.cjs). The logic is in service.ts.

import { statSync } from 'node:fs'
import { scrollbackFrom } from './host-config.ts'
import { startPtyHost, type PtyModule } from './service.ts'

type ParentPort = { on(event: 'message', fn: (e: { data: unknown; ports?: unknown[] }) => void): void; postMessage(message: unknown): void }

const parentPort = (process as { parentPort?: ParentPort }).parentPort
if (parentPort === undefined) {
  console.error('openaflow pty host: no parentPort; start it with utilityProcess.fork')
  process.exit(1)
}

const { scrollback, log } = scrollbackFrom(process.env)
if (log !== undefined) console.log(log)

const host = startPtyHost({
  // Resolved from the bundle's folder: node_modules/node-pty beside it, packaged and in dev.
  loadPty: () => require('node-pty') as PtyModule,
  send: (m) => parentPort.postMessage(m),
  exit: (code) => process.exit(code),
  isDir: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
  scrollback,
})
// `connect` carries a window's MessagePort in the event's ports.
parentPort.on('message', (e) => host.handle(e.data, e.ports))
