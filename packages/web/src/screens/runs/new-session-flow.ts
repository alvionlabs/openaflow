// New session (sprint terminal-tab §5 and §7): the form's words, and the flow that posts `new-session`, waits for the
// Board to list the new session's marker (at most MARKER_WAIT_MS), then goes to the repo row and asks for its Terminal
// tab. Also the "type it yourself" lines, kept by marker for the page's life. Pure but for its timer; NewSessionForm.tsx
// is the glue.

import { SKILLS, type BoardRepo, type HostedSession, type NewSessionResult, type SkillId } from '@openaflow/model'
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
  [UNREACHABLE, "Can't reach the board. Please try again"],
])
const START_FAILED = "The session didn't start. Please try again"

export type NewSessionInput = { repoId: string; skill: SkillId; text: string }

/**
 * `idle`: the form is free; `fieldError` goes under the text field, `error` in the alert box, `note` is a quiet
 * status; `done` after a start, so the form clears its text. `starting`: the request is out. `waiting`: started, until
 * the Board lists `marker`. The button is off while `starting` or `waiting`.
 */
export type NewSessionState =
  | { kind: 'idle'; fieldError?: string; error?: string; note?: string; done?: true }
  | { kind: 'starting'; input: NewSessionInput }
  | { kind: 'waiting'; repoId: string; marker: string }

export const isBusy = (s: NewSessionState) => s.kind !== 'idle'

export type NewSessionFlow = {
  state(): NewSessionState
  /** Posts once; ignored while busy. */
  start(input: NewSessionInput): void
  /** Each Board's repo, as it arrives: the flow moves once the repo it started in lists the marker. */
  board(repo: BoardRepo | undefined): void
  /** The text changed: a field error no longer applies. */
  edit(): void
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
      set(reply.message === 'bad text' ? { kind: 'idle', fieldError: fieldError(input) } : { kind: 'idle', error: boxError(reply) })
      return
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

/** The lines a started session asked you to type yourself (`typeYourself`), by marker, until its Board shows `prompted`. */
export type TypedLines = {
  remember(marker: string, line: string): void
  /** The words to show for `s`, or undefined: once prompted, or for a session that ended or stopped. */
  line(s: HostedSession): string | undefined
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
      if (line !== undefined) return `Type \`${line}\` in the terminal.`
      // After a reload only the Board's flag is left; the line itself was never stored.
      return s.typeYourself ? 'Type your start line in the terminal.' : undefined
    },
  }
}

/** The page's own lines: the form and the card on the repo row share them. */
export const TYPED: TypedLines = createTypedLines()

/** The "Start with" options: the skills in order, Plain session after a divider. */
export function skillItems(): ListboxItem[] {
  const option = (s: (typeof SKILLS)[number]): ListboxItem => ({ kind: 'option', value: s.id, label: s.label, ...(s.command ? { command: s.command } : {}), line: s.line })
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
