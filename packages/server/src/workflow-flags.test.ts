import { describe, expect, test } from 'vitest'
import { editDenyRule, workflowFlags } from './workflow-flags.ts'

const LINUX_WF = '/opt/openaflow/resources/workflows/claude-pod'
const WIN_WF = 'C:\\Users\\Me\\AppData\\Local\\Programs\\OpenAFlow\\resources\\workflows\\claude-pod'

describe('editDenyRule', () => {
  test('an absolute folder as a // rule over everything under it', () => {
    expect(editDenyRule(LINUX_WF, 'linux')).toBe('Edit(//opt/openaflow/resources/workflows/claude-pod/**)')
    expect(editDenyRule(LINUX_WF, 'darwin')).toBe('Edit(//opt/openaflow/resources/workflows/claude-pod/**)')
    // A trailing separator adds no empty step.
    expect(editDenyRule('/opt/wf/', 'linux')).toBe('Edit(//opt/wf/**)')
  })

  test('Windows: the POSIX form, with the drive letter lowercase', () => {
    expect(editDenyRule(WIN_WF, 'win32')).toBe('Edit(//c/Users/Me/AppData/Local/Programs/OpenAFlow/resources/workflows/claude-pod/**)')
    // Forward slashes, a space, and a trailing separator.
    expect(editDenyRule('D:/Program Files/OpenAFlow\\wf\\', 'win32')).toBe('Edit(//d/Program Files/OpenAFlow/wf/**)')
    // A network share: its POSIX form starts with two slashes.
    expect(editDenyRule('\\\\server\\share\\wf', 'win32')).toBe('Edit(///server/share/wf/**)')
  })

  test("a folder name's glob characters are escaped, so they match only themselves", () => {
    expect(editDenyRule('/opt/a[1]*?/wf', 'linux')).toBe('Edit(//opt/a\\[1\\]\\*\\?/wf/**)')
    expect(editDenyRule('C:\\a[b]\\wf', 'win32')).toBe('Edit(//c/a\\[b\\]/wf/**)')
  })

  test('parentheses in a folder name stay as they are', () => {
    // Not glob characters; whether claude's rule parser reads an inner `)` right is not proved (no real run).
    expect(editDenyRule('C:\\Program Files (x86)\\OpenAFlow\\wf', 'win32')).toBe('Edit(//c/Program Files (x86)/OpenAFlow/wf/**)')
  })
})

describe('workflowFlags', () => {
  test('add-dir, the deny rule, then the plugin dir: each variadic flag is followed by a flag', () => {
    expect(workflowFlags(LINUX_WF, { platform: 'linux' })).toEqual([
      '--add-dir',
      LINUX_WF,
      '--disallowedTools',
      'Edit(//opt/openaflow/resources/workflows/claude-pod/**)',
      '--plugin-dir',
      LINUX_WF,
    ])
  })

  test('deny: false leaves the rule out', () => {
    expect(workflowFlags(WIN_WF, { platform: 'win32', deny: false })).toEqual(['--add-dir', WIN_WF, '--plugin-dir', WIN_WF])
  })

  test('quote wraps each value, the rule too', () => {
    const q = (w: string) => `"${w}"`
    expect(workflowFlags('D:\\x y\\wf', { platform: 'win32', quote: q })).toEqual(['--add-dir', '"D:\\x y\\wf"', '--disallowedTools', '"Edit(//d/x y/wf/**)"', '--plugin-dir', '"D:\\x y\\wf"'])
  })
})
