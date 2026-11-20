import { describe, expect, it } from 'vitest'
import { buildFixPipeline, buildPipeline, buildRepoModel, listRuns, type AgentRun, type BoardRepo, type HostedSession, type PrStatus, type RunSummary } from '@openaflow/model'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadFixture } from '../../../../model/test/load-fixture.ts'
import { LogTab } from './LogTab.tsx'
import { DESKTOP_TERMINAL, nextSteps, type NextItem } from './next-step.ts'
import { RunsScreen } from './RunsScreen.tsx'
import { WaitingTab } from './WaitingTab.tsx'

// chess-web as in next-step.test.ts: plan sparring-ladder on wave 3 of sprint ladder, three PENDING entries for you.
const NOW = Date.UTC(2026, 9, 20, 12)
const MIN = 60_000
const PLAN = 'sparring-ladder'
const QUEUE = 'pod-docs/handoff-queue.md'
const LADDER = 'pod-docs/sprints/ladder.md'

type Files = Record<string, string>
type Edit = (files: Files) => void

const entry = (type: string, route: string, fields: string, body: string) => `- \`[2026-10-19 · ${type} · ${route}${fields ? ` · ${fields}` : ''}]\` ${body} **Resolution:** pending`
const T1_BLOCKED = entry('BLOCKED', 'engineer → human', 'sprint: ladder · slice: T1', "T1 can't reach the rates file.")
const ANSWERED = `${entry('PENDING', 'engineer → human', 'sprint: ladder · slice: T1', 'Pick the step size.')} **Answer (human):** 50`

const addQueue = (...lines: string[]): Edit => (f) => {
  f[QUEUE] = `${f[QUEUE]!.trimEnd()}\n${lines.join('\n')}\n`
}
const manual: Edit = (f) => {
  for (const doc of ['pod-docs/plans/sparring-ladder.md', LADDER]) f[doc] = f[doc]!.replace(/^<!-- autopilot-run.*-->\r?\n/m, '')
}
const t1Pushed: Edit = (f) => {
  f[LADDER] = f[LADDER]!.replace('| ladder-T1 | — | pending | — |', '| ladder-T1 | #78 | pushed | medium |')
}
const gh = (number: number, state: PrStatus['state']): PrStatus => ({ number, state, checks: 'pass', checkedAt: NOW })

function chess(edits: Edit[] = [], extra: Partial<BoardRepo> = {}): BoardRepo {
  const files = loadFixture('chess-web')
  for (const e of edits) e(files)
  return { id: 'chess', name: 'chess-web', path: '/c', source: 'registered', model: buildRepoModel(files), agents: [], prs: [], claims: [], ...extra }
}
const runOf = (repo: BoardRepo, plan: string | undefined = PLAN): RunSummary => {
  const r = listRuns({ generatedAt: NOW, gh: 'ok', repos: [repo] }, NOW).find((x) => x.plan === plan)
  if (!r) throw new Error(`no run ${plan}`)
  return r
}

/** The markup of each `<li>` at the top of the list, by its item key. */
function rowsOf(html: string, items: NextItem[]): Map<string, string> {
  const parts = html.split(/<li class="wait-row/).slice(1)
  expect(parts).toHaveLength(items.length)
  return new Map(items.map((it, i) => [it.key, parts[i]!]))
}
const ANSWER = />Answer<\/button>/
const MERGE = />Merge<\/button>/

describe('tab panels', () => {
  it('waiting rows', () => {
    const repo = chess([manual, t1Pushed, addQueue(T1_BLOCKED, ANSWERED)], { prs: [gh(78, 'open')] })
    const run = runOf(repo)
    const steps = nextSteps(run, repo, NOW)!
    // The blocked entry takes the card; the PR, the PENDING entries and the answered one wait in the tab.
    const rest = steps.rest
    const answerable = rest.find((i) => i.tier === 'pending')!
    const info = rest.find((i) => i.tier === 'info')!
    const prItem = rest.find((i) => i.tier === 'merge')!
    expect([answerable, info, prItem].every(Boolean)).toBe(true)

    const html = renderToStaticMarkup(createElement(WaitingTab, { repo, run, items: rest }))
    const rows = rowsOf(html, rest)
    // An answerable entry has Answer; an info entry has none; a PR row has Merge and no Answer.
    expect(rows.get(answerable.key)).toMatch(ANSWER)
    expect(rows.get(answerable.key)).not.toMatch(MERGE)
    expect(rows.get(info.key)).not.toMatch(ANSWER)
    expect(rows.get(info.key)).not.toMatch(MERGE)
    expect(rows.get(prItem.key)).toMatch(MERGE)
    expect(rows.get(prItem.key)).not.toMatch(ANSWER)
    // The info entry keeps your answer in view; nothing else on it acts.
    expect(rows.get(info.key)).toContain('Your answer: 50')
    expect(rows.get(info.key)!.match(/<button/g)).toHaveLength(1)

    // An entry row: one toggle, closed, holding route · date and the body clamped to 2 lines.
    const head = rows.get(answerable.key)!
    expect(head).toMatch(/<button[^>]*class="wait-toggle"[^>]*aria-expanded="false"/)
    expect(head).toContain('engineer → human · 2026-10-')
    expect(head).toMatch(/<span class="wait-body clamp">/)
    // The PR's Merge button carries the id MergeConfirm returns focus to, and is closed.
    expect(rows.get(prItem.key)).toMatch(/<button[^>]*id="merge-pr-78"[^>]*aria-expanded="false"[^>]*>Merge<\/button>/)
    // No form or confirm is open until a press.
    expect(html).not.toContain('answer-form')
    expect(html).not.toContain('merge-confirm')
    expect(html).not.toContain('Nothing else waits on you.')

    // Nothing waiting: the empty note, and no list.
    const empty = renderToStaticMarkup(createElement(WaitingTab, { repo, run, items: [] }))
    expect(empty).toContain('Nothing else waits on you.')
    expect(empty).not.toContain('<li')
  })

  it('waiting rows: a reply row shows the reply panel without its frame', () => {
    const repo = chess([manual, t1Pushed, addQueue(T1_BLOCKED)], { prs: [gh(78, 'open')] })
    const run = runOf(repo)
    const rest = nextSteps(run, repo, NOW)!.rest
    const reply = rest.find((i) => i.tier === 'reply')!
    expect(reply).toBeDefined()
    const html = renderToStaticMarkup(createElement(WaitingTab, { repo, run, items: [reply] }))
    expect(html).toContain('aria-label="Copy continue"')
    expect(html).not.toContain('Reply pod waits for</span>')
    expect(html).not.toMatch(/class="inplace reply-panel"/)
  })

  it('log blocks: one per sprint, named by its heading, its waves as row groups; a fix run has one Agents block', () => {
    const repo = chess()
    const run = runOf(repo)
    const pipeline = buildPipeline(repo, PLAN, NOW)!
    const plan = renderToStaticMarkup(createElement(LogTab, { repo, run, pipeline, now: NOW, actions: [] }))
    const blocks = [...plan.matchAll(/<section class="log-group" aria-labelledby="([^"]+)">([\s\S]*?)<\/section>/g)]
    // chess-web has one sprint, ladder, with three waves.
    expect(blocks).toHaveLength(1)
    const [, id, body] = blocks[0]!
    // The heading names the block and its table; the sprint's state sits beside it (the run's: nothing stops it, nothing runs).
    expect(body).toMatch(new RegExp(`<h3 class="log-sprint-name" id="${id}">Sprint 1 · ladder</h3><span class="chip s-idle">waiting</span>`))
    expect(body).toMatch(new RegExp(`<table class="slice-log" aria-labelledby="${id}">`))
    // One row group per wave: a `Wave N` header with its status, then its slices.
    const waves = [...body!.matchAll(/<tbody class="log-wave"><tr class="grp"><th scope="rowgroup">([^<]*)<\/th><td><span class="chip [^"]*">([^<]*)<\/span><\/td><\/tr>([\s\S]*?)<\/tbody>/g)]
    expect(waves.map((w) => [w[1], w[2], w[3]!.match(/<tr>/g)?.length])).toEqual(pipeline.log.map((g) => [`Wave ${g.wave}`, g.status, g.rows.length]))
    // Confidence is a quiet tag after the title and model; the status column holds no confidence.
    expect(plan).toMatch(/<span class="code">L1<\/span>[^]*?<span class="muted"> · opus<\/span><span class="chip tag">medium confidence<\/span><\/td><td><\/td><\/tr>/)
    // A running slice: its figures follow the title (after the model, before the tag); the rail holds only `running`.
    const t1 = { id: 't1', session: 's', type: 'pod:engineer', tokens: 392_000, ended: false, sprint: 'ladder', slice: 'T1', startedAt: NOW - 38 * MIN, lastAt: NOW - MIN }
    const live = chess([], { agents: [t1] })
    const livePlan = renderToStaticMarkup(createElement(LogTab, { repo: live, run: runOf(live), pipeline: buildPipeline(live, PLAN, NOW)!, now: NOW, actions: [] }))
    expect(livePlan).toMatch(/<span class="code">T1<\/span>[^]*?<span class="muted"> · opus<\/span><span class="figures"> · \d+ min · 392k tok<\/span><\/td><td><span class="chip s-run">running<\/span><\/td><\/tr>/)
    // No status cell anywhere holds figures.
    for (const html of [plan, livePlan]) expect(html).not.toMatch(/<td>(<span class="chip [^"]+">[^<]*<\/span>)?<span class="figures">/)
    // A slice with no figures yet (T1, pending) leaves its figures cell empty, so a phone shows no stray middle dot.
    expect(plan).toMatch(/<span class="code">T1<\/span>[\s\S]*?<\/td><td><\/td><\/tr>/)

    // A fix run's agent log: one block, headed Agents, its rows straight under it.
    const eng: AgentRun = { id: 'e1', session: 's', type: 'pod:engineer', tokens: 0, ended: false, branch: 'fix-scroll', startedAt: NOW - 10 * MIN, lastAt: NOW - MIN }
    const fixRepo: BoardRepo = {
      id: 'web',
      name: 'web',
      path: '/r/web',
      source: 'claim',
      model: buildRepoModel({ 'pod-docs/README.md': '# pod docs\n\npod docs: 2\n' }),
      agents: [eng],
      prs: [],
      claims: [{ portBase: 3100, repoPath: '/r/web', plan: 'fix-scroll' }],
    }
    const fix = renderToStaticMarkup(createElement(LogTab, { repo: fixRepo, run: runOf(fixRepo, 'fix-scroll'), fixPipeline: buildFixPipeline(fixRepo, 'fix-scroll', NOW)!, now: NOW, actions: [] }))
    const agents = /<section class="log-group" aria-labelledby="([^"]+)"><div class="log-sprint"><h3 class="log-sprint-name" id="\1">Agents<\/h3><\/div><table class="slice-log agent-log" aria-labelledby="\1"><tbody><tr/.exec(fix)
    expect(agents, 'the Agents block').not.toBeNull()
    // Its rows too: the label, then the time inline; the rail holds only the agent's state.
    expect(fix).toMatch(/<tr><td>[^<]*(<a [^>]*>[^<]*<\/a>)?[^<]*<span class="figures"> · [^<]+<\/span><\/td><td><span class="chip [^"]+">[^<]+<\/span><\/td><\/tr>/)
  })

  it("the Log never disagrees with the runs list: the current sprint and its in-progress wave take the run's state", () => {
    const chipOf = (html: string) => /<h3 class="log-sprint-name"[^>]*>Sprint 1 · ladder<\/h3><span class="chip ([^"]+)">([^<]*)<\/span>/.exec(html)?.slice(1)
    const waveOf = (html: string, n: number) => new RegExp(`<th scope="rowgroup">Wave ${n}</th><td><span class="chip ([^"]+)">([^<]*)</span>`).exec(html)?.slice(1)
    const logOf = (repo: BoardRepo) => {
      const run = runOf(repo)
      return { run, html: renderToStaticMarkup(createElement(LogTab, { repo, run, pipeline: buildPipeline(repo, PLAN, NOW)!, now: NOW, actions: [] })) }
    }
    // Halted: gate 3 BLOCKED to you.
    const halted = logOf(chess([addQueue(entry('BLOCKED', 'orchestrator → human', `plan: ${PLAN}`, 'gate 3 auto-merge-fail: PR #78 has no passing CI'))]))
    expect(halted.run.state).toBe('blocked')
    expect(chipOf(halted.html)).toEqual(['s-bad', 'blocked'])
    expect(waveOf(halted.html, 3)).toEqual(['s-bad', 'blocked'])
    // A halt gate filed as PENDING, no agents.
    const asks = logOf(chess([addQueue(entry('PENDING', 'orchestrator → human', `plan: ${PLAN}`, 'gate 5 (safety-bound): hit the limit'))]))
    expect(asks.run.state).toBe('needs-you')
    expect(chipOf(asks.html)).toEqual(['s-you', 'needs you'])
    expect(waveOf(asks.html, 3)).toEqual(['s-you', 'needs you'])
    // Done waves keep their merged status.
    expect(waveOf(asks.html, 1)?.[1]).toMatch(/^merged/)
    // Idle (no asks, nothing runs): the sidebar keeps idle; the Log reads waiting, for the sprint and its wave.
    const idle = logOf(chess([(f) => (f[QUEUE] = '# Handoff Queue\n')]))
    expect(idle.run.state).toBe('idle')
    expect(chipOf(idle.html)).toEqual(['s-idle', 'waiting'])
    expect(waveOf(idle.html, 3)).toEqual(['s-idle', 'waiting'])
  })

  it('log sections', () => {
    const other: AgentRun = { id: 'o1', session: 's', type: 'general-purpose', tokens: 0, ended: true, startedAt: NOW - 20 * MIN, lastAt: NOW - 10 * MIN }
    const at = (html: string, label: string) => {
      const i = html.indexOf(`aria-label="${label}"`)
      expect(i, label).toBeGreaterThanOrEqual(0)
      return i
    }

    // A plan: the slice log, then Other activity, then the Action log. No pipeline.
    const repo = chess([], { agents: [other] })
    const run = runOf(repo)
    const pipeline = buildPipeline(repo, PLAN, NOW)!
    const action = { at: NOW - MIN, repoId: 'chess', repo: 'chess-web', target: 'PR #77', action: 'merge', result: 'merged' } as const
    const plan = renderToStaticMarkup(createElement(LogTab, { repo, run, pipeline, now: NOW, actions: [action] }))
    expect(at(plan, 'Slice log')).toBeLessThan(at(plan, 'Other activity'))
    expect(at(plan, 'Other activity')).toBeLessThan(at(plan, 'Action log'))
    expect(plan).not.toContain('aria-label="Agent log"')
    expect(plan).not.toContain('aria-label="Pipeline"')
    expect(plan).toContain('chess-web · PR #77')

    // A fix run: the agent log, then Other activity and the Action log. No pipeline, no slice log.
    const files = { 'pod-docs/README.md': '# pod docs\n\npod docs: 2\n' }
    const eng: AgentRun = { id: 'e1', session: 's', type: 'pod:engineer', tokens: 0, ended: false, branch: 'fix-scroll', startedAt: NOW - 10 * MIN, lastAt: NOW - MIN }
    const fixRepo: BoardRepo = {
      id: 'web',
      name: 'web',
      path: '/r/web',
      source: 'claim',
      model: buildRepoModel(files),
      agents: [eng, other],
      prs: [],
      claims: [{ portBase: 3100, repoPath: '/r/web', plan: 'fix-scroll' }],
    }
    const fixRun = runOf(fixRepo, 'fix-scroll')
    const fixPipeline = buildFixPipeline(fixRepo, 'fix-scroll', NOW)!
    const fix = renderToStaticMarkup(createElement(LogTab, { repo: fixRepo, run: fixRun, fixPipeline, now: NOW, actions: [] }))
    expect(at(fix, 'Agent log')).toBeLessThan(at(fix, 'Other activity'))
    expect(at(fix, 'Other activity')).toBeLessThan(at(fix, 'Action log'))
    expect(fix).not.toContain('aria-label="Slice log"')
    expect(fix).not.toContain('aria-label="Pipeline"')
    // The open engineer's view follows the agent log when an agent is picked.
    expect(fix).not.toContain('aria-label="Engineer for')
    const open = renderToStaticMarkup(createElement(LogTab, { repo: fixRepo, run: fixRun, fixPipeline, agent: 'e1', now: NOW, actions: [] }))
    expect(at(open, 'Agent log')).toBeLessThan(open.indexOf('aria-label="Engineer for'))
    expect(open.indexOf('aria-label="Engineer for')).toBeLessThan(at(open, 'Other activity'))

    // A fix with no agent yet: the empty note in place of the agent log.
    const idle = { ...fixRepo, agents: [] }
    const none = renderToStaticMarkup(createElement(LogTab, { repo: idle, run: runOf(idle, 'fix-scroll'), fixPipeline: buildFixPipeline(idle, 'fix-scroll', NOW)!, now: NOW, actions: [] }))
    expect(none).toContain('No agent has started on this fix yet.')
    expect(at(none, 'Action log')).toBeGreaterThan(none.indexOf('No agent has started'))

    // A /pod:task run with no agent yet: the note names a task.
    const task = { ...idle, claims: [{ portBase: 3100, repoPath: '/r/web', plan: 'task-scroll' }] }
    const taskNone = renderToStaticMarkup(createElement(LogTab, { repo: task, run: runOf(task, 'task-scroll'), fixPipeline: buildFixPipeline(task, 'task-scroll', NOW)!, now: NOW, actions: [] }))
    expect(taskNone).toContain('No agent has started on this task yet.')
  })
})

describe('answer form', () => {
  it('shows the full entry text above the answer box when given', async () => {
    const { AnswerForm } = await import('./AnswerForm.tsx')
    const state = { kind: 'editing', seq: 1, target: { repoId: 'chess', line: 'x' }, text: '' } as const
    const flow = { open() {}, type() {}, save() {}, cancel() {}, key() {} } as unknown as Parameters<typeof AnswerForm>[0]['flow']
    const body = 'gate 3 auto-merge-fail: wave PR https://github.com/o/r/pull/9 has no passing CI and the whole story'
    const html = renderToStaticMarkup(createElement(AnswerForm, { state, flow, note: 'n', entry: body }))
    expect(html).toMatch(/<p class="answer-entry">gate 3 auto-merge-fail: wave PR https:\/\/github.com\/o\/r\/pull\/9 has no passing CI and the whole story<\/p>/)
    expect(html.indexOf('answer-entry')).toBeLessThan(html.indexOf('<textarea'))
    // Without it, no entry line.
    expect(renderToStaticMarkup(createElement(AnswerForm, { state, flow, note: 'n' }))).not.toMatch(/answer-entry/)
  })
})

describe('terminal tab on the screen', () => {
  /** Renders with `window.openaflow.connectTerminals` on the page, as the desktop app's preload puts it. */
  function inDesktop<T>(fn: () => T): T {
    const g = globalThis as { window?: unknown }
    const had = 'window' in g
    const before = g.window
    g.window = { openaflow: { connectTerminals: () => Promise.resolve() } }
    try {
      return fn()
    } finally {
      if (had) g.window = before
      else delete g.window
    }
  }
  const session = (over: Partial<HostedSession> = {}): HostedSession => ({
    marker: '7f3c9a12-0000-4000-8000-00000000abcd',
    sessionId: 'sess-x',
    liveSession: 'sess-x',
    sessions: ['sess-x'],
    skill: 'plan',
    startedAt: NOW - 120_000,
    state: 'live',
    hooked: true,
    prompted: true,
    ...over,
  })
  const files = { 'pod-docs/README.md': '# pod docs\n\npod docs: 2\n', 'pod-docs/handoff-queue.md': '' }
  const bare = (extra: Partial<BoardRepo> = {}): BoardRepo => ({ id: 'notes', name: 'notes-app', path: '/n', source: 'registered', model: buildRepoModel(files), agents: [], prs: [], claims: [], ...extra })
  const tabStore = (value: string | null) => {
    let v = value
    return { getItem: () => v, setItem: (_k: string, x: string) => void (v = x), removeItem: () => void (v = null) }
  }
  function screen(repo: BoardRepo, tab: string | null = null): string {
    const board = { generatedAt: NOW, gh: 'ok' as const, repos: [repo], actions: [] }
    const runs = listRuns(board, NOW)
    const selected = runs.find((r) => r.plan === undefined)!
    return renderToStaticMarkup(createElement(RunsScreen, { board, stream: 'live', runs, selected, view: 'pipeline', slice: undefined, now: NOW, storage: tabStore(tab) }))
  }
  const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const tabsOf = (html: string) =>
    [...html.matchAll(/<button[^>]*class="tab"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ label: text(m[1]!), open: /aria-expanded="true"/.test(m[0]), dot: /class="status s-run[ "]/.test(m[1]!) }))

  it('tab order', () => {
    // In the desktop app, a row with a hosted session lists Terminal after Waiting and Log.
    const live = bare({ hosted: [session()] })
    const desk = inDesktop(() => screen(live))
    expect(tabsOf(desk).map((t) => t.label)).toEqual(['Waiting 0', 'Log', 'Terminal'])
    // Closed until opened; its dot shows while the session runs.
    expect(tabsOf(desk).map((t) => t.open)).toEqual([false, false, false])
    expect(tabsOf(desk).map((t) => t.dot)).toEqual([false, false, true])
    expect(desk).not.toContain('class="terminal-panel"')

    // A stored Terminal opens it: the panel holds the terminal.
    const open = inDesktop(() => screen(live, 'terminal'))
    expect(tabsOf(open).map((t) => t.open)).toEqual([false, false, true])
    expect(open).toMatch(/<div id="tab-terminal" class="tab-slot"><div class="terminal-panel">/)

    // An ended session: the tab stays, with no dot, and opens on the stop bar.
    const ended = bare({ hosted: [session({ state: 'ended', exitCode: 0, endedAt: NOW - 60_000 })] })
    const stop = inDesktop(() => screen(ended, 'terminal'))
    expect(tabsOf(stop).map((t) => [t.label, t.dot])).toEqual([['Waiting 0', false], ['Log', false], ['Terminal', false]])
    expect(stop).toContain('class="stop-bar"')

    // No hosted session: no Terminal tab, and a stored Terminal reads closed.
    const none = inDesktop(() => screen(bare(), 'terminal'))
    expect(tabsOf(none).map((t) => t.label)).toEqual(['Waiting 0', 'Log'])
    expect(none).not.toContain('tab-terminal')

    // The browser build: no Terminal tab, a stored Terminal reads closed, and the session's status shows under the card.
    const web = screen(live, 'terminal')
    expect(tabsOf(web).map((t) => t.label)).toEqual(['Waiting 0', 'Log'])
    expect(web).not.toContain('tab-terminal')
    expect(web).toContain('class="term-note"')
    expect(text(web)).toContain('Live')
    // The running card already says to open the desktop app: the note doesn't say it twice.
    expect(text(web).split(DESKTOP_TERMINAL).length - 1).toBe(1)
    // An ended session's card has no desktop note, so the line under it says it.
    const webEnded = screen(ended)
    expect(webEnded).toContain('class="term-note"')
    expect(text(webEnded)).toContain('Ended · Claude exited')
    expect(text(webEnded).split(DESKTOP_TERMINAL).length - 1).toBe(1)
  })
})
