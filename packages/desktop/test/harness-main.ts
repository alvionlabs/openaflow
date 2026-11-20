// The Electron harness's entry: the same startShell as main.ts. The bundle runs from a temp folder, so it names
// the desktop package, where the server and pty host bundles are found. Only electron-harness.ts runs this.

import { startShell } from '../src/shell-main.ts'

startShell({ env: process.env, appPath: process.env.OPENAFLOW_HARNESS_APP_PATH })
