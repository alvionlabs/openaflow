import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { resumeCommand, sessionCommand, type SessionCommand, type SessionCommandInput, type ShimRead } from './session-command.ts'

const WIN = process.platform === 'win32'
const SESSION = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const MARKER = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d'
const SPECIAL = `% ^ " ' & | < > ! é 日本 🙂`

const linux = (over: Partial<SessionCommandInput> = {}): SessionCommandInput => ({
  claude: '/home/me/.local/bin/claude',
  repo: '/home/me/repo',
  skill: 'plan',
  text: 'add tags',
  sessionId: SESSION,
  runMarker: MARKER,
  pluginDir: '/opt/openaflow/resources/hooks-plugin',
  configDir: '/home/me/.config/openaflow-server',
  env: { PATH: '/usr/bin', HOME: '/home/me' },
  platform: 'linux',
  ...over,
})

const ok = (r: SessionCommand | string): SessionCommand => {
  if (typeof r === 'string') throw new Error(`expected a command, got the error word ${r}`)
  return r
}

describe('args', () => {
  test('exact args with one prompt last', () => {
    const r = ok(sessionCommand(linux()))
    expect(r.program).toBe('/home/me/.local/bin/claude')
    expect(r.cwd).toBe('/home/me/repo')
    expect(r.args).toEqual(['--session-id', SESSION, '--plugin-dir', '/opt/openaflow/resources/hooks-plugin', '/pod:plan add tags'])
    expect(r.typeYourself).toBeUndefined()
  })

  test('each skill gets its own command', () => {
    for (const skill of ['plan', 'ship', 'task', 'research', 'idea'] as const) {
      expect(ok(sessionCommand(linux({ skill, text: 'x' }))).args.at(-1)).toBe(`/pod:${skill} x`)
    }
  })

  test('a skill with no text gives /pod:<skill> alone', () => {
    for (const text of ['', '   ', '\n\t ']) {
      expect(ok(sessionCommand(linux({ skill: 'task', text }))).args).toEqual(['--session-id', SESSION, '--plugin-dir', '/opt/openaflow/resources/hooks-plugin', '/pod:task'])
    }
  })

  test('plain with no text gives no prompt; plain text is the prompt alone', () => {
    expect(ok(sessionCommand(linux({ skill: 'plain', text: ' ' }))).args).toEqual(['--session-id', SESSION, '--plugin-dir', '/opt/openaflow/resources/hooks-plugin'])
    expect(ok(sessionCommand(linux({ skill: 'plain', text: 'what is here?' }))).args).toEqual([
      '--session-id',
      SESSION,
      '--plugin-dir',
      '/opt/openaflow/resources/hooks-plugin',
      'what is here?',
    ])
    // a slash command typed as plain text is the user's own prompt
    expect(ok(sessionCommand(linux({ skill: 'plain', text: '/proof:pong hi' }))).args.at(-1)).toBe('/proof:pong hi')
  })

  test('never a print, bare, permission, or model flag', () => {
    for (const skill of ['plan', 'plain'] as const) {
      const args = ok(sessionCommand(linux({ skill }))).args
      for (const a of args.slice(0, 4)) expect(a).not.toMatch(/^-(p|-print|-bare|-model|-permission-mode|-dangerously-skip-permissions|-allowedTools)$/)
      expect(args.filter((a) => a.startsWith('-'))).toEqual(['--session-id', '--plugin-dir'])
    }
  })

  test('an unknown skill is refused', () => {
    expect(sessionCommand(linux({ skill: 'teach' as never }))).toBe('bad skill')
    expect(sessionCommand(linux({ skill: 'toString' as never }))).toBe('bad skill')
  })
})

describe('resume args', () => {
  const resume = (over: Partial<SessionCommandInput> = {}) => {
    const { skill: _skill, text: _text, ...rest } = linux(over)
    return resumeCommand(rest)
  }

  test('exactly --resume <id> --plugin-dir <dir>, in the repo folder, with no prompt and no --session-id', () => {
    const r = ok(resume())
    expect(r.program).toBe('/home/me/.local/bin/claude')
    expect(r.cwd).toBe('/home/me/repo')
    expect(r.args).toEqual(['--resume', SESSION, '--plugin-dir', '/opt/openaflow/resources/hooks-plugin'])
    expect(r.typeYourself).toBeUndefined()
  })

  test('bad ids are refused, and the new marker is never the resumed session', () => {
    for (const id of ['', 'abc', SESSION.toUpperCase(), `${SESSION}0`, ` ${SESSION}`, `-${SESSION.slice(1)}`, '--print']) {
      expect(resume({ sessionId: id }), id).toBe('bad id')
      expect(resume({ runMarker: id }), id).toBe('bad id')
    }
    expect(resume({ runMarker: SESSION })).toBe('bad id')
  })

  test('relative paths are refused', () => {
    for (const p of ['', 'repo', './repo', '~/repo']) {
      for (const key of ['claude', 'repo', 'pluginDir', 'configDir'] as const) expect(resume({ [key]: p }), `${key} ${p}`).toBe('bad path')
    }
  })
})

describe('text rules', () => {
  test('the text is trimmed', () => {
    expect(ok(sessionCommand(linux({ text: '  add tags  ' }))).args.at(-1)).toBe('/pod:plan add tags')
    expect(ok(sessionCommand(linux({ text: '\n add tags \r\n' }))).args.at(-1)).toBe('/pod:plan add tags')
  })

  test('a control character inside the text is refused', () => {
    for (const c of ['\u0000', '\u0007', '\t', '\n', '\r', '\u001b', '\u001f', '\u007f']) {
      expect(sessionCommand(linux({ text: `a${c}b` })), JSON.stringify(c)).toBe('bad text')
      expect(sessionCommand(linux({ skill: 'plain', text: `a${c}b` })), JSON.stringify(c)).toBe('bad text')
    }
    // U+0080 and up are not control characters here
    expect(ok(sessionCommand(linux({ text: 'a\u0080b' }))).args.at(-1)).toBe('/pod:plan a\u0080b')
  })

  test('2,000 characters pass, 2,001 are refused, counted after the trim and by code point', () => {
    const at = 'x'.repeat(2000)
    expect(ok(sessionCommand(linux({ text: `  ${at}  ` }))).args.at(-1)).toBe(`/pod:plan ${at}`)
    expect(sessionCommand(linux({ text: `${at}y` }))).toBe('bad text')
    const emoji = '🙂'.repeat(2000) // 4,000 UTF-16 units, 2,000 characters
    expect(ok(sessionCommand(linux({ skill: 'plain', text: emoji }))).args.at(-1)).toBe(emoji)
    expect(sessionCommand(linux({ skill: 'plain', text: `${emoji}🙂` }))).toBe('bad text')
  })

  test('plain text starting with - is refused; after a skill it is only text', () => {
    expect(sessionCommand(linux({ skill: 'plain', text: '--print hi' }))).toBe('bad text')
    expect(sessionCommand(linux({ skill: 'plain', text: '  -p' }))).toBe('bad text')
    expect(ok(sessionCommand(linux({ skill: 'task', text: '--print hi' }))).args.at(-1)).toBe('/pod:task --print hi')
    expect(ok(sessionCommand(linux({ skill: 'plain', text: 'a -b' }))).args.at(-1)).toBe('a -b')
  })
})

describe('special characters stay one argument', () => {
  test('on Linux', () => {
    const r = ok(sessionCommand(linux({ skill: 'task', text: SPECIAL })))
    expect(r.args).toHaveLength(5)
    expect(r.args.at(-1)).toBe(`/pod:task ${SPECIAL}`)
    expect(ok(sessionCommand(linux({ skill: 'plain', text: SPECIAL }))).args.at(-1)).toBe(SPECIAL)
  })

  test('on Windows through an npm shim', () => {
    const r = ok(sessionCommand(win({ skill: 'task', text: SPECIAL }, fakeWindows({ read: { file: 'C:\\nodejs\\node.exe', pre: [CLI] } }))))
    expect(r.args).toEqual([CLI, '--session-id', SESSION, '--plugin-dir', WIN_PLUGIN, `/pod:task ${SPECIAL}`])
  })
})

describe('ids and paths', () => {
  test('bad ids are refused', () => {
    const bad = ['', 'abc', SESSION.toUpperCase(), '6f1c2a3b-4d5e-1f60-8a7b-9c0d1e2f3a4b', '6f1c2a3b-4d5e-4f60-7a7b-9c0d1e2f3a4b', `${SESSION}0`, ` ${SESSION}`, `-${SESSION.slice(1)}`]
    for (const id of bad) {
      expect(sessionCommand(linux({ sessionId: id })), id).toBe('bad id')
      expect(sessionCommand(linux({ runMarker: id })), id).toBe('bad id')
    }
  })

  test('equal ids are refused', () => {
    expect(sessionCommand(linux({ runMarker: SESSION }))).toBe('bad id')
  })

  test('relative paths are refused', () => {
    for (const p of ['', 'repo', './repo', '../repo', '~/repo']) {
      expect(sessionCommand(linux({ repo: p })), p).toBe('bad path')
      expect(sessionCommand(linux({ pluginDir: p })), p).toBe('bad path')
      expect(sessionCommand(linux({ configDir: p })), p).toBe('bad path')
      expect(sessionCommand(linux({ claude: p })), p).toBe('bad path')
    }
    // Windows paths hang off a drive or a share; `\x` and `C:x` don't count
    for (const p of ['\\repo', 'C:repo', 'repo', '/home/me/repo']) {
      expect(sessionCommand(win({ repo: p })), p).toBe('bad path')
      expect(sessionCommand(win({ pluginDir: p })), p).toBe('bad path')
    }
    expect(ok(sessionCommand(win({ repo: '\\\\host\\share\\repo' }))).cwd).toBe('\\\\host\\share\\repo')
  })
})

describe('the session env', () => {
  const board = {
    PATH: '/usr/bin:relative/bin:/bin',
    HOME: '/home/me',
    LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: 'fake',
    anthropic_base_url: 'fake',
    CLAUDECODE: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'fake',
    CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
    CLAUDE_CODE_GIT_BASH_PATH: '/usr/bin/bash',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1234',
    OPENAFLOW_CONFIG_DIR: '/tmp/cfg',
    OPENAFLOW_RUN: 'not-this-one',
    openaflow_hooks_dir: '/elsewhere',
    TERM: 'dumb',
    UNSET: undefined,
  }

  test('drops ANTHROPIC_*, CLAUDE* but the allowlist, and inherited OPENAFLOW_*, then sets §3 and TERM', () => {
    const r = ok(sessionCommand(linux({ env: board })))
    expect(r.env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/me',
      LANG: 'en_US.UTF-8',
      CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
      CLAUDE_CODE_GIT_BASH_PATH: '/usr/bin/bash',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1234',
      OPENAFLOW_RUN: MARKER,
      OPENAFLOW_HOOKS_DIR: '/home/me/.config/openaflow-server/hooks',
      TERM: 'xterm-256color',
    })
    expect(board.OPENAFLOW_RUN).toBe('not-this-one') // the board's own env is left alone
  })

  test('the resume env is the session env with its own marker', () => {
    const NEW = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d'
    const started = ok(sessionCommand(linux({ env: board, runMarker: NEW })))
    const { skill: _skill, text: _text, ...rest } = linux({ env: board, runMarker: NEW })
    const resumed = ok(resumeCommand(rest))
    expect(resumed.env).toEqual(started.env)
    expect(resumed.env.OPENAFLOW_RUN).toBe(NEW)
    expect(resumed.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('on Windows names match in any case and the hooks folder is a Windows path', () => {
    const r = ok(
      sessionCommand(
        win({ env: { Path: 'C:\\Windows;.', SystemRoot: 'C:\\Windows', Openaflow_Run: 'x', term: 'dumb', claudecode: '1' } }, fakeWindows({ read: { file: 'C:\\nodejs\\node.exe', pre: [CLI] } })),
      ),
    )
    expect(r.env).toEqual({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      NoDefaultCurrentDirectoryInExePath: '1',
      OPENAFLOW_RUN: MARKER,
      OPENAFLOW_HOOKS_DIR: 'C:\\Users\\me\\AppData\\Roaming\\openaflow-server\\hooks',
      TERM: 'xterm-256color',
    })
  })
})

const CLI = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
const WIN_PLUGIN = 'C:\\Program Files\\OpenAFlow\\resources\\hooks-plugin'

function win(over: Partial<SessionCommandInput> = {}, windows = fakeWindows({ read: { file: 'C:\\nodejs\\node.exe', pre: [CLI] } })): SessionCommandInput {
  return {
    claude: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
    repo: 'C:\\code\\repo',
    skill: 'plan',
    text: 'add tags',
    sessionId: SESSION,
    runMarker: MARKER,
    pluginDir: WIN_PLUGIN,
    configDir: 'C:\\Users\\me\\AppData\\Roaming\\openaflow-server',
    env: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
    platform: 'win32',
    windows,
    ...over,
  }
}

/** The shim read and the cmd.exe lookup, faked: both read real Windows files, which Linux has none of. */
function fakeWindows(o: { read: ShimRead; cmd?: string | undefined }) {
  const reads: string[] = []
  return {
    reads,
    readShim: (file: string) => {
      reads.push(file)
      return o.read
    },
    cmdPath: () => ('cmd' in o ? o.cmd : 'C:\\Windows\\System32\\cmd.exe'),
  }
}

describe('windows shims', () => {
  test('a readable npm shim runs as its node plus script', () => {
    const fake = fakeWindows({ read: { file: 'C:\\nodejs\\node.exe', pre: [CLI] } })
    const r = ok(sessionCommand(win({}, fake)))
    expect(fake.reads).toEqual(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'])
    expect(r.program).toBe('C:\\nodejs\\node.exe')
    expect(r.args).toEqual([CLI, '--session-id', SESSION, '--plugin-dir', WIN_PLUGIN, '/pod:plan add tags'])
    expect(r.typeYourself).toBeUndefined()
  })

  test('a shim that names a native exe runs that exe', () => {
    const fake = fakeWindows({ read: { file: 'C:\\tools\\claude.exe', pre: [] } })
    const r = ok(sessionCommand(win({ claude: 'C:\\tools\\claude.CMD' }, fake)))
    expect(r.program).toBe('C:\\tools\\claude.exe')
    expect(r.args).toEqual(['--session-id', SESSION, '--plugin-dir', WIN_PLUGIN, '/pod:plan add tags'])
  })

  test('a native exe runs as is, with no shim read', () => {
    const fake = fakeWindows({ read: 'unreadable' })
    const r = ok(sessionCommand(win({ claude: 'C:\\Users\\me\\.local\\bin\\claude.exe' }, fake)))
    expect(fake.reads).toEqual([])
    expect(r.program).toBe('C:\\Users\\me\\.local\\bin\\claude.exe')
    expect(r.args.at(-1)).toBe('/pod:plan add tags')
  })

  test('no node gives node not found', () => {
    expect(sessionCommand(win({}, fakeWindows({ read: 'no node' })))).toBe('node not found')
  })

  test('an unreadable shim runs through cmd.exe with no prompt, and typeYourself holds the line to type', () => {
    const shim = 'C:\\Users\\me\\AppData\\Local\\pnpm\\claude.bat'
    const r = ok(sessionCommand(win({ claude: shim, skill: 'task', text: SPECIAL }, fakeWindows({ read: 'unreadable' }))))
    expect(r.program).toBe('C:\\Windows\\System32\\cmd.exe')
    // `call` first: cmd.exe strips quotes only when the line after /c starts with one
    expect(r.args).toEqual(['/d', '/c', 'call', shim, '--session-id', SESSION, '--plugin-dir', WIN_PLUGIN])
    expect(r.typeYourself).toBe(`/pod:task ${SPECIAL}`)
    expect(r.env.OPENAFLOW_RUN).toBe(MARKER)
  })

  test('an unreadable shim with plain and no text has nothing to type', () => {
    const r = ok(sessionCommand(win({ skill: 'plain', text: '' }, fakeWindows({ read: 'unreadable' }))))
    expect(r.args.at(-1)).toBe(WIN_PLUGIN)
    expect(r.typeYourself).toBeUndefined()
  })

  test('the cmd.exe route refuses paths cmd.exe would act on, and needs a cmd.exe', () => {
    for (const bad of ['C:\\a%PATH%\\claude.cmd', 'C:\\a^b\\claude.cmd', 'C:\\a&b\\claude.cmd', 'C:\\a!b\\claude.cmd', 'C:\\a"b\\claude.cmd']) {
      expect(sessionCommand(win({ claude: bad }, fakeWindows({ read: 'unreadable' }))), bad).toBe('unsafe claude path')
    }
    expect(sessionCommand(win({ pluginDir: 'C:\\50%\\hooks-plugin' }, fakeWindows({ read: 'unreadable' })))).toBe('unsafe claude path')
    // node-pty quotes only an arg with a space or a tab, and cmd.exe splits unquoted text at , ; =
    for (const bad of ['C:\\a,b\\claude.cmd', 'C:\\a;b\\claude.cmd', 'C:\\a=b\\claude.cmd']) {
      expect(sessionCommand(win({ claude: bad }, fakeWindows({ read: 'unreadable' }))), bad).toBe('unsafe claude path')
      expect(sessionCommand(win({ pluginDir: bad }, fakeWindows({ read: 'unreadable' }))), bad).toBe('unsafe claude path')
    }
    expect(sessionCommand(win({}, fakeWindows({ read: 'unreadable', cmd: undefined })))).toBe('cmd.exe not found')
  })

  test('resume through an npm shim runs node plus its script', () => {
    const { skill: _skill, text: _text, ...rest } = win({}, fakeWindows({ read: { file: 'C:\\nodejs\\node.exe', pre: [CLI] } }))
    const r = ok(resumeCommand(rest))
    expect(r.program).toBe('C:\\nodejs\\node.exe')
    expect(r.args).toEqual([CLI, '--resume', SESSION, '--plugin-dir', WIN_PLUGIN])
    expect(r.typeYourself).toBeUndefined()
    expect(r.env.OPENAFLOW_HOOKS_DIR).toBe('C:\\Users\\me\\AppData\\Roaming\\openaflow-server\\hooks')
  })

  test('resume through an unreadable shim runs cmd.exe with no typeYourself; its refusals hold', () => {
    const resume = (over: Partial<SessionCommandInput>, fake: ReturnType<typeof fakeWindows>) => {
      const { skill: _skill, text: _text, ...rest } = win(over, fake)
      return resumeCommand(rest)
    }
    const shim = 'C:\\Users\\me\\AppData\\Local\\pnpm\\claude.bat'
    const r = ok(resume({ claude: shim }, fakeWindows({ read: 'unreadable' })))
    expect(r.program).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(r.args).toEqual(['/d', '/c', 'call', shim, '--resume', SESSION, '--plugin-dir', WIN_PLUGIN])
    expect('typeYourself' in r).toBe(false)
    expect(resume({}, fakeWindows({ read: 'no node' }))).toBe('node not found')
    expect(resume({ claude: 'C:\\a&b\\claude.cmd' }, fakeWindows({ read: 'unreadable' }))).toBe('unsafe claude path')
    expect(resume({}, fakeWindows({ read: 'unreadable', cmd: undefined }))).toBe('cmd.exe not found')
  })

  test('a shim on Linux is only a file name', () => {
    const fake = fakeWindows({ read: 'unreadable' })
    const r = ok(sessionCommand(linux({ claude: '/opt/claude.cmd', windows: fake })))
    expect(fake.reads).toEqual([])
    expect(r.program).toBe('/opt/claude.cmd')
  })
})

describe.runIf(WIN)('windows shims on real files', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oaf-session-command-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('a real npm shim with its own node.exe, and a shim no one can read', () => {
    const npm = join(dir, 'npm')
    mkdirSync(join(npm, 'node_modules', 'claude'), { recursive: true })
    writeFileSync(join(npm, 'node_modules', 'claude', 'cli.js'), '')
    writeFileSync(join(npm, 'node.exe'), '')
    writeFileSync(join(npm, 'claude.cmd'), `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\claude\\cli.js" %*\r\n`)
    const r = ok(sessionCommand({ ...win(), claude: join(npm, 'claude.cmd'), windows: undefined, env: process.env }))
    expect(r.program).toBe(join(npm, 'node.exe'))
    expect(r.args[0]).toBe(join(npm, 'node_modules', 'claude', 'cli.js'))

    const other = join(dir, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'claude.cmd'), '@node "%~dp0cli.mjs" %*\r\n')
    const c = ok(sessionCommand({ ...win(), claude: join(other, 'claude.cmd'), windows: undefined, env: process.env }))
    expect(c.args.slice(0, 3)).toEqual(['/d', '/c', 'call'])
    expect(c.typeYourself).toBe('/pod:plan add tags')
  })
})
