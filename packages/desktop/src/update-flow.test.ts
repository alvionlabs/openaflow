import { STOP_MESSAGE } from '@openaflow/server/parent-link'
import { describe, expect, test, vi } from 'vitest'
import { createServerHost, type ServerProcess } from './server-host.ts'
import {
  createUpdateFlow,
  failureText,
  FIRST_CHECK_MS,
  INSTALL_LIMIT_MS,
  LAST_CHANCE_MS,
  RECHECK_MS,
  relaunchArgs,
  RELEASES_URL,
  type UpdaterPort,
} from './update-flow.ts'

type Answer = 'restart' | 'later'

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0
  let timers: { at: number; fn: () => void }[] = []
  return {
    after(ms: number, fn: () => void) {
      timers.push({ at: now + ms, fn })
    },
    count: () => timers.length,
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((t) => t !== due)
        now = due.at
        due.fn()
        await settle()
      }
      now = end
    },
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(
  o: {
    packaged?: boolean
    platform?: NodeJS.Platform
    appImage?: string | undefined
    firstCheckMs?: number
    stop?: () => Promise<unknown>
    updaterThrows?: boolean
    ask?: (v: string) => Promise<Answer>
    endSessions?: () => Promise<boolean>
  } = {},
) {
  const events: string[] = []
  const logs: string[] = []
  const clock = fakeClock()
  let downloaded: (version: string) => void = () => {}
  let errored: (e: unknown) => void = () => {}
  let made = 0
  let quitting = false
  const port: UpdaterPort & { nextCheck: () => ReturnType<UpdaterPort['check']>; installImpl: () => void } = {
    nextCheck: () => Promise.resolve(null),
    installImpl: () => {},
    check() {
      events.push('check')
      return port.nextCheck()
    },
    install() {
      events.push('install')
      port.installImpl()
    },
    onDownloaded: (fn) => void (downloaded = fn),
    onError: (fn) => void (errored = fn),
  }
  const answers: Answer[] = []
  const flow = createUpdateFlow({
    packaged: o.packaged ?? true,
    platform: o.platform ?? 'win32',
    appImage: 'appImage' in o ? o.appImage : undefined,
    firstCheckMs: o.firstCheckMs,
    updater: () => {
      made++
      if (o.updaterThrows) throw new Error('bad https://example.com/secret')
      return port
    },
    ask:
      o.ask ??
      (async (version) => {
        events.push(`ask ${version}`)
        return answers.shift() ?? 'later'
      }),
    stop:
      o.stop ??
      (async () => {
        events.push('stop')
        return 'stopped'
      }),
    endSessions: o.endSessions ?? (async () => true),
    quit: () => void events.push('quit'),
    quitting: () => quitting,
    clock,
    log: (line) => void logs.push(line),
  })
  return {
    flow,
    port,
    clock,
    events,
    logs,
    answers,
    made: () => made,
    beginQuit: () => void (quitting = true),
    download: async (version: string) => {
      downloaded(version)
      await settle()
    },
    error: async (e: unknown) => {
      errored(e)
      await settle()
    },
    checks: () => events.filter((e) => e === 'check').length,
  }
}

describe('createUpdateFlow', () => {
  test('no check when unpackaged', async () => {
    const t = setup({ packaged: false })
    t.flow.start()
    await t.clock.advance(RECHECK_MS * 3)
    expect(t.checks()).toBe(0)
    expect(t.logs).toEqual([])
    expect(t.clock.count()).toBe(0)
    expect(t.made()).toBe(0)
  })

  test('check times', async () => {
    expect(FIRST_CHECK_MS).toBe(30_000)
    expect(RECHECK_MS).toBe(6 * 60 * 60_000)
    const t = setup()
    await t.clock.advance(FIRST_CHECK_MS * 10)
    expect(t.checks()).toBe(0)

    t.flow.start()
    await t.clock.advance(FIRST_CHECK_MS - 1)
    expect(t.checks()).toBe(0)
    await t.clock.advance(1)
    expect(t.checks()).toBe(1)

    // A second start adds no timer after the first check either.
    t.flow.start()
    expect(t.clock.count()).toBe(1)
    await t.clock.advance(RECHECK_MS - 1)
    expect(t.checks()).toBe(1)
    await t.clock.advance(1)
    expect(t.checks()).toBe(2)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(3)
    expect(t.clock.count()).toBe(1)
  })

  test('a second start before the first check adds no timer', async () => {
    const t = setup()
    t.flow.start()
    t.flow.start()
    expect(t.clock.count()).toBe(1)
    await t.clock.advance(FIRST_CHECK_MS)
    expect(t.checks()).toBe(1)
    expect(t.made()).toBe(1)
  })

  test('the first delay can be replaced', async () => {
    const t = setup({ firstCheckMs: 500 })
    t.flow.start()
    await t.clock.advance(500)
    expect(t.checks()).toBe(1)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(2)
  })

  test('no overlapping checks', async () => {
    const t = setup()
    const check = deferred<null>()
    t.port.nextCheck = () => check.promise
    t.flow.start()
    await t.clock.advance(FIRST_CHECK_MS)
    expect(t.checks()).toBe(1)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(1)

    // The check ends with a download, which also holds the next one back.
    const download = deferred()
    t.port.nextCheck = () => Promise.resolve({ downloadPromise: download.promise })
    check.resolve(null)
    await settle()
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(2)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(2)

    download.resolve()
    await settle()
    t.port.nextCheck = () => Promise.resolve(null)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(3)
  })

  test('a failure stays quiet and retries', async () => {
    const URL_TEXT = 'https://github.com/alvionlabs/openaflow/releases/latest?token=abc123'
    const t = setup()
    const failure = Object.assign(new Error(`HttpError: 500 ${URL_TEXT}`), { code: 'HTTP_ERROR_500' })
    t.port.nextCheck = () => {
      // electron-updater emits `error`, and also rejects.
      void t.error(failure)
      return Promise.reject(failure)
    }
    t.flow.start()
    await t.clock.advance(FIRST_CHECK_MS)
    expect(t.logs).toHaveLength(1)
    expect(t.logs[0]).toContain('HTTP_ERROR_500')
    expect(t.logs.join()).not.toMatch(/https?:|token|abc123|github/)
    expect(t.events.filter((e) => e.startsWith('ask'))).toEqual([])

    t.port.nextCheck = () => Promise.resolve(null)
    await t.clock.advance(RECHECK_MS)
    expect(t.checks()).toBe(2)
    expect(t.logs).toHaveLength(1)

    // Each failed check gets its own line.
    t.port.nextCheck = () => Promise.reject(failure)
    await t.clock.advance(RECHECK_MS)
    expect(t.logs).toHaveLength(2)
  })

  test('a failed download logs one line, and a check that throws or a bad updater never throws', async () => {
    const t = setup()
    const failure = new Error('net::ERR_CONNECTION_RESET at https://example.com/x.exe')
    t.port.nextCheck = () => {
      const download = Promise.reject(failure)
      return Promise.resolve({ downloadPromise: download })
    }
    t.flow.start()
    await t.clock.advance(FIRST_CHECK_MS)
    await t.error(failure)
    expect(t.logs).toHaveLength(1)
    expect(t.logs[0]).toContain('net::ERR_CONNECTION_RESET')
    expect(t.logs[0]).not.toContain('example.com')

    t.port.nextCheck = () => {
      throw new Error('sync https://example.com')
    }
    await t.clock.advance(RECHECK_MS)
    expect(t.logs).toHaveLength(2)
    expect(t.logs[1]).not.toContain('example.com')

    // No code and no safe name.
    t.port.nextCheck = () => Promise.reject('https://example.com')
    await t.clock.advance(RECHECK_MS)
    expect(t.logs).toHaveLength(3)
    expect(t.logs[2]).not.toContain('example.com')

    const bad = setup({ updaterThrows: true })
    expect(() => bad.flow.start()).not.toThrow()
    await bad.clock.advance(RECHECK_MS * 2)
    expect(bad.logs).toHaveLength(1)
    expect(bad.logs[0]).not.toContain('example.com')
    expect(bad.checks()).toBe(0)
  })

  test('when it asks', async () => {
    const t = setup()
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1'])
    expect(t.logs.join('\n')).toContain('1.0.1')

    // The same version again: the Later of this app run holds.
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1'])

    await t.download('1.0.2')
    expect(t.events).toEqual(['ask 1.0.1', 'ask 1.0.2'])
  })

  test('an open box blocks a second, and the blocked version asks later', async () => {
    const box = deferred<Answer>()
    const asked: string[] = []
    const t = setup({
      ask: (version) => {
        asked.push(version)
        return box.promise
      },
    })
    t.flow.start()
    await t.download('1.0.1')
    await t.download('1.0.2')
    expect(asked).toEqual(['1.0.1'])

    // A check while the box is open could swap the file the box names.
    await t.clock.advance(FIRST_CHECK_MS + RECHECK_MS)
    expect(t.checks()).toBe(0)

    box.resolve('later')
    await settle()
    await t.download('1.0.2')
    expect(asked).toEqual(['1.0.1', '1.0.2'])
  })

  test('no box opens once a quit has begun, and no check runs', async () => {
    const t = setup()
    t.flow.start()
    t.beginQuit()
    await t.download('1.0.1')
    await t.clock.advance(FIRST_CHECK_MS + RECHECK_MS)
    expect(t.events).toEqual([])
  })

  test('an answer after a quit began installs nothing', async () => {
    const box = deferred<Answer>()
    const t = setup({ ask: () => box.promise })
    t.flow.start()
    await t.download('1.0.1')
    t.beginQuit()
    box.resolve('restart')
    await settle()
    expect(t.events).toEqual([])
  })

  test('later installs nothing', async () => {
    const t = setup()
    t.answers.push('later')
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1'])

    // A box that fails counts as Later.
    const broken = setup({ ask: () => Promise.reject(new Error('https://example.com')) })
    broken.flow.start()
    await broken.download('1.0.1')
    expect(broken.events).toEqual([])
    expect(broken.logs.join()).not.toContain('example.com')
  })

  test.each(['stopped', 'killed', 'not running'])('restart stops first (%s)', async (result) => {
    const stop = deferred<string>()
    const t = setup({ stop: () => stop.promise })
    t.answers.push('restart')
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1'])
    stop.resolve(result)
    await settle()
    expect(t.events).toEqual(['ask 1.0.1', 'install'])
    expect(t.events).not.toContain('quit')
  })

  test('restart stops first, and a stop that throws goes on', async () => {
    const t = setup({ stop: () => Promise.reject(new Error('gone')) })
    t.answers.push('restart')
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1', 'install'])
  })

  test('a restart in progress starts no check and opens no box', async () => {
    const stop = deferred<string>()
    const t = setup({ stop: () => stop.promise })
    t.answers.push('restart')
    t.flow.start()
    await t.download('1.0.1')
    await t.clock.advance(FIRST_CHECK_MS + RECHECK_MS * 2)
    await t.download('1.0.2')
    expect(t.events).toEqual(['ask 1.0.1'])
  })

  test('a Restart now whose installer never quits the app quits after the limit', async () => {
    const t = setup()
    t.answers.push('restart')
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1', 'stop', 'install'])
    await t.clock.advance(FIRST_CHECK_MS + INSTALL_LIMIT_MS)
    expect(t.events).toEqual(['ask 1.0.1', 'stop', 'install', 'quit'])
    expect(t.checks()).toBe(0)
  })

  test('a failed install quits', async () => {
    const t = setup()
    t.answers.push('restart')
    t.port.installImpl = () => {
      throw Object.assign(new Error('spawn https://example.com'), { code: 'EACCES' })
    }
    t.flow.start()
    await t.download('1.0.1')
    expect(t.events).toEqual(['ask 1.0.1', 'stop', 'install', 'quit'])
    await t.clock.advance(INSTALL_LIMIT_MS)
    expect(t.events).toEqual(['ask 1.0.1', 'stop', 'install', 'quit'])
    expect(t.logs.join()).toContain('EACCES')
    expect(t.logs.join()).not.toContain('example.com')
  })

  // quitAndInstall catches its own failure: it emits `error`, returns, and doesn't quit, and the server has gone by then.
  test('an install that fails with an error event also quits, once', async () => {
    const t = setup()
    t.answers.push('restart')
    t.port.installImpl = () => void t.error(new Error('No update filepath provided'))
    t.flow.start()
    await t.download('1.0.1')
    await t.error(new Error('again'))
    expect(t.events).toEqual(['ask 1.0.1', 'stop', 'install', 'quit'])
    expect(t.logs.filter((l) => l.includes('install failed'))).toHaveLength(1)
  })

  test('an error during the stop only logs: the install still goes on', async () => {
    const stop = deferred<string>()
    const t = setup({ stop: () => stop.promise })
    t.answers.push('restart')
    t.flow.start()
    await t.download('1.0.1')
    await t.error(new Error('late check failure'))
    expect(t.events).toEqual(['ask 1.0.1'])
    stop.resolve('stopped')
    await settle()
    expect(t.events).toEqual(['ask 1.0.1', 'install'])
  })

  describe('Restart now asks the quit question', () => {
    /** An `endSessions` that records its call and answers when the test says so. */
    const sessionsAsk = (t: () => { events: string[] }) => {
      const answers: Array<ReturnType<typeof deferred<boolean>>> = []
      return {
        answers,
        endSessions: () => {
          t().events.push('end sessions')
          const d = deferred<boolean>()
          answers.push(d)
          return d.promise
        },
      }
    }

    test('restart with live sessions', async () => {
      let t!: ReturnType<typeof setup>
      const q = sessionsAsk(() => t)
      t = setup({ endSessions: q.endSessions })
      t.answers.push('restart', 'restart')
      t.flow.start()
      await t.download('1.0.1')
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions'])
      q.answers[0]!.resolve(false)
      await settle()
      // Cancel: like Later.
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions'])
      expect(t.logs).toContain('openaflow desktop: update 1.0.1: kept, sessions are active')
      // No install limit runs, and the timed checks go on.
      await t.clock.advance(INSTALL_LIMIT_MS)
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions', 'check'])

      // No second ask for this version in this run, but a newer version asks.
      await t.download('1.0.1')
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions', 'check'])
      await t.download('1.0.2')
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions', 'check', 'ask 1.0.2', 'end sessions'])
    })

    test('restart after the quit question', async () => {
      let t!: ReturnType<typeof setup>
      const q = sessionsAsk(() => t)
      t = setup({ endSessions: q.endSessions })
      t.answers.push('restart')
      t.flow.start()
      await t.download('1.0.1')
      // The sessions end before the server stops and the installer starts.
      await t.clock.advance(RECHECK_MS)
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions'])
      q.answers[0]!.resolve(true)
      await settle()
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions', 'stop', 'install'])
      expect(t.logs.join('\n')).not.toContain('kept')
    })

    test('restart with no sessions', async () => {
      // endSessions gives true at once when no session is live: today's restart.
      const t = setup({
        endSessions: async () => {
          t.events.push('end sessions')
          return true
        },
      })
      t.answers.push('restart')
      t.flow.start()
      await t.download('1.0.1')
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions', 'stop', 'install'])

      // The last chance follows the same rule.
      const last = setup({
        endSessions: async () => {
          last.events.push('end sessions')
          return true
        },
      })
      last.answers.push('restart')
      last.port.nextCheck = async () => {
        await last.download('1.0.1')
        return null
      }
      last.flow.start()
      let done = false
      void last.flow.lastChance().then(() => (done = true))
      await settle()
      expect(last.events).toEqual(['check', 'ask 1.0.1', 'end sessions', 'stop', 'install'])
      expect(done).toBe(false)
    })

    test('while the quit question is open: no check, no box, and a second launch waits', async () => {
      let t!: ReturnType<typeof setup>
      const q = sessionsAsk(() => t)
      t = setup({ endSessions: q.endSessions })
      t.answers.push('restart')
      t.flow.start()
      await t.download('1.0.1')
      await t.clock.advance(FIRST_CHECK_MS + RECHECK_MS)
      await t.download('1.0.2')
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions'])
      void t.flow.lastChance()
      await settle()
      expect(t.flow.reopen()).toBe('wait')
      expect(t.checks()).toBe(0)
    })

    test('a quit that goes through during the question installs nothing', async () => {
      let t!: ReturnType<typeof setup>
      const q = sessionsAsk(() => t)
      t = setup({ endSessions: q.endSessions })
      t.answers.push('restart')
      t.flow.start()
      await t.download('1.0.1')
      t.beginQuit()
      q.answers[0]!.resolve(true)
      await settle()
      await t.clock.advance(INSTALL_LIMIT_MS)
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions'])
    })

    test('an endSessions that fails keeps the version and logs no message', async () => {
      const t = setup({ endSessions: () => Promise.reject(Object.assign(new Error('https://example.com'), { code: 'EBOX' })) })
      t.answers.push('restart')
      t.flow.start()
      await t.download('1.0.1')
      expect(t.events).toEqual(['ask 1.0.1'])
      expect(t.logs.join('\n')).toContain('EBOX')
      expect(t.logs).toContain('openaflow desktop: update 1.0.1: kept, sessions are active')
      expect(t.logs.join()).not.toContain('example.com')
    })

    test('in the last chance, Cancel resolves, and a version kept earlier asks again', async () => {
      let t!: ReturnType<typeof setup>
      const q = sessionsAsk(() => t)
      t = setup({ endSessions: q.endSessions })
      t.answers.push('restart', 'restart')
      t.flow.start()
      await t.download('1.0.1')
      q.answers[0]!.resolve(false)
      await settle()

      t.port.nextCheck = async () => {
        await t.download('1.0.1')
        return null
      }
      let done = false
      void t.flow.lastChance().then(() => (done = true))
      await settle()
      expect(t.events).toEqual(['ask 1.0.1', 'end sessions', 'check', 'ask 1.0.1', 'end sessions'])
      expect(done).toBe(false)
      q.answers[1]!.resolve(false)
      await settle()
      expect(done).toBe(true)
      expect(t.events).not.toContain('install')
    })
  })

  describe('last chance, after the server failed', () => {
    /** Tracks whether lastChance resolved. */
    const watch = (p: Promise<void>) => {
      const s = { done: false }
      void p.then(() => (s.done = true))
      return s
    }

    test('checks at once, before the first timed check, and resolves when no update comes', async () => {
      const t = setup()
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      expect(t.checks()).toBe(1)
      expect(s.done).toBe(true)
      expect(t.events).not.toContain('quit')
    })

    test('an update found asks, and Restart now installs and waits for the installer to quit the app', async () => {
      const t = setup()
      t.answers.push('restart')
      t.port.nextCheck = async () => {
        await t.download('1.0.1')
        return null
      }
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      expect(t.events).toEqual(['check', 'ask 1.0.1', 'stop', 'install'])
      await t.clock.advance(INSTALL_LIMIT_MS - 1)
      expect(s.done).toBe(false)
      expect(t.events).not.toContain('quit')
    })

    test('an install that never quits the app resolves after INSTALL_LIMIT_MS', async () => {
      expect(INSTALL_LIMIT_MS).toBe(2 * 60_000)
      const stop = deferred<string>()
      const t = setup({ stop: () => stop.promise })
      t.answers.push('restart')
      t.port.nextCheck = async () => {
        await t.download('1.0.1')
        return null
      }
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      // The limit starts at the call to the installer, not at the click: the stop can take 80 s.
      await t.clock.advance(LAST_CHANCE_MS + INSTALL_LIMIT_MS)
      expect(s.done).toBe(false)
      stop.resolve('stopped')
      await settle()
      expect(t.events).toEqual(['check', 'ask 1.0.1', 'install'])
      await t.clock.advance(INSTALL_LIMIT_MS - 1)
      expect(s.done).toBe(false)
      await t.clock.advance(1)
      expect(s.done).toBe(true)
      expect(t.events).toEqual(['check', 'ask 1.0.1', 'install', 'quit'])
      expect(t.logs.at(-1)).toContain('install did not quit')
    })

    test('Later resolves', async () => {
      const t = setup()
      t.port.nextCheck = async () => {
        await t.download('1.0.1')
        return null
      }
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      expect(t.events).toEqual(['check', 'ask 1.0.1'])
      await settle()
      expect(s.done).toBe(true)
    })

    test('a failed check resolves', async () => {
      const t = setup()
      t.port.nextCheck = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      expect(s.done).toBe(true)
    })

    test('waits for a check that runs now and for an open box', async () => {
      const download = deferred()
      const box = deferred<Answer>()
      const t = setup({ ask: () => box.promise })
      t.port.nextCheck = () => Promise.resolve({ downloadPromise: download.promise })
      t.flow.start()
      await t.clock.advance(FIRST_CHECK_MS)
      const s = watch(t.flow.lastChance())
      await settle()
      // One check: the one that runs now.
      expect(t.checks()).toBe(1)
      expect(s.done).toBe(false)
      await t.download('1.0.1')
      download.resolve()
      await settle()
      expect(s.done).toBe(false)
      box.resolve('later')
      await settle()
      expect(s.done).toBe(true)
    })

    test('a download that hangs resolves after the limit', async () => {
      const t = setup()
      t.port.nextCheck = () => Promise.resolve({ downloadPromise: new Promise(() => {}) })
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await t.clock.advance(LAST_CHANCE_MS - 1)
      expect(s.done).toBe(false)
      await t.clock.advance(1)
      expect(s.done).toBe(true)
      expect(t.logs.at(-1)).toContain('no update in time')
    })

    test('asks again for a version put off with Later earlier in this run', async () => {
      const t = setup()
      t.flow.start()
      await t.download('1.0.1')
      expect(t.events).toEqual(['ask 1.0.1'])
      // electron-updater emits the cached download again on the next check.
      t.port.nextCheck = async () => {
        await t.download('1.0.1')
        return null
      }
      t.answers.push('restart')
      void t.flow.lastChance()
      await settle()
      expect(t.events).toEqual(['ask 1.0.1', 'check', 'ask 1.0.1', 'stop', 'install'])
    })

    test('a failed check still asks for a version downloaded earlier, once', async () => {
      const t = setup()
      t.flow.start()
      await t.download('1.0.1')
      t.port.nextCheck = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))
      const s = watch(t.flow.lastChance())
      await settle()
      expect(t.events).toEqual(['ask 1.0.1', 'check', 'ask 1.0.1'])
      expect(s.done).toBe(true)
    })

    test('a check that reports a newer version never asks for the older download, whose file is gone', async () => {
      for (const failing of [false, true]) {
        const t = setup()
        t.flow.start()
        await t.download('1.0.1')
        // electron-updater empties its cache before it downloads 1.0.2.
        const download = failing ? Promise.reject(new Error('net::ERR_CONNECTION_RESET')) : new Promise(() => {})
        t.port.nextCheck = () => Promise.resolve({ updateInfo: { version: '1.0.2' }, downloadPromise: download })
        const s = watch(t.flow.lastChance())
        await t.clock.advance(LAST_CHANCE_MS)
        expect(s.done).toBe(true)
        expect(t.events).toEqual(['ask 1.0.1', 'check'])
      }
    })

    test('an earlier check that started a newer download keeps the older download out of the box', async () => {
      const t = setup()
      t.flow.start()
      await t.download('1.0.1')
      // The 6-hour check finds 1.0.2: electron-updater empties its cache, then the download fails offline.
      t.port.nextCheck = () => Promise.resolve({ updateInfo: { version: '1.0.2' }, downloadPromise: Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')) })
      await t.clock.advance(FIRST_CHECK_MS)
      // Still offline when the server fails for good.
      t.port.nextCheck = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))
      const s = watch(t.flow.lastChance())
      await settle()
      expect(s.done).toBe(true)
      expect(t.events).toEqual(['ask 1.0.1', 'check', 'check'])
    })

    test('a new download clears the mark, so the record is asked again', async () => {
      const t = setup()
      t.flow.start()
      await t.download('1.0.1')
      t.port.nextCheck = () => Promise.resolve({ updateInfo: { version: '1.0.2' }, downloadPromise: Promise.reject(new Error('offline')) })
      await t.clock.advance(FIRST_CHECK_MS)
      await t.download('1.0.2')
      t.port.nextCheck = () => Promise.reject(new Error('offline'))
      void t.flow.lastChance()
      await settle()
      expect(t.events).toEqual(['ask 1.0.1', 'check', 'ask 1.0.2', 'check', 'ask 1.0.2'])
    })

    test('a check that reports the downloaded version still asks from the record', async () => {
      const t = setup()
      t.flow.start()
      await t.download('1.0.1')
      t.port.nextCheck = () => Promise.resolve({ updateInfo: { version: '1.0.1' }, downloadPromise: Promise.reject(new Error('EBUSY')) })
      void t.flow.lastChance()
      await settle()
      expect(t.events).toEqual(['ask 1.0.1', 'check', 'ask 1.0.1'])
    })

    test('asks only for the newest download', async () => {
      const t = setup()
      t.flow.start()
      await t.download('1.0.1')
      await t.download('1.0.2')
      t.port.nextCheck = () => Promise.reject(new Error('offline'))
      void t.flow.lastChance()
      await settle()
      expect(t.events).toEqual(['ask 1.0.1', 'ask 1.0.2', 'check', 'ask 1.0.2'])
    })

    test('a box open when the last chance starts is not asked twice', async () => {
      const box = deferred<Answer>()
      const asked: string[] = []
      const t = setup({
        ask: (version) => {
          asked.push(version)
          return box.promise
        },
      })
      t.flow.start()
      await t.download('1.0.1')
      const s = watch(t.flow.lastChance())
      await settle()
      expect(t.checks()).toBe(0)
      box.resolve('later')
      await settle()
      expect(asked).toEqual(['1.0.1'])
      expect(s.done).toBe(true)
    })

    test('the limit never closes an open box, and a late Restart now installs', async () => {
      const box = deferred<Answer>()
      const t = setup({
        ask: (version) => {
          t.events.push(`ask ${version}`)
          return box.promise
        },
      })
      t.port.nextCheck = async () => {
        await t.download('1.0.1')
        return null
      }
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      await t.clock.advance(LAST_CHANCE_MS * 3)
      expect(s.done).toBe(false)
      expect(t.logs.join('\n')).not.toContain('no update in time')
      box.resolve('restart')
      await settle()
      expect(t.events).toEqual(['check', 'ask 1.0.1', 'stop', 'install'])
      expect(s.done).toBe(false)
    })

    test('a download that lands after the limit opens no box', async () => {
      const download = deferred()
      const t = setup()
      t.port.nextCheck = () => Promise.resolve({ downloadPromise: download.promise })
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await t.clock.advance(LAST_CHANCE_MS)
      expect(s.done).toBe(true)
      await t.download('1.0.1')
      download.resolve()
      await settle()
      expect(t.events).toEqual(['check'])
    })

    test('a second launch: show before the last chance, then end the wait and relaunch', async () => {
      const t = setup()
      t.port.nextCheck = () => Promise.resolve({ downloadPromise: new Promise(() => {}) })
      t.flow.start()
      expect(t.flow.reopen()).toBe('show')
      const s = watch(t.flow.lastChance())
      await settle()
      expect(s.done).toBe(false)
      expect(t.flow.reopen()).toBe('relaunch')
      // Each app.relaunch() starts one more copy, so a second click starts none.
      expect(t.flow.reopen()).toBe('wait')
      await settle()
      expect(s.done).toBe(true)
      // The app is on its way out: no box opens.
      await t.download('1.0.1')
      expect(t.events).toEqual(['check'])
    })

    test('a second launch waits while a box is open or a restart runs', async () => {
      const box = deferred<Answer>()
      const stop = deferred<string>()
      const t = setup({ ask: () => box.promise, stop: () => stop.promise })
      t.port.nextCheck = async () => {
        await t.download('1.0.1')
        return null
      }
      t.flow.start()
      const s = watch(t.flow.lastChance())
      await settle()
      expect(t.flow.reopen()).toBe('wait')
      box.resolve('restart')
      await settle()
      // The installer starts the new copy.
      expect(t.flow.reopen()).toBe('wait')
      expect(s.done).toBe(false)
    })

    test('a second launch relaunches when no check runs', async () => {
      const t = setup({ packaged: false })
      t.flow.start()
      await t.flow.lastChance()
      expect(t.flow.reopen()).toBe('relaunch')
      expect(t.flow.reopen()).toBe('wait')
    })

    test('the relaunch drops the login flag, so the window shows', () => {
      expect(relaunchArgs(['OpenAFlow.exe', '--hidden'])).toEqual([])
      expect(relaunchArgs(['electron.exe', 'C:\\app', '--hidden', '--x'])).toEqual(['C:\\app', '--x'])
      expect(relaunchArgs(['OpenAFlow.exe'])).toEqual([])
    })

    test('the error box says the app checks only when a check runs', () => {
      const packaged = setup()
      packaged.flow.start()
      expect(packaged.flow.willCheck()).toBe(true)
      for (const t of [setup({ packaged: false }), setup({ updaterThrows: true })]) {
        t.flow.start()
        expect(t.flow.willCheck()).toBe(false)
      }

      const checks = failureText('exit 1', true)
      expect(checks).toContain('exit 1')
      expect(checks).toContain('checks for an update')
      expect(checks).toContain(RELEASES_URL)
      const none = failureText('exit 1', false)
      expect(none).not.toMatch(/check/i)
      expect(none).toContain(RELEASES_URL)
    })

    test("a Restart now during the server's first launch stops it before ready, then installs", async () => {
      vi.useFakeTimers()
      try {
        let onExit: (code: number) => void = () => {}
        let onMessage: (m: unknown) => void = () => {}
        const sent: unknown[] = []
        let forks = 0
        const host = createServerHost({
          fork: (): ServerProcess => {
            forks++
            return {
              pid: 100,
              postMessage: (m) => void sent.push(m),
              kill: () => true,
              onMessage: (fn) => void (onMessage = fn),
              onExit: (fn) => void (onExit = fn),
              onOutput: () => {},
            }
          },
        })
        const failed = vi.fn()
        const ready = vi.fn()
        host.onFailed(failed)
        host.onReady(ready)
        const t = setup({ stop: () => host.stop() })
        t.answers.push('restart')
        t.flow.start()
        host.start()
        await t.download('1.0.1')
        expect(sent).toEqual([STOP_MESSAGE])
        expect(t.events).toEqual(['ask 1.0.1'])
        // The server answers ready late, then drains and exits.
        onMessage({ type: 'openaflow:ready', port: 3110 })
        onExit(0)
        await settle()
        expect(t.events).toEqual(['ask 1.0.1', 'install'])
        vi.advanceTimersByTime(10 * 60_000)
        expect(forks).toBe(1)
        expect(ready).not.toHaveBeenCalled()
        expect(failed).not.toHaveBeenCalled()
        // The quit that the installer starts waits for the same stop.
        await expect(host.stop()).resolves.toBe('stopped')
        expect(sent).toEqual([STOP_MESSAGE])
      } finally {
        vi.useRealTimers()
      }
    })

    test('an unpackaged app, or an updater that failed to start, resolves at once', async () => {
      for (const t of [setup({ packaged: false }), setup({ updaterThrows: true })]) {
        t.flow.start()
        const s = watch(t.flow.lastChance())
        await settle()
        expect(s.done).toBe(true)
        expect(t.checks()).toBe(0)
      }
    })
  })

  test('outside an AppImage the updater stays off', async () => {
    // A packaged Linux app that runs from linux-unpacked or from an extracted AppImage: electron-updater can't replace it.
    for (const appImage of [undefined, '']) {
      const t = setup({ platform: 'linux', appImage })
      t.flow.start()
      t.flow.start()
      await t.clock.advance(RECHECK_MS * 3)
      expect(t.made()).toBe(0)
      expect(t.checks()).toBe(0)
      expect(t.clock.count()).toBe(0)
      expect(t.logs).toEqual(['openaflow desktop: update off: not started from an AppImage'])
      expect(t.flow.willCheck()).toBe(false)
      // After a server failure, the app quits at once: no check, no wait.
      let done = false
      void t.flow.lastChance().then(() => (done = true))
      await settle()
      expect(done).toBe(true)
      expect(t.checks()).toBe(0)
    }

    // Inside an AppImage, the updater runs as on Windows.
    const inside = setup({ platform: 'linux', appImage: '/home/u/Apps/openaflow-1.2.3-x86_64.AppImage' })
    inside.flow.start()
    await inside.clock.advance(FIRST_CHECK_MS)
    expect(inside.made()).toBe(1)
    expect(inside.checks()).toBe(1)
    expect(inside.logs).toEqual([])

    // Windows has no AppImage, and an unpackaged Linux app logs nothing.
    const windows = setup({ platform: 'win32', appImage: undefined })
    windows.flow.start()
    await windows.clock.advance(FIRST_CHECK_MS)
    expect(windows.checks()).toBe(1)
    expect(windows.logs).toEqual([])
    const dev = setup({ platform: 'linux', appImage: undefined, packaged: false })
    dev.flow.start()
    await dev.clock.advance(FIRST_CHECK_MS)
    expect(dev.checks()).toBe(0)
    expect(dev.logs).toEqual([])
  })
})
