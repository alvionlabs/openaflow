import { describe, expect, test } from 'vitest'
import { isSkillId, SKILLS, skillCommand } from '../src/index.ts'

describe('skills', () => {
  test('the skill list', () => {
    expect(SKILLS.map((s) => s.id)).toEqual(['init', 'plan', 'ship', 'task', 'research', 'idea', 'plain'])
    expect(SKILLS.map((s) => s.command)).toEqual(['/pod:init', '/pod:plan', '/pod:ship', '/pod:task', '/pod:research', '/pod:idea', undefined])
    expect(skillCommand('research')).toBe('/pod:research')
    expect(skillCommand('plain')).toBeUndefined()
    // only the fixed ids count; nothing else reads as a skill
    for (const id of ['init', 'plan', 'ship', 'task', 'research', 'idea', 'plain']) expect(isSkillId(id)).toBe(true)
    for (const bad of ['', 'Plan', 'pod:plan', '/pod:plan', 'teach', 'toString', '__proto__', undefined, null, 1, {}]) {
      expect(isSkillId(bad)).toBe(false)
    }
  })

  test('labels and lines', () => {
    expect(SKILLS.map((s) => [s.id, s.label, s.line])).toEqual([
      ['init', 'Map the project', 'Map the codebase and write the smoke recipe.'],
      ['plan', 'Plan', 'Interview, then write a plan.'],
      ['ship', 'Ship an idea', 'Research, plan, and build in one go.'],
      ['task', 'One task', 'One change, one engineer, one PR.'],
      ['research', 'Research', 'Look into a question and write a report.'],
      ['idea', 'Park an idea', 'Save an idea for later.'],
      ['plain', 'Plain session', 'Claude with no prompt.'],
    ])
  })

  test('bare names and init', () => {
    // init first, then the five, then plain; each command keeps /pod:, and `name` is the bare name.
    expect(SKILLS.map((s) => s.id)).toEqual(['init', 'plan', 'ship', 'task', 'research', 'idea', 'plain'])
    expect(SKILLS.map((s) => s.name)).toEqual(['init', 'plan', 'ship', 'task', 'research', 'idea', undefined])
    expect(SKILLS.map((s) => s.command)).toEqual(['/pod:init', '/pod:plan', '/pod:ship', '/pod:task', '/pod:research', '/pod:idea', undefined])
    for (const s of SKILLS) if (s.command !== undefined) expect(s.command, s.id).toBe(`/pod:${s.name}`)
    expect(SKILLS[0]).toEqual({ id: 'init', name: 'init', command: '/pod:init', label: 'Map the project', line: 'Map the codebase and write the smoke recipe.' })
    expect(skillCommand('init')).toBe('/pod:init')
    expect(isSkillId('init')).toBe(true)
    for (const bad of ['Init', '/pod:init', 'pod:init', ' init']) expect(isSkillId(bad)).toBe(false)
  })
})
