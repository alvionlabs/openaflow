import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin')
const SCRIPT = join(PLUGIN, 'scripts', 'record.sh')
const MARKER = '3f2b8c1e-5a47-4d9b-8e21-7c6d0a9b4f13'

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0
if (!hasSh) console.log('record.test.ts: no `sh` starts on this machine, so the script tests are skipped')

type Env = Record<string, string | undefined>

/** Runs the hook the way Claude Code does: `sh <script>`, the event JSON on stdin. `umask` sets the caller's umask first. */
const runHook = (input: string, env: Env, umask?: string) => {
  const full: Env = { PATH: process.env.PATH, ...env }
  for (const key of Object.keys(full)) if (full[key] === undefined) delete full[key]
  const args = umask === undefined ? [SCRIPT] : ['-c', `umask ${umask}; exec sh "$1"`, 'sh', SCRIPT]
  const result = spawnSync('sh', args, { input, env: full as NodeJS.ProcessEnv, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const modeOf = (path: string) => statSync(path).mode & 0o777

let root: string
let seq = 0
const freshDir = () => join(root, `hooks-${seq++}`)

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'oaf-record-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')

describe.skipIf(!hasSh)('record.sh', () => {
  test('a hook event becomes one line in the run\'s file', () => {
    const dir = freshDir()
    const payload = { session_id: 'abc', hook_event_name: 'SessionStart', source: 'startup' }
    const before = Date.now()
    const res = runHook(JSON.stringify(payload), { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: dir })
    const after = Date.now()
    expect(res).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(readdirSync(dir)).toEqual([`${MARKER}.jsonl`])
    const rows = lines(join(dir, `${MARKER}.jsonl`))
    expect(rows).toHaveLength(1)
    const row = JSON.parse(rows[0]!)
    expect(Object.keys(row).sort()).toEqual(['at', 'payload', 'v'])
    expect(row.v).toBe(1)
    expect(row.payload).toEqual(payload)
    expect(row.at).toBeGreaterThanOrEqual(before - 1000)
    expect(row.at).toBeLessThanOrEqual(after + 1000)
    expect(Number.isInteger(row.at)).toBe(true)
    // a second event appends
    runHook(JSON.stringify({ ...payload, hook_event_name: 'Stop' }), { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: dir })
    expect(lines(join(dir, `${MARKER}.jsonl`))).toHaveLength(2)
  })

  test('no marker, no write', () => {
    const dir = freshDir()
    const cases: { name: string; env: Env }[] = [
      { name: 'unset marker', env: { OPENAFLOW_HOOKS_DIR: dir } },
      { name: 'empty marker', env: { OPENAFLOW_RUN: '', OPENAFLOW_HOOKS_DIR: dir } },
      { name: 'not a uuid', env: { OPENAFLOW_RUN: 'abc', OPENAFLOW_HOOKS_DIR: dir } },
      { name: 'uppercase uuid', env: { OPENAFLOW_RUN: MARKER.toUpperCase(), OPENAFLOW_HOOKS_DIR: dir } },
      { name: 'uuid v1', env: { OPENAFLOW_RUN: '3f2b8c1e-5a47-1d9b-8e21-7c6d0a9b4f13', OPENAFLOW_HOOKS_DIR: dir } },
      { name: 'path escape', env: { OPENAFLOW_RUN: `../${MARKER}`, OPENAFLOW_HOOKS_DIR: dir } },
      { name: 'marker plus suffix', env: { OPENAFLOW_RUN: `${MARKER}x`, OPENAFLOW_HOOKS_DIR: dir } },
      { name: 'unset folder', env: { OPENAFLOW_RUN: MARKER } },
      { name: 'empty folder', env: { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: '' } },
      { name: 'relative folder', env: { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: 'rel-hooks' } },
    ]
    const cwd = process.cwd()
    for (const { name, env } of cases) {
      const res = runHook('{"hook_event_name":"Stop"}', env)
      expect({ name, ...res }).toEqual({ name, status: 0, stdout: '', stderr: '' })
    }
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(cwd, 'rel-hooks'))).toBe(false)
  })

  test('an unwritable folder never fails the hook', () => {
    // A file where the folder should be: mkdir -p and the append both fail.
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x')
    const res = runHook('{"hook_event_name":"Stop"}', { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: join(blocker, 'sub') })
    expect(res).toEqual({ status: 0, stdout: '', stderr: '' })
    // A folder that exists but where the run's file is a directory: the append fails.
    const dir = freshDir()
    mkdirSync(join(dir, `${MARKER}.jsonl`), { recursive: true })
    const res2 = runHook('{"hook_event_name":"Stop"}', { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: dir })
    expect(res2).toEqual({ status: 0, stdout: '', stderr: '' })
  })

  test('stdin edges', () => {
    const dir = freshDir()
    const env = { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: dir }
    const file = join(dir, `${MARKER}.jsonl`)
    // pretty-printed, CRLF input, an escaped newline inside a string
    const pretty = '{\r\n  "hook_event_name": "UserPromptSubmit",\r\n  "prompt": "a\\nb",\r\n  "session_id": "s1"\r\n}\r\n'
    expect(runHook(pretty, env)).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(runHook('', env).status).toBe(0)
    expect(runHook('\n', env).status).toBe(0)
    const rows = lines(file)
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row).not.toMatch(/[\r\n]/)
    const parsed = rows.map((r) => JSON.parse(r))
    expect(parsed[0].payload).toEqual({ hook_event_name: 'UserPromptSubmit', prompt: 'a\nb', session_id: 's1' })
    expect(parsed[1].payload).toBeNull()
    expect(parsed[2].payload).toBeNull()
    expect(parsed[1].v).toBe(1)
  })

  test('big payloads', () => {
    const dir = freshDir()
    const env = { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: dir }
    const file = join(dir, `${MARKER}.jsonl`)
    const make = (kb: number) =>
      JSON.stringify({ session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x'.repeat(kb * 1024) } })
    expect(runHook(make(63), env)).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(runHook(make(65), env)).toEqual({ status: 0, stdout: '', stderr: '' })
    const [whole, cut] = lines(file).map((l) => JSON.parse(l))
    expect(whole.payload.tool_input.command).toHaveLength(63 * 1024)
    expect(cut.payload).toBeUndefined()
    expect(cut).toMatchObject({ v: 1, cut: true, event: 'PreToolUse', session: 'sess-1' })
    expect(Object.keys(cut).sort()).toEqual(['at', 'cut', 'event', 'session', 'v'])
  })
})

// The file holds every prompt and tool input: only the user may read it, as Claude Code keeps its own. Windows has no modes.
describe.skipIf(!hasSh || process.platform === 'win32')('record.sh file modes', () => {
  const event = '{"session_id":"s1","hook_event_name":"UserPromptSubmit","prompt":"my secret"}'

  test('a new hooks folder is 0700 and the file 0600, under a loose umask', () => {
    const dir = freshDir()
    expect(runHook(event, { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: dir }, '022')).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(modeOf(dir).toString(8)).toBe('700')
    expect(modeOf(join(dir, `${MARKER}.jsonl`)).toString(8)).toBe('600')
    // A second event keeps both.
    runHook(event, { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: dir }, '022')
    expect(lines(join(dir, `${MARKER}.jsonl`))).toHaveLength(2)
    expect(modeOf(dir).toString(8)).toBe('700')
    expect(modeOf(join(dir, `${MARKER}.jsonl`)).toString(8)).toBe('600')
  })

  test('a hooks folder that exists with loose modes becomes 0700', () => {
    const dir = freshDir()
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    // An older run's file, written before this rule: the 0700 folder shields it.
    const old = join(dir, '00000000-0000-4000-8000-000000000000.jsonl')
    writeFileSync(old, '{}\n', { mode: 0o644 })
    chmodSync(old, 0o644)
    expect(runHook(event, { OPENAFLOW_RUN: MARKER, OPENAFLOW_HOOKS_DIR: dir }, '022')).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(modeOf(dir).toString(8)).toBe('700')
    expect(modeOf(join(dir, `${MARKER}.jsonl`)).toString(8)).toBe('600')
  })
})

describe('the plugin files', () => {
  test('the plugin registers the eight events', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'))
    expect(manifest.name).toBe('openaflow-hooks')
    expect(manifest.skills).toBeUndefined()
    expect(existsSync(join(PLUGIN, 'skills'))).toBe(false)
    const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks as Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]>
    expect(Object.keys(hooks).sort()).toEqual(
      ['Notification', 'PermissionRequest', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit'].sort(),
    )
    for (const groups of Object.values(hooks)) {
      expect(groups).toHaveLength(1)
      expect(groups[0]!.hooks).toEqual([{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/record.sh"', timeout: 10 }])
    }
  })
})
