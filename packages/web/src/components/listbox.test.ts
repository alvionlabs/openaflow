import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CLOSED, TYPEAHEAD_MS, closeListbox, hoverAt, listboxKey, pickAt, toggleListbox, type ListboxItem, type ListboxKey, type ListboxState } from './listbox.ts'

// The "Start with" listbox (sprint terminal-tab §8): a button that opens a list of options, Plain session after a
// divider. Focus stays on the button; the keys follow the select-only combobox pattern, with wrap.

const ITEMS: ListboxItem[] = [
  { kind: 'option', value: 'plan', label: 'Plan', command: '/pod:plan', line: 'Interview, then write a plan.' },
  { kind: 'option', value: 'ship', label: 'Ship an idea', command: '/pod:ship', line: 'Research, plan, and build in one go.' },
  { kind: 'option', value: 'task', label: 'One task', command: '/pod:task', line: 'One change, one engineer, one PR.' },
  { kind: 'option', value: 'research', label: 'Research', command: '/pod:research', line: 'Look into a question and write a report.' },
  { kind: 'option', value: 'idea', label: 'Park an idea', command: '/pod:idea', line: 'Save an idea for later.' },
  { kind: 'divider' },
  { kind: 'option', value: 'plain', label: 'Plain session', line: 'Claude with no prompt.' },
]
const DIVIDER = 5
const indexOf = (value: string) => ITEMS.findIndex((i) => i.kind === 'option' && i.value === value)

type Key = string | (Partial<ListboxKey> & { key: string })

/** A controlled listbox: each pick becomes the value, as the form does. */
function driver(value = 'plan', items: readonly ListboxItem[] = ITEMS) {
  let state: ListboxState = CLOSED
  let now = 1_000
  const picks: string[] = []
  const press = (key: Key, after = 50) => {
    now += after
    const e = typeof key === 'string' ? { key } : key
    const step = listboxKey(items, value, state, { now, ...e })
    state = step.state
    if (step.pick !== undefined) {
      picks.push(step.pick)
      value = step.pick
    }
    return step
  }
  return {
    press,
    get state() {
      return state
    },
    set state(s: ListboxState) {
      state = s
    },
    get value() {
      return value
    },
    picks,
    wait: (ms: number) => (now += ms),
  }
}

describe('listbox', () => {
  it('keyboard', () => {
    const d = driver()

    // Closed: arrow down opens on the current pick, and takes the key.
    expect(d.press('ArrowDown').handled).toBe(true)
    expect(d.state.open).toBe(true)
    expect(d.state.active).toBe(indexOf('plan'))

    // Down moves, skips the divider, and wraps.
    for (const v of ['ship', 'task', 'research', 'idea', 'plain', 'plan']) {
      expect(d.press('ArrowDown').handled).toBe(true)
      expect(d.state.active, v).toBe(indexOf(v))
    }
    // Up wraps to the end and skips the divider on the way back.
    d.press('ArrowUp')
    expect(d.state.active).toBe(indexOf('plain'))
    d.press('ArrowUp')
    expect(d.state.active).toBe(indexOf('idea'))
    expect(d.state.active).not.toBe(DIVIDER)

    d.press('Home')
    expect(d.state.active).toBe(indexOf('plan'))
    d.press('End')
    expect(d.state.active).toBe(indexOf('plain'))

    // Enter picks and closes.
    expect(d.press('Enter')).toMatchObject({ handled: true, pick: 'plain' })
    expect(d.state.open).toBe(false)
    expect(d.value).toBe('plain')

    // Opened again, the list starts on the current pick.
    d.press('ArrowUp')
    expect(d.state).toMatchObject({ open: true, active: indexOf('plain') })

    // Escape closes and keeps the old pick, and takes the key, so a modal around it stays open.
    d.press('Home')
    const esc = d.press('Escape')
    expect(esc.handled).toBe(true)
    expect(esc.pick).toBeUndefined()
    expect(d.state.open).toBe(false)
    expect(d.value).toBe('plain')
    // Closed, Escape is not the listbox's: the modal closes as before.
    expect(d.press('Escape').handled).toBe(false)

    // Space opens, and picks while open.
    d.press(' ')
    expect(d.state).toMatchObject({ open: true, active: indexOf('plain') })
    d.press('Home')
    expect(d.press(' ')).toMatchObject({ handled: true, pick: 'plan' })
    expect(d.state.open).toBe(false)

    // Enter opens too.
    d.press('Enter')
    expect(d.state).toMatchObject({ open: true, active: indexOf('plan') })

    // Tab closes and keeps the old pick; focus moves on, so the key is not taken.
    d.press('ArrowDown')
    const tab = d.press('Tab')
    expect(tab).toMatchObject({ handled: false })
    expect(tab.pick).toBeUndefined()
    expect(d.state.open).toBe(false)
    expect(d.value).toBe('plan')

    // Alt+Down opens; Alt+Up picks and closes.
    d.press({ key: 'ArrowDown', altKey: true })
    expect(d.state).toMatchObject({ open: true, active: indexOf('plan') })
    d.press('ArrowDown')
    expect(d.press({ key: 'ArrowUp', altKey: true })).toMatchObject({ handled: true, pick: 'ship' })
    expect(d.state.open).toBe(false)

    // Home and End open at the first and last option.
    d.press('End')
    expect(d.state).toMatchObject({ open: true, active: indexOf('plain') })
    d.press('Escape')
    d.press('Home')
    expect(d.state).toMatchObject({ open: true, active: indexOf('plan') })
    d.press('Escape')

    // Keys with Ctrl or Meta are the page's.
    expect(d.press({ key: 'p', ctrlKey: true }).handled).toBe(false)
    expect(d.press({ key: 'ArrowDown', metaKey: true }).handled).toBe(false)
    expect(d.state.open).toBe(false)
    expect(d.picks).toEqual(['plain', 'plan', 'ship'])
  })

  it('typeahead', () => {
    const d = driver()
    // Closed, a letter opens on the next option that starts with it.
    expect(d.press('p').handled).toBe(true)
    expect(d.state).toMatchObject({ open: true, active: indexOf('idea') })
    // The same letter again cycles through the options that start with it, past the divider.
    d.press('p')
    expect(d.state.active).toBe(indexOf('plain'))
    d.press('P')
    expect(d.state.active).toBe(indexOf('plan'))

    // After a pause the search starts again.
    d.wait(TYPEAHEAD_MS + 1)
    d.press('r')
    expect(d.state.active).toBe(indexOf('research'))

    // Letters typed close together are one prefix, matched from the active option on.
    d.wait(TYPEAHEAD_MS + 1)
    d.press('p')
    d.press('l')
    d.press('a')
    d.press('i')
    expect(d.state.active).toBe(indexOf('plain'))
    // Space inside a word is part of it, and does not pick.
    expect(d.press(' ').pick).toBeUndefined()
    d.press('s')
    expect(d.state).toMatchObject({ open: true, active: indexOf('plain') })

    // No match: the active option stays.
    d.wait(TYPEAHEAD_MS + 1)
    expect(d.press('z').handled).toBe(true)
    expect(d.state.active).toBe(indexOf('plain'))

    // After the pause, Space picks again.
    d.wait(TYPEAHEAD_MS + 1)
    expect(d.press(' ')).toMatchObject({ pick: 'plain' })
  })

  it('pointer: a click picks and closes, a hover moves, and the divider does nothing', () => {
    let state = toggleListbox(ITEMS, 'plan', CLOSED)
    expect(state).toMatchObject({ open: true, active: indexOf('plan') })
    state = hoverAt(ITEMS, state, indexOf('task'))
    expect(state.active).toBe(indexOf('task'))
    expect(hoverAt(ITEMS, state, DIVIDER)).toEqual(state)
    expect(hoverAt(ITEMS, state, 99)).toEqual(state)

    const onDivider = pickAt(ITEMS, state, DIVIDER)
    expect(onDivider.pick).toBeUndefined()
    expect(onDivider.state.open).toBe(true)

    const step = pickAt(ITEMS, state, indexOf('plain'))
    expect(step.pick).toBe('plain')
    expect(step.state.open).toBe(false)

    // The button toggles; a blur closes and keeps the pick.
    expect(toggleListbox(ITEMS, 'plan', state).open).toBe(false)
    expect(closeListbox(state)).toEqual(CLOSED)
  })

  it('edges: an unknown value opens on the first option; one option wraps to itself; no option never opens', () => {
    const d = driver('gone')
    d.press('ArrowDown')
    expect(d.state).toMatchObject({ open: true, active: indexOf('plan') })

    const one: ListboxItem[] = [{ kind: 'divider' }, { kind: 'option', value: 'only', label: 'Only' }, { kind: 'divider' }]
    const o = driver('only', one)
    o.press('ArrowDown')
    expect(o.state.active).toBe(1)
    o.press('ArrowDown')
    expect(o.state.active).toBe(1)
    o.press('ArrowUp')
    expect(o.state.active).toBe(1)

    const none = driver('x', [{ kind: 'divider' }])
    expect(none.press('ArrowDown').handled).toBe(false)
    expect(none.state.open).toBe(false)
    expect(toggleListbox([], 'x', CLOSED).open).toBe(false)
  })
})

// ---- the look: listbox.css ----

const here = dirname(fileURLToPath(import.meta.url))
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const listboxCss = () => stripComments(readFileSync(join(here, 'listbox.css'), 'utf8'))
const tokensCss = stripComments(readFileSync(join(here, '..', 'theme', 'tokens.css'), 'utf8'))

function tokensAfter(selector: string): Record<string, string> {
  const at = tokensCss.indexOf(selector)
  const open = tokensCss.indexOf('{', at)
  const body = tokensCss.slice(open + 1, tokensCss.indexOf('}', open))
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1]!, m[2]!.trim()]))
}
const light = tokensAfter(':root {')
const dark = { ...light, ...tokensAfter(':root[data-theme="dark"]') }

type Rule = { selectors: string[]; decls: [string, string][] }

/** Flat list of style rules, the ones inside `@media`, `@supports` and `@container` included. */
function rules(css: string): Rule[] {
  const out: Rule[] = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const prelude = css.slice(i, open).trim()
    let depth = 0
    let close = open
    for (; close < css.length; close++) {
      if (css[close] === '{') depth++
      else if (css[close] === '}' && --depth === 0) break
    }
    const body = css.slice(open + 1, close)
    if (/^@(media|supports|container)/.test(prelude)) out.push(...rules(body))
    else if (!prelude.startsWith('@')) {
      const decls = [...body.matchAll(/(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;}]+)/gi)].map((m) => [m[1]!.toLowerCase(), m[2]!.trim()] as [string, string])
      out.push({ selectors: prelude.split(',').map((s) => s.trim()), decls })
    }
    i = close + 1
  }
  return out
}

const NAMED = /\b(black|white|red|green|blue|gr[ae]y|silver|orange|yellow|purple|pink|navy|teal|maroon|olive|lime|aqua|fuchsia|brown|gold)\b/i
const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i
const TEXT_COLOURS = new Set(['var(--fg)', 'var(--muted)', 'inherit', 'currentcolor'])

/** What breaks the tokens-only rule, as readable lines. */
function offences(css: string, tokens: Set<string>): string[] {
  const out: string[] = []
  for (const r of rules(css)) {
    const where = r.selectors.join(', ')
    for (const [prop, value] of r.decls) {
      if (prop.startsWith('--')) out.push(`${where}: declares ${prop} (no new tokens)`)
      if (LITERAL.test(value) || NAMED.test(value)) out.push(`${where}: ${prop}: ${value} (a colour literal)`)
      for (const m of value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) if (!tokens.has(m[1]!)) out.push(`${where}: ${m[1]} is not a token`)
      // Status colours (--blocked --needs-you --running --ready --idle) colour dots, never text.
      if ((prop === 'color' || prop === '-webkit-text-fill-color') && !TEXT_COLOURS.has(value.toLowerCase())) out.push(`${where}: color: ${value} (text is --fg or --muted)`)
      if (prop === 'font-family' && !/^var\(--(?:font|mono)\)$/.test(value)) out.push(`${where}: font-family: ${value}`)
      if (prop === 'font-size' && !/^var\(--size-[a-z0-9]+\)$/.test(value)) out.push(`${where}: font-size: ${value}`)
      if (prop === 'font' && (!/var\(--(?:font|mono)\)/.test(value) || !/var\(--size-[a-z0-9]+\)/.test(value))) out.push(`${where}: font: ${value}`)
    }
  }
  return out
}

describe('listbox look', () => {
  it('tokens only', () => {
    const tokens = new Set(Object.keys(light))
    // The check catches what it is for, and lets token-only CSS through.
    const bad = [
      '.a { background: #0a0a0a }',
      '.a { box-shadow: 0 0 4px rgb(0 0 0 / 0.6) }',
      '.a { color: var(--running) }',
      '.a { color: var(--needs-you) }',
      '.a { color: var(--ready) }',
      '.a { color: var(--blocked) }',
      '.a { color: var(--idle) }',
      '@media (max-width: 480px) { .a { color: var(--ready) } }',
      '.a { border-color: var(--accent) }',
      '.a { --dim: 0.6 }',
      '.a { font-size: 13px }',
      '.a { font-family: Inter }',
    ]
    for (const css of bad) expect(offences(css, tokens), css).not.toEqual([])
    expect(offences('.a { background: var(--hover); color: var(--muted); font: 500 var(--size-small) / 1.4 var(--mono) }', tokens)).toEqual([])

    const css = listboxCss()
    expect(rules(css).length, 'listbox.css has rules').toBeGreaterThan(4)
    expect(offences(css, tokens)).toEqual([])
    // The divider is a rule in --border; the active option sits on --hover.
    expect(css).toMatch(/\.listbox-divider\s*\{[^}]*var\(--border\)/)
    expect(css).toMatch(/\.listbox-option\[data-active\][^{]*\{[^}]*background:\s*var\(--hover\)/)
  })

  it('text on the list and on the active option reaches 4.5:1', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const s = parseInt(hex.slice(i, i + 2), 16) / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }) as [number, number, number]
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    // The colours listbox.css sets, plus the grounds it sits on from base.css: .input (--bg) and .menu (--surface).
    const used = (prop: RegExp) => {
      const out = new Set<string>()
      for (const r of rules(listboxCss())) for (const [p, v] of r.decls) if (prop.test(p)) for (const m of v.matchAll(/var\((--[a-z0-9-]+)\)/g)) out.add(m[1]!)
      return out
    }
    const texts = [...used(/^color$/)]
    const grounds = [...new Set([...used(/^background(-color)?$/), '--bg', '--surface'])]
    expect(texts.sort()).toEqual(['--fg', '--muted'])
    expect(grounds).toContain('--hover')
    for (const [name, t] of [['light', light], ['dark', dark]] as const) {
      for (const text of texts) for (const ground of grounds) {
        const r = ratio(t[text]!, t[ground]!)
        expect(r, `${name}: ${text} on ${ground} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
