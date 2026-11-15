// The skills a new hosted session can start with, in the order the New session form lists them.
// Pure. The `/pod:` prefix lives only here: `openaflow-plugin` changes it in this one place.
// Labels come with the New session form (sprint terminal-tab).

export type SkillId = 'plan' | 'ship' | 'task' | 'research' | 'idea' | 'plain'
export type Skill = { id: SkillId; command?: string }

const PREFIX = '/pod:'

/** The fixed list. `plain` starts a session with no skill, so it has no command. */
export const SKILLS: readonly Skill[] = [
  { id: 'plan', command: `${PREFIX}plan` },
  { id: 'ship', command: `${PREFIX}ship` },
  { id: 'task', command: `${PREFIX}task` },
  { id: 'research', command: `${PREFIX}research` },
  { id: 'idea', command: `${PREFIX}idea` },
  { id: 'plain' },
]

/** Only the ids of the fixed list, compared exactly. */
export const isSkillId = (x: unknown): x is SkillId => typeof x === 'string' && SKILLS.some((s) => s.id === x)

/** The slash command of `id`, or `undefined` for `plain`. */
export const skillCommand = (id: SkillId): string | undefined => SKILLS.find((s) => s.id === id)?.command
