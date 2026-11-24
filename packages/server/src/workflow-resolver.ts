// Finds the bundled workflow plugin and picks the one a repo's workflows ask for.
// The rules are in pod-docs/feature-details/server.md (Workflow resolver).

import { readFileSync } from 'node:fs'
import path from 'node:path'

/** The sources the app ships. A `source` maps to a folder only through this list; a source string is never joined into a path. */
export const KNOWN_SOURCES = ['claude-pod'] as const
export type WorkflowSource = (typeof KNOWN_SOURCES)[number]
/** The source a workflow with no `source` uses. */
export const DEFAULT_SOURCE: WorkflowSource = 'claude-pod'

/** `x.y.z`, digits only, no leading zero. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** A bundled workflow plugin. `dir` is absolute and goes to `claude --plugin-dir`; `template` is the state folder setup copies. */
export type WorkflowBundle = { source: WorkflowSource; version: string; dir: string; template: string }

export type WorkflowResolver = {
  /** The bundled plugin, or `undefined` when there is none. */
  bundled(): WorkflowBundle | undefined
  /**
   * The bundle for a repo's workflows, taken in the order given (pass `model.workflows`, sorted by name): the first
   * workflow with no `source` or a known one wins. No workflows, or `undefined`, → the default. Only unknown sources,
   * or no bundle → `undefined`.
   */
  forRepo(workflows: readonly { source?: string }[] | undefined): WorkflowBundle | undefined
}

/**
 * `root` is `OPENAFLOW_WORKFLOWS_DIR`, the folder that holds `claude-pod/`. Unset, empty, or relative → no bundle.
 * `<root>/claude-pod/.claude-plugin/plugin.json` must parse to an object whose `version` is `x.y.z`, else no bundle.
 * The file is read at the first call, once, and the result (a missing bundle too) is kept.
 */
export function createWorkflowResolver(o: { root: string | undefined }): WorkflowResolver {
  let loaded = false
  let bundle: WorkflowBundle | undefined
  const bundled = () => {
    if (!loaded) {
      loaded = true
      bundle = readBundle(o.root, DEFAULT_SOURCE)
    }
    return bundle
  }
  return {
    bundled,
    forRepo(workflows) {
      const list = workflows ?? []
      if (list.length === 0) return bundled()
      for (const w of list) {
        if (w.source === undefined) return bundled()
        // Matched against the list, so only the list's own string ever names a folder.
        const known = KNOWN_SOURCES.find((s) => s === w.source)
        if (known !== undefined) return bundled()
      }
      return undefined
    },
  }
}

function readBundle(root: string | undefined, source: WorkflowSource): WorkflowBundle | undefined {
  // A relative root would depend on the working folder, and the folder goes to `--plugin-dir`.
  if (root === undefined || root === '' || !path.isAbsolute(root)) return undefined
  const dir = path.join(root, source)
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof json !== 'object' || json === null) return undefined
  const version = (json as { version?: unknown }).version
  if (typeof version !== 'string' || !VERSION.test(version)) return undefined
  const template = path.join(dir, 'skills', 'init', 'scaffold', '.openaflow', 'workflows', source, 'state')
  return { source, version, dir, template }
}
