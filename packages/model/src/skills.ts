// The skills a new hosted session can start with, in the order the New session form lists them.
// Pure. The `/pod:` prefix lives only here: `openaflow-plugin` changes it in this one place.
// `label` and `line` are the New session form's words for each option (sprint terminal-tab §4).

export type SkillId = 'plan' | 'ship' | 'task' | 'research' | 'idea' | 'plain'
/** `label` names the option; `line` says in one sentence what it does. */
export type Skill = { id: SkillId; command?: string; label: string; line: string }

const PREFIX = '/pod:'

/** The fixed list. `plain` starts a session with no skill, so it has no command. */
export const SKILLS: readonly Skill[] = [
  { id: 'plan', command: `${PREFIX}plan`, label: 'Plan', line: 'Interview, then write a plan.' },
  { id: 'ship', command: `${PREFIX}ship`, label: 'Ship an idea', line: 'Research, plan, and build in one go.' },
  { id: 'task', command: `${PREFIX}task`, label: 'One task', line: 'One change, one engineer, one PR.' },
  { id: 'research', command: `${PREFIX}research`, label: 'Research', line: 'Look into a question and write a report.' },
  { id: 'idea', command: `${PREFIX}idea`, label: 'Park an idea', line: 'Save an idea for later.' },
  { id: 'plain', label: 'Plain session', line: 'Claude with no prompt.' },
]

/** Only the ids of the fixed list, compared exactly. */
export const isSkillId = (x: unknown): x is SkillId => typeof x === 'string' && SKILLS.some((s) => s.id === x)

/** The slash command of `id`, or `undefined` for `plain`. */
export const skillCommand = (id: SkillId): string | undefined => SKILLS.find((s) => s.id === id)?.command
