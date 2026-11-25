import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Board, SettingsView } from '@openaflow/model'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import type { ScopeProbe } from './run-wrapper.ts'
import { createSettingsActions, createSettingsRead, settingsView } from './settings-routes.ts'
import { createSettingsStore } from './settings-store.ts'

const PORT = 3070
const TOKEN = 'test-token'
const HOST = { host: `127.0.0.1:${PORT}` }
const READ = { ...HOST, 'x-openaflow-token': TOKEN }
const POST = { ...READ, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/json' }
const BOARD: Board = { generatedAt: 1, gh: 'unknown', repos: [] }
const DEFAULT_WRAP = 'systemd-run --user --scope --quiet --unit=openaflow-run-{runId}.scope'
const DEFAULT_STOP = 'systemctl --user stop openaflow-run-{runId}.scope'
const ON: ScopeProbe = { on: true, systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl' }
const CLAUDE = '/home/me/.local/bin/claude'
const PLUGIN = '/opt/openaflow/hooks-plugin'

let root: string
let file: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'oaf-settings-routes-')))
  file = join(root, 'settings.json')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function appOf(o: { platform?: NodeJS.Platform; probe?: ScopeProbe; failWrite?: boolean; workflowDir?: string } = {}) {
  const lines: string[] = []
  const store = createSettingsStore({ file, log: (l) => lines.push(l), ...(o.failWrite ? { rename: async () => Promise.reject(new Error('disk full')) } : {}) })
  const deps = { store, platform: o.platform ?? 'linux', claude: () => CLAUDE, pluginDir: PLUGIN, workflowDir: () => o.workflowDir, ...(o.probe ? { probe: async () => o.probe! } : {}) }
  const app = createApp({
    ports: [PORT],
    token: TOKEN,
    source: { board: () => BOARD, subscribe: () => () => {}, rebuild: async () => {} },
    addRepo: async () => ({ error: 'not a directory' }),
    timeline: async () => undefined,
    settings: createSettingsRead(deps),
    actions: new Hono().route('/', createSettingsActions(deps)),
  })
  const get = async (headers: Record<string, string> = READ) => {
    const res = await app.request('/api/settings', { headers })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const post = async (body: unknown, headers: Record<string, string> = POST) => {
    const res = await app.request('/api/actions/settings', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { get, post, lines }
}
const onDisk = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

describe('settings routes', () => {
  test('settings routes', async () => {
    const a = appOf({ probe: ON })
    // GET needs the token; POST needs the action guard's.
    expect(await a.get(HOST)).toEqual({ status: 403, body: { error: 'bad token' } })
    expect(await a.get({ ...READ, 'x-openaflow-token': 'nope' })).toEqual({ status: 403, body: { error: 'bad token' } })
    expect((await a.post({ scrollback: 300 }, { ...POST, 'x-openaflow-token': 'nope' })).status).toBe(403)
    const first = await a.get()
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ scrollback: 5000, wrapper: { runWrapper: DEFAULT_WRAP, stopCommand: DEFAULT_STOP, isDefault: true } })

    // The errors, first match.
    const errors: [unknown, number, string][] = [
      [{}, 400, 'bad request'],
      [{ other: 1 }, 400, 'bad request'],
      [{ scrollback: 300, other: 1 }, 400, 'bad request'],
      [{ scrollback: '300' }, 400, 'bad request'],
      [{ scrollback: null }, 400, 'bad request'],
      [{ runWrapper: 5 }, 400, 'bad request'],
      [{ stopCommand: false }, 400, 'bad request'],
      [{ scrollback: 50, runWrapper: 5 }, 400, 'bad request'],
      [{ scrollback: 99 }, 400, 'bad scrollback'],
      [{ scrollback: 100_001 }, 400, 'bad scrollback'],
      [{ scrollback: 150.5 }, 400, 'bad scrollback'],
      [{ scrollback: 99, runWrapper: 'a "b' }, 400, 'bad scrollback'],
      [{ runWrapper: 'a "b', stopCommand: '{x}' }, 400, 'run wrapper: unclosed quote'],
      [{ runWrapper: 'x'.repeat(1025) }, 400, 'run wrapper: too long'],
      [{ runWrapper: `w ${'{unit}'.repeat(20)}` }, 400, 'run wrapper: too long'],
      [{ runWrapper: '"" x' }, 400, 'run wrapper: no program'],
      [{ stopCommand: '{x}' }, 400, 'stop command: unknown placeholder {x}'],
      [{ stopCommand: 'a\nb' }, 400, 'stop command: bad text'],
    ]
    for (const [body, status, error] of errors) expect(await a.post(body), JSON.stringify(body)).toEqual({ status, body: { error } })
    expect((await a.post('[1]')).body).toEqual({ error: 'bad request' })
    // Nothing was written.
    expect(() => readFileSync(file)).toThrow()

    // Only the keys sent change; the answer is the view after the write.
    const one = await a.post({ scrollback: 300 })
    expect(one.status).toBe(200)
    expect(one.body).toMatchObject({ scrollback: 300, wrapper: { isDefault: true } })
    expect(onDisk()).toEqual({ v: 1, scrollback: 300 })
    const two = await a.post({ runWrapper: 'wrap --x', stopCommand: '' })
    expect(two.body).toMatchObject({ scrollback: 300, wrapper: { runWrapper: 'wrap --x', stopCommand: '', isDefault: false } })
    expect(onDisk()).toEqual({ v: 1, scrollback: 300, runWrapper: 'wrap --x', stopCommand: '' })
    expect((await a.get()).body).toEqual(two.body)

    // null and the default text (trimmed) are absent.
    expect((await a.post({ runWrapper: null })).body).toMatchObject({ wrapper: { runWrapper: DEFAULT_WRAP, stopCommand: '', isDefault: false } })
    expect(onDisk()).toEqual({ v: 1, scrollback: 300, stopCommand: '' })
    await a.post({ stopCommand: `  ${DEFAULT_STOP} ` })
    expect(onDisk()).toEqual({ v: 1, scrollback: 300 })
    await a.post({ runWrapper: 'w', stopCommand: 's' })
    expect((await a.post({ runWrapper: null, stopCommand: null })).body).toMatchObject({ wrapper: { isDefault: true } })
    expect(onDisk()).toEqual({ v: 1, scrollback: 300 })
    // A text that isn't the default is stored as sent; all-space is none.
    await a.post({ runWrapper: '   ' })
    expect(onDisk()).toEqual({ v: 1, scrollback: 300, runWrapper: '   ' })

    // A failed write: 500 not saved, and the file and the answer stay as before.
    const before = readFileSync(file, 'utf8')
    const view = (await a.get()).body
    const failing = appOf({ probe: ON, failWrite: true })
    expect(await failing.post({ scrollback: 900 })).toEqual({ status: 500, body: { error: 'not saved' } })
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect((await failing.get()).body).toEqual(view)
  })

  test('preview', () => {
    const at = (settings: { runWrapper?: string; stopCommand?: string }, o: { probe?: ScopeProbe; claude?: string; pluginDir?: string } = {}) =>
      settingsView({ scrollback: 5000, ...settings }, { platform: 'linux', claude: 'claude' in o ? o.claude : CLAUDE, pluginDir: 'pluginDir' in o ? o.pluginDir : PLUGIN, probe: 'probe' in o ? o.probe : ON }).wrapper!
    const tail = `${CLAUDE} --session-id "<session id>" --plugin-dir ${PLUGIN} "/pod:plan <your text>"`

    // Default, probe on: the default words as typed, with the run id shown.
    const on = at({})
    expect(on).toEqual({
      runWrapper: DEFAULT_WRAP,
      stopCommand: DEFAULT_STOP,
      isDefault: true,
      defaults: { runWrapper: DEFAULT_WRAP, stopCommand: DEFAULT_STOP },
      preview: `systemd-run --user --scope --quiet "--unit=openaflow-run-<run id>.scope" ${tail}`,
    })
    // Default, probe off: no wrapper words, the reason, and the stop skipped.
    const off = at({}, { probe: { on: false, reason: 'exit 1: Failed to connect to bus' } })
    expect(off).toMatchObject({ preview: tail, fallback: 'exit 1: Failed to connect to bus', stopSkipped: true, isDefault: true })
    // No probe (dev, pnpm start): the default words, no fallback.
    const dev = at({}, { probe: undefined })
    expect(dev.preview).toBe(on.preview)
    expect(dev).not.toHaveProperty('fallback')
    expect(dev).not.toHaveProperty('stopSkipped')
    // A changed wrapper: its words as typed, quoted again where needed; the absent stop is skipped.
    const changed = at({ runWrapper: `firejail --name='a b' '--x=say "hi"' {unit} {} ""` })
    expect(changed.preview).toBe(`firejail "--name=a b" "--x=say \\"hi\\"" "openaflow-run-<run id>.scope" {} "" ${tail}`)
    expect(changed).toMatchObject({ stopSkipped: true, isDefault: false })
    expect(changed).not.toHaveProperty('fallback')
    // A changed wrapper with the probe off: no fallback, it is not the default wrapper.
    expect(at({ runWrapper: 'wrap {runId}' }, { probe: { on: false, reason: 'x' } })).toMatchObject({ preview: `wrap "<run id>" ${tail}` })
    // Empty: no wrapper words; all-space too.
    expect(at({ runWrapper: '' })).toMatchObject({ preview: tail, stopSkipped: true })
    expect(at({ runWrapper: '   ' }).preview).toBe(tail)
    // A stop that is set is never skipped.
    for (const stopCommand of ['', 'kill-it {unit}']) {
      expect(at({ runWrapper: '', stopCommand })).not.toHaveProperty('stopSkipped')
      expect(at({ stopCommand }, { probe: { on: false, reason: 'x' } })).not.toHaveProperty('stopSkipped')
    }
    // No claude, no plugin folder.
    expect(at({ runWrapper: '' }, { claude: undefined, pluginDir: undefined }).preview).toBe('claude --session-id "<session id>" --plugin-dir "<plugin dir>" "/pod:plan <your text>"')
    // A claude path with a space is quoted.
    expect(at({ runWrapper: '' }, { claude: '/opt/my apps/claude' }).preview.startsWith('"/opt/my apps/claude" --session-id')).toBe(true)

    // macOS: both defaults empty, nothing skipped, no fallback.
    const mac = settingsView({ scrollback: 5000 }, { platform: 'darwin', claude: CLAUDE, pluginDir: PLUGIN, probe: { on: false, reason: 'not on Linux (darwin)' } }).wrapper!
    expect(mac).toEqual({ runWrapper: '', stopCommand: '', isDefault: true, defaults: { runWrapper: '', stopCommand: '' }, preview: tail })
    expect(settingsView({ scrollback: 5000, runWrapper: 'wrap' }, { platform: 'darwin', claude: CLAUDE, pluginDir: PLUGIN }).wrapper).not.toHaveProperty('stopSkipped')
  })

  test('preview shows both plugin dirs and the workflow add-dir', async () => {
    const WORKFLOW = '/opt/openaflow/workflows/claude-pod'
    const view = (workflowDir: string | undefined) => settingsView({ scrollback: 5000, runWrapper: '' }, { platform: 'linux', claude: CLAUDE, pluginDir: PLUGIN, workflowDir, probe: ON }).wrapper!.preview
    // With a bundle: the hooks plugin, then the workflow's add-dir and plugin dir, then the prompt, as a set-up repo's session starts.
    expect(view(WORKFLOW)).toBe(`${CLAUDE} --session-id "<session id>" --plugin-dir ${PLUGIN} --add-dir ${WORKFLOW} --plugin-dir ${WORKFLOW} "/pod:plan <your text>"`)
    // A folder with a space is quoted.
    expect(view('/opt/my apps/claude-pod')).toContain(`--plugin-dir ${PLUGIN} --add-dir "/opt/my apps/claude-pod" --plugin-dir "/opt/my apps/claude-pod" "/pod:plan`)
    // No bundle: the hooks plugin only, as every session starts then.
    expect(view(undefined)).toBe(`${CLAUDE} --session-id "<session id>" --plugin-dir ${PLUGIN} "/pod:plan <your text>"`)
    expect(view(undefined)).not.toContain('--add-dir')
    // Through the route: the folder is read at each answer.
    let dir: string | undefined = WORKFLOW
    const live = createSettingsRead({ store: createSettingsStore({ file, log: () => {} }), platform: 'linux', claude: () => CLAUDE, pluginDir: PLUGIN, workflowDir: () => dir })
    const preview = async () => ((await (await live.request('/')).json()) as SettingsView).wrapper!.preview
    expect(await preview()).toContain(`--plugin-dir ${PLUGIN} --add-dir ${WORKFLOW} --plugin-dir ${WORKFLOW} `)
    dir = undefined
    expect(await preview()).not.toContain(WORKFLOW)
    expect(((await appOf({ workflowDir: WORKFLOW }).get()).body.wrapper as { preview: string }).preview).toContain(`--add-dir ${WORKFLOW} --plugin-dir ${WORKFLOW} `)
  })

  test('windows has no wrapper', async () => {
    writeFileSync(file, JSON.stringify({ v: 1, scrollback: 250, runWrapper: 'wrap', stopCommand: 'stop' }))
    const a = appOf({ platform: 'win32' })
    expect(await a.get()).toEqual({ status: 200, body: { scrollback: 250 } satisfies SettingsView })
    for (const body of [{ runWrapper: 'wrap' }, { stopCommand: null }, { scrollback: 300, runWrapper: null }]) {
      expect(await a.post(body), JSON.stringify(body)).toEqual({ status: 400, body: { error: 'bad request' } })
    }
    expect(await a.post({ scrollback: 300 })).toEqual({ status: 200, body: { scrollback: 300 } })
    // The stored texts stay, ignored.
    expect(onDisk()).toEqual({ v: 1, scrollback: 300, runWrapper: 'wrap', stopCommand: 'stop' })
  })
})
