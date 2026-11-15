// `GET /api/sessions/<marker>/screen`: the screen text the terminal host saved for a hosted session, for the page to
// show under its stop bar once the host no longer holds the session. Behind the read guard (app.ts). The rules are
// sprint session-life's shared contract §5; the why is in pod-docs/feature-details/hosted-sessions.md.

import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { screenFileOf } from './session-routes.ts'
import { UUID_V4, type SessionStore } from './session-store.ts'

export type ScreenRouteDeps = {
  store: Pick<SessionStore, 'list'>
  /** The live config folder: the host saves screens to its `screens` folder. */
  configDir: string
}

/** The screen route, mounted at /api/sessions. It reads only a path built from a marker the store holds. */
export function createScreenRoutes(deps: ScreenRouteDeps): Hono {
  const app = new Hono()
  app.get('/:marker/screen', async (c) => {
    const asked = c.req.param('marker')
    const record = UUID_V4.test(asked) ? deps.store.list().find((r) => r.marker === asked) : undefined
    if (!record) return c.json({ error: 'no screen' }, 404)
    try {
      return c.json({ text: await readFile(screenFileOf(deps.configDir, record.marker), 'utf8') })
    } catch {
      return c.json({ error: 'no screen' }, 404)
    }
  })
  return app
}
