// The Next step card and the Waiting tab: the selected run's most urgent item and its one action,
// then everything else that waits on you. Picks from the model's rules only (the queue entries,
// waitingPrs, the reply panel), in the plan's order: blocked → merge → reply → pending → info,
// the pending tier sorted by stops first (the model's `stopsRun`), then by kind (entry-kind.ts).
// An entry that doesn't stop the run wears the run's own status; an entry that joins no plan stays
// listed but never takes a run's card (a repo row keeps a real stop as its card).
// Hosted sessions (terminal-tab N1): a repo row with no open session gets the start card (the New session form);
// a row whose shown session waits for you gets the waiting card (Open terminal), ranked as a pending entry pod goes on
// without, so it raises no toast and no urgent banner; a repo row whose shown session is starting or live gets the
// running card (Open terminal), in the nothing tier as the start card; a hosted run's reply says to type the word in the terminal.
// Pure; the card and the tab only render these.

import {
  SUPPORTED_DOCS_VERSION,
  haltGate,
  holdsRun,
  isAnswerable,
  rowSessions,
  sessionView,
  shownSession,
  skillCommand,
  stopsRun,
  waitingPrs,
  type BoardRepo,
  type HostedSession,
  type QueueItem,
  type RunSummary,
  type WaitingPr,
} from '@openaflow/model'
import { KIND_ORDER } from './entry-kind.ts'
import { waitingEntries, waitingRows, type WaitingRow } from './queue-view.ts'
import { kindChip } from './waiting-tab.ts'
import { replyPanel, type ReplyPanelView } from './reply-view.ts'
import { emptyMessage, type Chip } from './view.ts'

export type NextStatus = 'blocked' | 'needs-you' | 'ready' | 'running' | 'idle'
export type NextAction =
  | { kind: 'answer'; repoId: string; line: string }
  | { kind: 'merge'; repoId: string; number: number }
  | { kind: 'reply'; panel: ReplyPanelView }
  /** The start card: the New session form for this repo. */
  | { kind: 'new-session'; repoId: string }
  /** The waiting and running cards: Open terminal on this row's Terminal tab. */
  | { kind: 'open-terminal' }
  | { kind: 'none' }
export type NextItem = {
  /** Stable across Boards: `entry:<line>`, `pr:<number>`, `reply:<run>`; a repeated line gets `#2`, `#3`. */
  key: string
  tier: 'blocked' | 'merge' | 'reply' | 'pending' | 'info' | 'nothing'
  status: NextStatus
  /** One short line. */
  title: string
  /** A part of `title` shown as a link (an autopilot halt's PR). */
  titleLink?: { text: string; href: string }
  /** One short line. */
  detail?: string
  /** Queue items: the Waiting on you row. */
  entry?: WaitingRow
  /** A pending or blocked entry's kind as a dot and word (kindChip); none for `other`. */
  kind?: Chip
  /** A pending entry that doesn't stop the run (`stopsRun`), or that joins no plan: it raises no banner and ranks as nothing. */
  goesOn?: true
  action: NextAction
}
/** `card` is the first action item; `rest` is every other item (the Waiting tab's count is its length). */
export type NextSteps = { card: NextItem; rest: NextItem[] }

export const NOTHING_TITLE = 'Nothing to do'
export const BLOCKED_DETAIL = 'The run is stopped until you answer.'
export const PENDING_DETAIL = 'pod goes on with the value in use until you answer.'
/** A gate or hand-back that holds nothing right now: an engineer works past it (`holdsRun`). */
export const AT_WORK_DETAIL = 'An engineer is at work on this run. Answer when you can.'

export const START_TITLE = 'No active plan'
export const START_DETAIL = 'Pick what to start, then describe it.'
export const WAITING_TITLE = 'Claude waits for you in the terminal'
export const WAITING_DETAIL = 'It may ask you to trust this folder or to sign in. The app never answers for you.'
export const RUNNING_TITLE = "A session runs in this repo's terminal"
export const HOSTED_STOPPED = "This run's terminal has stopped. Dismiss it in the Terminal tab, then Continue works as before."
/** The same, when Resume works: `word` is what to type once the session is back. */
export const hostedResumable = (word: string): string => `This run's terminal has stopped. Resume it in the Terminal tab, then type \`${word}\`.`
/** The browser build's words in place of the form, and of Open terminal (sprint terminal-tab §7's browser rule). */
export const DESKTOP_START = 'Open the desktop app to start a session.'
export const DESKTOP_TERMINAL = 'Open the desktop app to use the terminal.'

const TITLE_MAX = 80

/** The body as one short line: cut at a word under TITLE_MAX characters, with an ellipsis. */
function short(text: string): string {
  if ([...text].length <= TITLE_MAX) return text
  const cut = [...text].slice(0, TITLE_MAX - 1).join('')
  const space = cut.lastIndexOf(' ')
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

const ACTION_TIERS = new Set<NextItem['tier']>(['blocked', 'merge', 'reply', 'pending'])
const TIER_ORDER: NextItem['tier'][] = ['blocked', 'merge', 'reply', 'pending', 'info']

/** Tier first; inside the pending tier, a stop first, then by the entry's kind (now → decision → before → other → someday). */
function byTier(a: NextItem, b: NextItem): number {
  const tier = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
  if (tier !== 0 || a.tier !== 'pending') return tier
  if (!a.goesOn !== !b.goesOn) return a.goesOn ? 1 : -1
  return KIND_ORDER.indexOf(a.entry?.kind ?? 'other') - KIND_ORDER.indexOf(b.entry?.kind ?? 'other')
}

/** Keys by line, a repeat numbered in list order, so a row's key never depends on where it sits. */
function entryKeys(rows: WaitingRow[]): string[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const n = (seen.get(r.line) ?? 0) + 1
    seen.set(r.line, n)
    return n === 1 ? `entry:${r.line}` : `entry:${r.line}#${n}`
  })
}

function entryItem(e: QueueItem, row: WaitingRow, key: string, repoId: string, stops: boolean, lifted: boolean, joined: boolean, run: RunSummary): NextItem {
  const answer: NextAction = { kind: 'answer', repoId, line: row.line }
  const blocked = e.type === 'BLOCKED'
  // The title is the body without its kind prefix; the kind shows as a dot and word, as on the rows.
  // Only an entry that holds the run reads as a halt: the title of a gate that doesn't is its own words.
  const title = blocked || stops ? entryTitle(row.text) : { title: short(row.text) }
  if (isAnswerable(e)) {
    const kind = row.kind === 'other' ? {} : { kind: kindChip(row) }
    // A plan's own BLOCKED says what the run says (`planState`): blocked when halted, else needs you.
    if (blocked) return { key, tier: 'blocked', status: joined && run.state !== 'blocked' ? 'needs-you' : 'blocked', ...title, ...kind, detail: BLOCKED_DETAIL, entry: row, action: answer }
    if (!stops) return { key, tier: 'pending', status: runStatus(run), goesOn: true, ...title, ...kind, detail: lifted ? AT_WORK_DETAIL : PENDING_DETAIL, entry: row, action: answer }
    return { key, tier: 'pending', status: 'needs-you', ...(joined ? {} : { goesOn: true as const }), ...title, ...kind, detail: BLOCKED_DETAIL, entry: row, action: answer }
  }
  return { key, tier: 'info', status: blocked ? 'blocked' : 'idle', ...title, detail: row.yourAnswer ?? row.route, entry: row, action: { kind: 'none' } }
}

function prDetail(pr: WaitingPr): string {
  if (pr.kind === 'wave') return `Wave ${pr.wave} of ${pr.sprint} is handed back to you.`
  if (pr.kind === 'final') return "The plan's final PR is reviewed and waits for you."
  if (pr.kind === 'staging') return 'The staging → main PR waits for you.'
  if (pr.reviewSkipped) return `The ${pr.kind} PR skipped review (--no-review) and waits for you.`
  return `The ${pr.kind} PR is reviewed and waits for you.`
}

const prItem = (pr: WaitingPr, repoId: string): NextItem => ({
  key: `pr:${pr.number}`,
  tier: 'merge',
  status: 'needs-you',
  title: `Merge PR #${pr.number}`,
  detail: prDetail(pr),
  action: { kind: 'merge', repoId, number: pr.number },
})

/** One item for the whole panel, worded by its first sendable row, else its first row. A hosted run's says to type it in the terminal. */
function replyItem(panel: ReplyPanelView): NextItem | undefined {
  const row = panel.rows.find((r) => r.send !== undefined) ?? panel.rows[0]
  if (!row) return undefined
  if (panel.hosted) {
    const { word, stopped, resumable } = panel.hosted
    const detail = stopped ? (resumable ? hostedResumable(word) : HOSTED_STOPPED) : `Open the terminal and type \`${word}\`.`
    return { key: `reply:${panel.target.run}`, tier: 'reply', status: 'needs-you', title: `Send ${word}`, detail, action: { kind: 'reply', panel } }
  }
  return {
    key: `reply:${panel.target.run}`,
    tier: 'reply',
    status: panel.rows.some((r) => r.send !== undefined) ? 'ready' : 'needs-you',
    title: `Send ${row.word}`,
    detail: row.why,
    action: { kind: 'reply', panel },
  }
}

/** What the run does, for a card that isn't asking you to stop anything. */
const runStatus = (run: RunSummary): NextStatus =>
  run.state === 'blocked' || run.state === 'needs-you' || run.state === 'running' ? run.state : 'idle'

/**
 * The waiting card: pending, but pod goes on without it, so it outranks nothing elsewhere and sends no toast. It needs
 * you, unless the run is blocked: then it wears Blocked, as the sidebar does (a waiting session never lowers a run).
 */
const waitingItem = (s: HostedSession, run: RunSummary): NextItem => ({
  key: `waiting:${s.marker}`,
  tier: 'pending',
  status: run.state === 'blocked' ? 'blocked' : 'needs-you',
  goesOn: true,
  title: WAITING_TITLE,
  detail: WAITING_DETAIL,
  action: { kind: 'open-terminal' },
})

/**
 * A repo New session can open in (the start card and the ⋯ menu): one the app reads. A repo without `.openaflow/` gets
 * it with docs or not (sprint default-workflow §9). A set-up repo does too, with no readable docs or older ones: init
 * writes or updates them, and the session loads the app's own workflow. Not one whose docs are newer than the app
 * reads: the app's pod is older than them.
 */
export const canOpenNewSession = (repo: BoardRepo): boolean =>
  repo.error === undefined && !(repo.model.openaflow === true && (repo.model.docs.version ?? 0) > SUPPORTED_DOCS_VERSION)

/**
 * A repo row New session can open in (`canOpenNewSession`) whose shown session isn't starting or live: the place to
 * start a new session, with readable docs or not.
 */
function canStart(run: RunSummary, repo: BoardRepo, shown: HostedSession | undefined): boolean {
  if (run.plan !== undefined || run.state === 'error' || !canOpenNewSession(repo)) return false
  return shown === undefined || (shown.state !== 'starting' && shown.state !== 'live')
}

/** A repo row whose shown session is starting or live (not yet waiting): the sidebar reads Running, and so does this card. */
/** A start line still for you to type has no "It started with": the card's Type line says what to do. */
const runningCard = (s: HostedSession, run: RunSummary): NextItem => {
  const command = skillCommand(s.skill)
  const started = command === undefined ? 'It started with no prompt.' : `It started with \`${command}\`.`
  return {
    key: `running:${s.marker}`,
    tier: 'nothing',
    status: runStatus(run),
    title: RUNNING_TITLE,
    ...(s.typeYourself && !s.prompted ? {} : { detail: started }),
    action: { kind: 'open-terminal' },
  }
}

/** An unsupported repo's start card keeps its empty message (the set-up line, or the docs version) as the detail. */
const startCard = (run: RunSummary, repo: BoardRepo): NextItem => ({
  key: 'new-session',
  tier: 'nothing',
  status: runStatus(run),
  title: START_TITLE,
  detail: run.state === 'unsupported' ? emptyMessage(run, repo) : START_DETAIL,
  action: { kind: 'new-session', repoId: repo.id },
})

function nothingCard(run: RunSummary, repo: BoardRepo): NextItem {
  const status = runStatus(run)
  const empty = run.state === 'error' || run.state === 'unsupported' || run.plan === undefined
  return { key: 'nothing', tier: 'nothing', status, title: NOTHING_TITLE, detail: empty ? emptyMessage(run, repo) : run.where, action: { kind: 'none' } }
}

/** The selected run's Next step and the rest; undefined with no run or repo, or a run of another repo. */
export function nextSteps(run: RunSummary | undefined, repo: BoardRepo | undefined, now: number): NextSteps | undefined {
  if (!run || !repo || run.repoId !== repo.id) return undefined
  // waitingRows maps waitingEntries one to one, so an entry and its row share an index.
  const entries = waitingEntries(repo, run)
  const rows = waitingRows(repo, run)
  const keys = entryKeys(rows)
  const plan = run.fix === undefined ? repo.model.plans.find((p) => p.slug === run.plan) : undefined
  const joined = new Set(plan?.queue.map((e) => e.line))
  const own = (e: QueueItem) => (plan !== undefined && joined.has(e.line) ? plan : undefined)
  const stops = entries.map((e) => {
    const p = own(e)
    return p ? holdsRun(repo, p, e, now) : stopsRun(e)
  })
  const items: NextItem[] = entries.map((e, i) => entryItem(e, rows[i]!, keys[i]!, repo.id, stops[i]!, !stops[i] && own(e) !== undefined && stopsRun(e, own(e)), joined.has(e.line), run))
  // An entry that joins no plan never heads a run; a repo row, with nowhere else to show it, keeps a real stop.
  const repoRow = run.plan === undefined
  const unjoined = new Set(entries.flatMap((e, i) => (joined.has(e.line) || (repoRow && stops[i]) ? [] : [items[i]!.key])))
  // A repo row names no plan, so it has no PRs; a fix run's PRs carry its claim name.
  if (run.plan !== undefined) items.push(...waitingPrs(repo, now).filter((pr) => pr.run === run.plan).map((pr) => prItem(pr, repo.id)))
  const panel = replyPanel(run, repo, now)
  const reply = panel && replyItem(panel)
  if (reply) items.push(reply)
  const shown = shownSession(rowSessions(repo, run.plan, now))
  if (shown && sessionView(shown, now) === 'waiting') items.push(waitingItem(shown, run))
  // A stable sort: list order holds within a tier, and within a kind in the pending tier.
  const sorted = items.sort(byTier)
  const first = sorted.find((i) => !unjoined.has(i.key))
  if (first && ACTION_TIERS.has(first.tier)) return { card: first, rest: sorted.filter((i) => i !== first) }
  const view = shown && sessionView(shown, now)
  // A repo New session can open in: its live session gets the running card, as a start would.
  const readable = run.state !== 'error' && canOpenNewSession(repo)
  if (shown && readable && run.plan === undefined && (view === 'starting' || view === 'live')) return { card: runningCard(shown, run), rest: sorted }
  return { card: canStart(run, repo, shown) ? startCard(run, repo) : nothingCard(run, repo), rest: sorted }
}

/**
 * What the card draws for a terminal: `detail` (in place of the item's), the New session `form`, the Open terminal
 * button, or the desktop `note` in its place. `terminals`: the desktop app's terminal bridge is there.
 */
export type CardTerminal = { detail?: string; form: boolean; openTerminal: boolean; note?: string }

export function cardTerminal(card: NextItem, terminals: boolean): CardTerminal {
  const a = card.action
  if (a.kind === 'new-session') {
    // A start card with its own message (an unsupported repo's) keeps it; the browser then adds the desktop note.
    const own = card.detail !== undefined && card.detail !== START_DETAIL ? card.detail : undefined
    if (terminals) return { detail: own ?? START_DETAIL, form: true, openTerminal: false }
    return own === undefined ? { detail: DESKTOP_START, form: false, openTerminal: false } : { detail: own, form: false, openTerminal: false, note: DESKTOP_START }
  }
  if (a.kind !== 'open-terminal' && !(a.kind === 'reply' && a.panel.hosted)) return { form: false, openTerminal: false }
  const detail = card.detail === undefined ? {} : { detail: card.detail }
  return terminals ? { ...detail, form: false, openTerminal: true } : { ...detail, form: false, openTerminal: false, note: DESKTOP_TERMINAL }
}

/**
 * A hosted row in the Waiting tab's rest list (a hosted reply, or the waiting card): its words and Open terminal, or the
 * desktop note in the browser. Defined means the row draws no reply panel, so no Copy and no Run it yourself. Any other
 * row: undefined.
 */
export function hostedRow(item: NextItem, terminals: boolean): CardTerminal | undefined {
  const a = item.action
  if (a.kind !== 'open-terminal' && !(a.kind === 'reply' && a.panel.hosted)) return undefined
  return cardTerminal(item, terminals)
}

/** `text` cut at its backticks: the parts between a pair show as code. An unpaired backtick stays text. */
export function codeParts(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = []
  let at = 0
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    if (m.index > at) out.push({ code: false, text: text.slice(at, m.index) })
    out.push({ code: true, text: m[1]! })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) })
  return out
}

export type GateTitle = { title: string; link?: { text: string; href: string } }

const PR_URL = /https?:\/\/\S+?\/pull\/(\d+)/
const PR_HASH = /#(\d+)\b/

/** The entry's PR: from a pull URL (number and link), else `#N` (number only). */
function entryPr(body: string): { number: number; href?: string } | undefined {
  const url = PR_URL.exec(body)
  if (url) return { number: Number(url[1]), href: url[0] }
  const hash = PR_HASH.exec(body)
  return hash ? { number: Number(hash[1]) } : undefined
}

/**
 * An autopilot halt (an entry that starts with its gate, the model's `haltGate`) as one plain sentence,
 * with its PR as a link when the entry gives a pull URL. Undefined when it isn't a halt, or gate 3 or 6
 * names no PR: the card then shows the entry's own text.
 */
export function gateTitle(body: string): GateTitle | undefined {
  const gate = haltGate(body)
  if (gate === undefined) return undefined
  const fixed: Record<number, string> = {
    1: 'Autopilot stopped: a slice is blocked',
    2: 'Autopilot stopped: the final review still fails',
    4: 'Autopilot stopped: the wave check failed',
    5: 'Autopilot stopped: it hit a safety limit',
    7: 'Plan complete: review and merge the staging PR',
  }
  const plain = fixed[gate]
  if (plain !== undefined) return { title: plain }
  const pr = entryPr(body)
  if (!pr) return undefined
  const text = `PR #${pr.number}`
  const link = pr.href === undefined ? {} : { link: { text, href: pr.href } }
  if (gate === 6) return { title: `Autopilot held ${text} for you to merge`, ...link }
  // Gate 3: the wave's PR or the final PR, when the entry says which.
  const kind = /\bfinal\b/i.test(body) ? 'final ' : /\bwave\b/i.test(body) ? 'wave ' : ''
  return { title: `Autopilot stopped: ${kind}${text} couldn't merge`, ...link }
}

/** The card's title for an entry: the halt's sentence, else the body cut to one line. */
function entryTitle(body: string): Pick<NextItem, 'title' | 'titleLink'> {
  const gate = gateTitle(body)
  if (!gate) return { title: short(body) }
  return gate.link ? { title: gate.title, titleLink: gate.link } : { title: gate.title }
}

