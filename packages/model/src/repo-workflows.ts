// The workflows a repo holds, read from the keys the server puts in its RepoFiles map.
// Pure: it takes the files' text, never reads them.
// The rules and why are in pod-docs/feature-details/run-model.md.

import type { RepoFiles } from './run-model.ts'

/**
 * One workflow of a repo. `stateDir` is the repo-relative folder its pod docs live in. `legacy`: the repo has no
 * `.openaflow/` folder, so its docs are `pod-docs/`. `source` and `version` come from its `workflow.json`, each only
 * when it meets its rule.
 */
export type RepoWorkflow = { name: string; stateDir: string; source?: string; version?: string; legacy?: true }

/** A workflow folder's name, and a `source` in `workflow.json`. */
export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A `version` in `workflow.json`: `x.y.z`, digits with no leading zero. */
export const WORKFLOW_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const OPENAFLOW_KEY = '.openaflow/'
const FOLDER_KEY = /^\.openaflow\/workflows\/([^/]+)\/$/

/**
 * No `.openaflow/` key → the one legacy `pod-docs` workflow. With it → one workflow per
 * `.openaflow/workflows/<name>/` key whose name meets the rule, sorted by name (none → an empty list).
 */
export function repoWorkflows(files: RepoFiles): RepoWorkflow[] {
  const keys = new Map<string, string>()
  for (const [key, text] of Object.entries(files)) keys.set(key.replaceAll('\\', '/'), text)
  if (!keys.has(OPENAFLOW_KEY)) return [{ name: 'pod-docs', stateDir: 'pod-docs', legacy: true }]

  const names: string[] = []
  for (const key of keys.keys()) {
    const name = FOLDER_KEY.exec(key)?.[1]
    if (name !== undefined && WORKFLOW_NAME.test(name)) names.push(name)
  }
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((name) => {
    const workflow: RepoWorkflow = { name, stateDir: `.openaflow/workflows/${name}/state` }
    const meta = readMeta(keys.get(`.openaflow/workflows/${name}/workflow.json`))
    if (typeof meta.source === 'string' && WORKFLOW_NAME.test(meta.source)) workflow.source = meta.source
    if (typeof meta.version === 'string' && WORKFLOW_VERSION.test(meta.version)) workflow.version = meta.version
    return workflow
  })
}

/** The `workflow.json` object; missing, unparseable, or not an object → empty. */
function readMeta(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {}
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
