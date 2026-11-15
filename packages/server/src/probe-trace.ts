// PROBE, to be reverted: a file trace of the parent watch and the shutdown, which outlives the dead parent's pipe.

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.OPENAFLOW_CONFIG_DIR
const file = dir ? join(dir, `probe-trace-${process.pid}.log`) : undefined

export function probe(line: string): void {
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A probe never breaks the server.
  }
}

export function probeResources(label: string): void {
  try {
    probe(`${label} resources ${JSON.stringify(process.getActiveResourcesInfo())}`)
  } catch {
    // As above.
  }
}
