// The skills a new hosted session can start with, in the order the New session form lists them.
// Pure. The `/pod:` prefix lives only here: `openaflow-plugin` changes it in this one place.
// `label` and `line` are the New session form's words for each option (sprint terminal-tab §4). `name` is the bare
// skill name the form shows in place of the command (sprint default-workflow §9); the command keeps its prefix.

export type SkillId = 'init' | 'plan' | 'ship' | 'task' | 'research' | 'idea' | 'plain'
/** `label` names the option; `line` says in one sentence what it does; `name` is the command without its prefix. */
export type Skill = { id: SkillId; name?: string; command?: string; label: string; line: string }

const PREFIX = '/pod:'

const skill = (name: Exclude<SkillId, 'plain'>, label: string, line: string): Skill => ({ id: name, name, command: `${PREFIX}${name}`, label, line })

/** The fixed list. `plain` starts a session with no skill, so it has no name and no command. */
export const SKILLS: readonly Skill[] = [
  skill('init', 'Map the project', 'Map the codebase and write the smoke recipe.'),
  skill('plan', 'Plan', 'Interview, then write a plan.'),
  skill('ship', 'Ship an idea', 'Research, plan, and build in one go.'),
  skill('task', 'One task', 'One change, one engineer, one PR.'),
  skill('research', 'Research', 'Look into a question and write a report.'),
  skill('idea', 'Park an idea', 'Save an idea for later.'),
  { id: 'plain', label: 'Plain session', line: 'Claude with no prompt.' },
]

/** Only the ids of the fixed list, compared exactly. */
export const isSkillId = (x: unknown): x is SkillId => typeof x === 'string' && SKILLS.some((s) => s.id === x)

/** The slash command of `id`, or `undefined` for `plain`. */
export const skillCommand = (id: SkillId): string | undefined => SKILLS.find((s) => s.id === id)?.command
