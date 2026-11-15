import { describe, expect, test } from 'vitest'
import { isSkillId, SKILLS, skillCommand } from '../src/index.ts'

describe('skills', () => {
  test('the skill list', () => {
    expect(SKILLS.map((s) => s.id)).toEqual(['plan', 'ship', 'task', 'research', 'idea', 'plain'])
    expect(SKILLS.map((s) => s.command)).toEqual(['/pod:plan', '/pod:ship', '/pod:task', '/pod:research', '/pod:idea', undefined])
    expect(skillCommand('research')).toBe('/pod:research')
    expect(skillCommand('plain')).toBeUndefined()
    // only the fixed ids count; nothing else reads as a skill
    for (const id of ['plan', 'ship', 'task', 'research', 'idea', 'plain']) expect(isSkillId(id)).toBe(true)
    for (const bad of ['', 'Plan', 'pod:plan', '/pod:plan', 'teach', 'toString', '__proto__', undefined, null, 1, {}]) {
      expect(isSkillId(bad)).toBe(false)
    }
  })
})
