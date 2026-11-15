import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TERMINAL_FONT_SIZE, readTerminalLook, terminalLook, watchTerminalLook, type StyleSource } from './terminal-theme.ts'

// The terminal's look comes from the page's tokens (plan terminal-host, ## Look; sprint terminal-tab §8).

const here = dirname(fileURLToPath(import.meta.url))
const tokensCss = readFileSync(join(here, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Custom properties of the first `{ … }` block after `selector`. */
function tokensAfter(selector: string): Record<string, string> {
  const at = tokensCss.indexOf(selector)
  if (at < 0) throw new Error(`selector not found: ${selector}`)
  const open = tokensCss.indexOf('{', at)
  const body = tokensCss.slice(open + 1, tokensCss.indexOf('}', open))
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1]!, m[2]!.trim()]))
}

const light = tokensAfter(':root {')
const dark = { ...light, ...tokensAfter(':root[data-theme="dark"]') }
const THEMES = [['light', light], ['dark', dark]] as const

/** A computed style as the browser gives it: custom properties keep the space after the colon. */
const styleOf = (tokens: Record<string, string>): StyleSource => ({ getPropertyValue: (name) => (name in tokens ? ` ${tokens[name]}` : '') })

// ---- colour math (WCAG 2.x) ----
function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (!hex) throw new Error(`not a colour this test reads: ${value}`)
  return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as [number, number, number]
}
function luminance(value: string): number {
  const [r, g, b] = rgb(value).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
/** `a` at `alpha` over `b`, as hex. */
function over(a: string, alpha: number, b: string): string {
  const [x, y] = [rgb(a), rgb(b)]
  return '#' + x.map((v, i) => Math.round(v * alpha + y[i]! * (1 - alpha)).toString(16).padStart(2, '0')).join('')
}

// The page's own window fits both, so a screen passes `window` with no cast.
const windowFits: typeof window extends Parameters<typeof watchTerminalLook>[0] & Parameters<typeof readTerminalLook>[0] ? true : false = true

describe('terminal theme', () => {
  it('theme from tokens', () => {
    expect(windowFits).toBe(true)
    expect(TERMINAL_FONT_SIZE).toBe(13)
    for (const [name, t] of THEMES) {
      const look = terminalLook(styleOf(t))
      expect(look.theme, name).toEqual({
        background: t['--surface'],
        foreground: t['--fg'],
        cursor: t['--focus'],
        cursorAccent: t['--surface'],
        selectionBackground: t['--border-strong'],
        selectionForeground: t['--fg'],
      })
      expect(look.fontFamily, name).toBe(t['--mono'])
      expect(look.fontSize, name).toBe(13)
      // ANSI colours stay xterm's own.
      expect(Object.keys(look.theme).some((k) => /black|red|green|yellow|blue|magenta|cyan|white|extended/i.test(k)), name).toBe(false)
    }
    // Light and dark differ where the tokens do.
    expect(terminalLook(styleOf(light)).theme.background).not.toBe(terminalLook(styleOf(dark)).theme.background)
  })

  it('a token the page lacks leaves xterm its default, and the font a generic mono', () => {
    const look = terminalLook(styleOf({ '--fg': '#123456' }))
    expect(look.theme).toEqual({ foreground: '#123456', selectionForeground: '#123456' })
    expect(look.fontFamily).toBe('monospace')
    expect(look.fontSize).toBe(13)
  })

  it('reads the root element computed style', () => {
    const root = { tag: 'html' }
    const seen: unknown[] = []
    const win = {
      document: { documentElement: root },
      getComputedStyle: (el: unknown) => {
        seen.push(el)
        return styleOf(dark)
      },
    }
    expect(readTerminalLook(win).theme.background).toBe(dark['--surface'])
    expect(seen).toEqual([root])
  })

  it('follows the page theme: a data-theme change and a system change each read again, until stopped', () => {
    let tokens: Record<string, string> = dark
    let mutate: (() => void) | undefined
    let observed: { target: unknown; options: unknown } | undefined
    let disconnected = 0
    const mediaListeners = new Set<() => void>()
    const root = {}
    const win = {
      document: { documentElement: root },
      getComputedStyle: () => styleOf(tokens),
      MutationObserver: class {
        constructor(cb: () => void) {
          mutate = cb
        }
        observe(target: unknown, options: unknown) {
          observed = { target, options }
        }
        disconnect() {
          disconnected++
        }
      },
      matchMedia: (query: string) => {
        expect(query).toBe('(prefers-color-scheme: dark)')
        return {
          addEventListener: (_: 'change', fn: () => void) => mediaListeners.add(fn),
          removeEventListener: (_: 'change', fn: () => void) => mediaListeners.delete(fn),
        }
      },
    }
    const looks: string[] = []
    const stop = watchTerminalLook(win, (look) => looks.push(look.theme.background!))
    expect(observed).toEqual({ target: root, options: { attributes: true, attributeFilter: ['data-theme'] } })

    tokens = light
    mutate!()
    tokens = dark
    for (const fn of mediaListeners) fn()
    expect(looks).toEqual([light['--surface'], dark['--surface']])

    stop()
    expect(disconnected).toBe(1)
    expect(mediaListeners.size).toBe(0)
  })

  it('contrast', () => {
    for (const [name, t] of THEMES) {
      const { theme } = terminalLook(styleOf(t))
      for (const key of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground'] as const) {
        expect(/^#[0-9a-f]{6}$/i.test(theme[key] ?? ''), `${name}: ${key} is ${theme[key]}`).toBe(true)
      }
      const bg = theme.background!
      const checks: [string, number, number][] = [
        ['text on the terminal', contrast(theme.foreground!, bg), 4.5],
        // The DOM renderer paints the selection colour as given; the canvas ones lay it at 30% over the background.
        ['text on the selection', contrast(theme.selectionForeground!, theme.selectionBackground!), 4.5],
        ['text on the faint selection', contrast(theme.selectionForeground!, over(theme.selectionBackground!, 0.3, bg)), 4.5],
        ['the cursor on the terminal', contrast(theme.cursor!, bg), 3],
        ['the letter under a block cursor', contrast(theme.cursorAccent!, theme.cursor!), 4.5],
      ]
      for (const [what, ratio, min] of checks) expect(ratio, `${name}: ${what} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min)
    }
  })
})
