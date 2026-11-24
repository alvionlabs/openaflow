// New session (sprint terminal-tab §5 and §7): the form's words, and the flow that posts `new-session`, waits for the
// Board to list the new session's marker (at most MARKER_WAIT_MS), then goes to the repo row and asks for its Terminal
// tab. Also the "type it yourself" lines, kept by marker for the page's life. Pure but for its timer; NewSessionForm.tsx
// is the glue. Sprint default-workflow §9 adds the workflow's lines: the version line, the mismatch notice with Use, and
// the setup offer with Set up. Use and Set up post through the same flow, so only one post is out at a time.

import {
  SKILLS,
  type Board,
  type BoardRepo,
  type HostedSession,
  type NewSessionResult,
  type SetupWorkflowResult,
  type SkillId,
  type UseWorkflowVersionResult,
} from '@openaflow/model'
import { postAction, UNREACHABLE, type ActionReply } from '../../actions-client.ts'
import type { TerminalBridge } from '../../desktop-bridge.ts'
import type { ListboxItem } from '../../components/listbox.ts'
import { requestTab } from '../../open-tab.ts'
import { hashFor } from '../../selection.ts'
import { refusalText, warnUnknown, type Post } from './remove-flow.ts'

/** How long a started session may take to show on the Board before the form stops waiting. */
export const MARKER_WAIT_MS = 10_000
/** The text field's limit, as the server's (it counts code points; the field counts UTF-16 units, so it is stricter). */
export const TEXT_MAX = 2000

export const BAD_TEXT = 'Use plain text on one line, up to 2,000 characters'
export const PLAIN_DASH = "A plain session can't start with a dash"
/** The session started, but the Board didn't list it in time: the page stays where it is. */
export const NOT_SHOWN = 'The session started. It shows here once the board catches up'

/**
 * The new-session route's words, for the alert box. Short and warm, with no period at the end (DESIGN.md). `start
 * failed: <host error>` is matched by its start; any other word shows the try-again text and goes to the console.
 */
export const START_ERRORS: ReadonlyMap<string, string> = new Map([
  ['bad request', "Something's off. Please reload and try again"],
  ['no terminal host', "The terminals aren't running. Restart the app and try again"],
  ['not a repo', "This repo isn't on the board anymore"],
  ['claude not found', "Can't find Claude Code on this computer"],
  ['session starting', 'A session is already starting in this repo'],
  ['too many sessions', 'Ten sessions are open. End one, then try again'],
  ['terminals unavailable', "The terminals didn't answer. Please try again"],
  ['workflow missing', "The app doesn't have this repo's workflow. Please reinstall it"],
  [UNREACHABLE, "Can't reach the board. Please try again"],
])

/**
 * Set up's words: the same as Add repo's confirm (A1), so the app reads the same everywhere. `setup failed: <code>` is
 * matched by its start. Any other word, `not a repo` and an unreachable server too, shows the try-again text.
 */
export const SETUP_ERRORS: ReadonlyMap<string, string> = new Map([
  ['already set up', 'This repo already has a .openaflow file or folder'],
  ['workflow missing', 'The app has no workflow to set up. Please reinstall it'],
  ['setup in progress', 'Setup is already running. Please wait'],
])
const SETUP_FAILED: readonly [string, string] = ['setup failed:', 'Setup failed. Please try again']

/** Use's words. `update failed: <code>` is matched by its start; any other word shows the try-again text. */
export const USE_ERRORS: ReadonlyMap<string, string> = new Map([
  ['already current', "This repo already uses the app's version"],
  ['workflow missing', 'The app has no workflow to use. Please reinstall it'],
  ['not a workflow', "This workflow isn't on the board anymore"],
  ['workflow.json unreadable', "Can't read this repo's workflow.json"],
])
const USE_FAILED: readonly [string, string] = ['update failed:', 'Update failed. Please try again']
const START_FAILED = "The session didn't start. Please try again"
/** The title over a wrapper error's lines. */
export const START_FAILED_TITLE = "The session didn't start"

/** The two lines of a wrapper error: which command failed, and why (shown as code). */
export type WrapperError = { line: string; code: string }

const WRAPPER_PREFIXES: readonly (readonly [string, string])[] = [
  ['run wrapper: ', 'Your run wrapper failed:'],
  ['stop command: ', 'Your stop command failed:'],
]

/** `run wrapper: <why>` and `stop command: <why>` (the settings' refusals) as the page's two lines; undefined for any other message, or one with no reason. */
export function wrapperError(message: string): WrapperError | undefined {
  for (const [prefix, line] of WRAPPER_PREFIXES) {
    if (message.startsWith(prefix) && message.length > prefix.length) return { line, code: message.slice(prefix.length) }
  }
  return undefined
}

/** The Open settings action's target: the settings page's literal hash. */
export const SETTINGS_HASH = '#settings'

export type NewSessionInput = { repoId: string; skill: SkillId; text: string }

/**
 * `idle`: the form is free; `fieldError` goes under the text field, `error` in the alert box (with `wrapper`'s line and code
 * and Open settings under it, for a run wrapper or stop command refusal), `note` is a quiet
 * status; `done` after a start, so the form clears its text. `starting`: the request is out. `waiting`: started, until
 * the Board lists `marker`. The button is off while `starting` or `waiting`.
 */
export type NewSessionState =
  | { kind: 'idle'; fieldError?: string; error?: string; wrapper?: WrapperError; note?: string; done?: true; focusText?: true }
  | { kind: 'starting'; input: NewSessionInput }
  | { kind: 'waiting'; repoId: string; marker: string }
  /** Use or Set up is out. `focusText` on the idle state after it: its button leaves with the next Board, so focus goes to the text field. */
  | { kind: 'posting'; action: 'use' | 'setup' }

export const isBusy = (s: NewSessionState) => s.kind !== 'idle'

export type NewSessionFlow = {
  state(): NewSessionState
  /** Posts once; ignored while busy. */
  start(input: NewSessionInput): void
  /** Each Board's repo, as it arrives: the flow moves once the repo it started in lists the marker. */
  board(repo: BoardRepo | undefined): void
  /** Open settings: moves the page to `#settings`. */
  openSettings(): void
  /** The text changed: a field error no longer applies. */
  edit(): void
  /** Use: sets the workflow `name`'s version to the app's. Posts once; ignored while busy. */
  useVersion(repoId: string, name: string): void
  /** Set up: creates `.openaflow/` in the repo at `path`. Posts once; ignored while busy. */
  setUp(path: string): void
  /** Drops any answer and the wait: the form left. */
  dispose(): void
}

export type NewSessionDeps = {
  post?: Post
  /** Moves the page to a hash. */
  go?: (hash: string) => void
  /** Asks the run screen for the Terminal tab. */
  openTab?: () => void
  typed?: TypedLines
}

const fieldError = (input: NewSessionInput) => (input.skill === 'plain' && input.text.trim().startsWith('-') ? PLAIN_DASH : BAD_TEXT)

function boxError(reply: { status: number; message: string }): string {
  if (reply.message.startsWith('start failed:')) {
    console.warn(`openaflow: new session failed (HTTP ${reply.status}: ${reply.message})`)
    return START_FAILED
  }
  warnUnknown('new session', START_ERRORS, reply)
  return refusalText(START_ERRORS, reply.message)
}

/** A Use or Set up refusal as the box's words; the exact cause of a try-again or a failed write goes to the console. */
function workflowError(action: string, errors: ReadonlyMap<string, string>, failed: readonly [string, string], reply: { status: number; message: string }): string {
  if (reply.message.startsWith(failed[0])) {
    console.warn(`openaflow: ${action} failed (HTTP ${reply.status}: ${reply.message})`)
    return failed[1]
  }
  warnUnknown(action, errors, reply)
  return refusalText(errors, reply.message)
}

export function createNewSessionFlow(onChange: (s: NewSessionState) => void, deps: NewSessionDeps = {}): NewSessionFlow {
  const post = deps.post ?? ((path, body) => postAction(path, body))
  const go = deps.go ?? ((hash: string) => (window.location.hash = hash))
  const openTab = deps.openTab ?? (() => requestTab('terminal'))
  const typed = deps.typed ?? TYPED
  let state: NewSessionState = { kind: 'idle' }
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  /** The markers each repo's last Board listed: the Board can reach the page before the answer. */
  const listed = new Map<string, Set<string>>()

  const set = (s: NewSessionState) => {
    state = s
    onChange(s)
  }
  const stopWaiting = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const moveIfListed = () => {
    if (state.kind !== 'waiting' || !listed.get(state.repoId)?.has(state.marker)) return
    const repoId = state.repoId
    stopWaiting()
    set({ kind: 'idle', done: true })
    go(hashFor({ repoId }))
    openTab()
  }
  const answered = (input: NewSessionInput, reply: ActionReply<NewSessionResult>) => {
    if (!reply.ok) {
      if (reply.message === 'bad text') return set({ kind: 'idle', fieldError: fieldError(input) })
      const wrapper = wrapperError(reply.message)
      if (wrapper) {
        return set({ kind: 'idle', error: START_FAILED_TITLE, wrapper })
      }
      return set({ kind: 'idle', error: boxError(reply) })
    }
    const { marker, typeYourself } = reply.data
    if (typeYourself !== undefined) typed.remember(marker, typeYourself)
    set({ kind: 'waiting', repoId: input.repoId, marker })
    timer = setTimeout(() => {
      timer = undefined
      if (state.kind === 'waiting') set({ kind: 'idle', done: true, note: NOT_SHOWN })
    }, MARKER_WAIT_MS)
    moveIfListed()
  }

  const postWorkflow = (action: 'use' | 'setup', path: string, body: object) => {
    if (isBusy(state)) return
    const mine = ++seq
    set({ kind: 'posting', action })
    void post<UseWorkflowVersionResult | SetupWorkflowResult>(path, body).then((reply) => {
      if (mine !== seq || state.kind !== 'posting') return
      if (reply.ok) return set({ kind: 'idle', focusText: true })
      const error =
        action === 'use' ? workflowError('use workflow version', USE_ERRORS, USE_FAILED, reply) : workflowError('set up workflow', SETUP_ERRORS, SETUP_FAILED, reply)
      set({ kind: 'idle', error })
    })
  }

  return {
    state: () => state,
    start(input) {
      if (isBusy(state)) return
      const mine = ++seq
      set({ kind: 'starting', input })
      void post<NewSessionResult>('new-session', { repoId: input.repoId, skill: input.skill, text: input.text }).then((reply) => {
        if (mine === seq && state.kind === 'starting') answered(input, reply)
      })
    },
    board(repo) {
      if (!repo) return
      listed.set(repo.id, new Set((repo.hosted ?? []).map((s) => s.marker)))
      moveIfListed()
    },
    useVersion(repoId, name) {
      postWorkflow('use', 'use-workflow-version', { repoId, name })
    },
    setUp(path) {
      postWorkflow('setup', 'setup-workflow', { path })
    },
    openSettings: () => go(SETTINGS_HASH),
    edit() {
      if (state.kind === 'idle' && state.fieldError !== undefined) set({ kind: 'idle' })
    },
    dispose() {
      seq++
      stopWaiting()
      if (isBusy(state)) state = { kind: 'idle' }
    },
  }
}

/** After a reload the line is gone, but the Board's `typeYourself` flag still asks for it. */
export const TYPE_UNKNOWN = 'Type your start line in the terminal.'

/** The lines a started session asked you to type yourself (`typeYourself`), by marker, until its Board shows `prompted`. */
export type TypedLines = {
  remember(marker: string, line: string): void
  /**
   * What to ask for `s`: `{ line }`, the raw line (the card puts it whole in one code span, as it may hold a backtick);
   * `{}` when only the Board's flag is left (TYPE_UNKNOWN); undefined once prompted, or for a session that ended or stopped.
   */
  line(s: HostedSession): { line?: string } | undefined
}

export function createTypedLines(): TypedLines {
  const lines = new Map<string, string>()
  return {
    remember: (marker, line) => void lines.set(marker, line),
    line(s) {
      if (s.prompted) {
        lines.delete(s.marker)
        return undefined
      }
      if (s.state !== 'starting' && s.state !== 'live') return undefined
      const line = lines.get(s.marker)
      if (line !== undefined) return { line }
      // After a reload only the Board's flag is left; the line itself was never stored.
      return s.typeYourself ? {} : undefined
    },
  }
}

/** The page's own lines: the form and the card on the repo row share them. */
export const TYPED: TypedLines = createTypedLines()

/** The "Start with" options: the skills in order, Plain session after a divider. Each shows its bare name, not its command. */
export function skillItems(): ListboxItem[] {
  const option = (s: (typeof SKILLS)[number]): ListboxItem => ({ kind: 'option', value: s.id, label: s.label, ...(s.name ? { command: s.name } : {}), line: s.line })
  const pod = SKILLS.filter((s) => s.command !== undefined).map(option)
  const plain = SKILLS.filter((s) => s.command === undefined).map(option)
  return [...pod, { kind: 'divider' }, ...plain]
}

/** The text field's label: what to build, or an optional first message for a plain session. */
export const textLabel = (skill: SkillId) => (skill === 'plain' ? 'Message (optional)' : 'What to build')

/** The repo the ⋯ menu's New session starts in: only in the desktop app (its terminal bridge), and only a repo the app reads. */
export function menuRepo(repo: BoardRepo | undefined, bridge: TerminalBridge | undefined): BoardRepo | undefined {
  if (!bridge || !repo || repo.error !== undefined || !repo.model.docs.supported) return undefined
  return repo
}

/** The bundle as the Board carries it: absent with no bundle. */
export type BundledWorkflow = Board['workflow']

/** The muted line under New session: only for a set-up repo, and only when the app has a bundle. */
export function versionLine(repo: BoardRepo | undefined, workflow: BundledWorkflow): string | undefined {
  if (!repo?.model.openaflow || !workflow) return undefined
  return `Workflow: claude-pod ${workflow.version}`
}

/** The mismatch line and its Use button; `name` is the workflow Use rewrites. */
export type WorkflowNotice = { text: string; use: string; name: string }

/**
 * The mismatch notice: the repo's first workflow whose source is `claude-pod` pins a version that differs from the
 * bundle's. None for an unset version, the same version, no bundle, or a repo without `.openaflow/`. It never blocks a start.
 */
export function workflowNotice(repo: BoardRepo | undefined, workflow: BundledWorkflow): WorkflowNotice | undefined {
  if (!repo?.model.openaflow || !workflow) return undefined
  const first = repo.model.workflows?.find((w) => w.source === 'claude-pod')
  if (first?.version === undefined || first.version === workflow.version) return undefined
  return { text: `This repo uses claude-pod ${first.version}; the app has ${workflow.version}`, use: `Use ${workflow.version}`, name: first.name }
}

/** The setup offer's words; the form shows `.openaflow/` in mono. */
export const SETUP_OFFER = 'Create .openaflow/ in this repo?'

/** The setup offer shows for a repo without `.openaflow/`, with docs or not. New session stays on beside it. */
export const setupOffer = (repo: BoardRepo | undefined): boolean => repo !== undefined && repo.model.openaflow !== true
