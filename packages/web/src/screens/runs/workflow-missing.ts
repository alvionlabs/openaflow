// The words for `workflow missing`, a set-up repo whose workflow bundle the app doesn't have: a retry never works, so
// reinstall. New session, Resume, and Continue share them. A leaf with no imports: the desktop app type-checks
// resume-flow.ts through next-step.ts, with no JSX.

/** The route's word, from New session, Resume, and a Continue or Go result. */
export const WORKFLOW_MISSING = 'workflow missing'

/** What the page shows for it. Short and warm, with no period at the end (DESIGN.md). */
export const WORKFLOW_MISSING_TEXT = "The app doesn't have this repo's workflow. Please reinstall it"
