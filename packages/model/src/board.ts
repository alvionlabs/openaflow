// The board the server sends to the web app: every repo with its run model,
// its pod agents, its PRs, and its port claims. Types only; times are epoch ms.
// The shapes are the sprint's shared contract (pod-docs/sprints/server-runs.md).

import type { ActionEntry } from './actions.ts'
import type { AutoToggle } from './auto-continue.ts'
import type { RepoModel } from './run-model.ts'
import type { SkillId } from './skills.ts'

/** One pod agent, read from its transcript. Never holds transcript text, tool input, or tool output. */
export type AgentRun = {
  id: string
  session: string
  type: string
  /**
   * Set when its session's own file doesn't show the session started in this repo: no readable `cwd`, or one
   * outside the repo. The agent stays listed, but the board offers no send on its session (`replySession`).
   */
  sessionUnproven?: true
  /**
   * Never set: the dispatcher's Task description is assistant-written text, and no page shows it,
   * so it stays off the Board. Optional only until the test helpers that still write it drop it.
   */
  description?: string
  sprint?: string
  slice?: string
  branch?: string
  plan?: string
  round?: number
  /** A reviewer's `kind` field: `plan` or `fix`. */
  kind?: string
  /** A reviewer's PR number, from its `PR URL` or `PR` field's GitHub pull URL. */
  pr?: number
  model?: string
  startedAt?: number
  lastAt?: number
  /**
   * When it was active: `[from, to]` spans, oldest first, split wherever two records are more than
   * IDLE_GAP_MS apart (the laptop asleep, a run left waiting). Times only. Missing on an agent with no timed record.
   */
  active?: [number, number][]
  tokens: number
  /** Its last turn handed back (or ended its turn) after its last prompt. */
  ended: boolean
  /** Set only on an agent resumed after a hand-back (SendMessage): when its last turn's prompt came. A time only. */
  resumedAt?: number
  /** Set only with `resumedAt`: each turn, from its prompt to its hand-back (absent while it works). Times and tokens only. */
  turns?: AgentTurn[]
}

/** One turn of a continued agent. `lastAt` is its last record; `tokens` the messages that finished in it. */
export type AgentTurn = { startedAt: number; endedAt?: number; lastAt: number; tokens: number }

export type AgentState = 'running' | 'ended' | 'stale'

export type PrStatus = {
  number: number
  state: 'open' | 'merged' | 'closed'
  checks: 'pass' | 'fail' | 'pending' | 'none'
  url?: string
  checkedAt: number
  /** The head branch, set when the PR was found by its branch (a one-off run's `task-<slug>` or `fix-<slug>`, or a plan's final PR on `<plan-slug>`). */
  branch?: string
  /** The base branch gh reports (`baseRefName`), when it reports one. */
  base?: string
  /** When it merged (ms since epoch), from gh's `mergedAt`; only on a merged PR gh gave a time for. */
  mergedAt?: number
  /** The PR's title as gh gives it; only on a PR found by its branch. */
  title?: string
  /** When it opened (ms since epoch), from gh's `createdAt`; unset when gh gave no usable time. */
  openedAt?: number
  /**
   * Only on a PR found by its branch whose body holds `skipped (--no-review)`: pod's PR template
   * writes it for a `/pod:task --no-review` PR. The body itself is never kept.
   */
  reviewSkipped?: true
}

export type GhStatus = 'ok' | 'missing' | 'logged-out' | 'unknown'

export type Claim = { portBase: number; repoPath: string; plan: string }

/**
 * One PR the server asks gh about, by number or by head branch, and whether gh has answered that ask once.
 * A failed read isn't one. A branch with no PR is. `staging`: the ask comes from another PR's base, so
 * a PR read can bring it. How the toasts use it is in pod-docs/feature-details/toasts.md.
 */
export type GhRead = { pr: number; read: boolean } | { branch: string; staging?: true; read: boolean }

/** A session record's state in `<config dir>/sessions.json` (sprint terminal-tab §3). */
export type StoredSessionState = 'starting' | 'live' | 'ended' | 'stopped'

/** Why a stopped session stopped: the terminal host crashed, or the app closed while it ran. */
export type StopReason = 'terminals restarted' | 'app closed'

/**
 * One session the app started in its terminal host, from the session store and its hook state file.
 * `marker` is the run marker (the host's session id); `sessionId` the id it started with.
 * `sessions`: `sessionId` first, then every other `SessionStart` session (after `/clear`), once each.
 * `liveSession`: the newest `SessionStart`'s session, else `sessionId`. Never holds prompt text.
 * The rules that read it are in hosted.ts.
 */
export type HostedSession = {
  marker: string
  sessionId: string
  liveSession: string
  sessions: string[]
  skill: SkillId
  startedAt: number
  state: StoredSessionState
  /** Only with state `stopped`. */
  stopReason?: StopReason
  endedAt?: number
  exitCode?: number
  /** A `SessionStart` line exists. */
  hooked: boolean
  /** A `UserPromptSubmit` line exists. */
  prompted: boolean
  /** The start line went to the user to type; the text is never stored. */
  typeYourself?: true
  /** Whether Resume can start this session again, and why not. Only with state `ended` or `stopped`. */
  resume?: SessionResume
  /** The scrollback its start used (100 to 100,000). Absent on a session started before the setting. */
  scrollback?: number
}

/**
 * Whether a hosted session can resume. First match: the repo path isn't a folder (`no folder`); its transcript
 * file is gone (`no conversation`); a `starting` or `live` record holds its live session (`in use`); else `ok`.
 */
export type SessionResume = 'ok' | 'no folder' | 'no conversation' | 'in use'

export type BoardRepo = {
  id: string
  name: string
  path: string
  /** Set when the repo's file system ignores case: `repoPathKey` folds the path, as `sameRepoPath` does. */
  caseless?: true
  source: 'registered' | 'claim' | 'both'
  error?: string
  model: RepoModel
  agents: AgentRun[]
  prs: PrStatus[]
  claims: Claim[]
  /** Each PR the server asks gh about. Missing when it asks about none. */
  ghReads?: GhRead[]
  /** The repo's hosted sessions, oldest first. Missing when it has none. */
  hosted?: HostedSession[]
}

export type Board = {
  generatedAt: number
  gh: GhStatus
  ghCheckedAt?: number
  /** Set on every build where the config file exists but can't be read; the last repo list is still used. */
  configError?: 'config unreadable'
  repos: BoardRepo[]
  /** The action log, newest first, at most 50. */
  actions?: ActionEntry[]
  /** The runs whose auto-continue toggle is on. Missing means all off. `lastFailed`: the last send of `lastKey` failed to start. */
  autoContinue?: ({ repoId: string } & Pick<AutoToggle, 'run' | 'lastKey' | 'lastFailed'>)[]
  /** OPENAFLOW_TRANSCRIPT_DAYS: agents come only from transcripts written in this many days. Missing on older Boards (read as 30). */
  transcriptDays?: number
}
