import { describe, expect, test } from 'vitest'
import { holdsMarker, parseStat, procReader, readStat, snapshot, type ProcReader } from './proc-scan.ts'

const MARKER = '6f1c2a9e-1111-4222-8333-944455556666'

type FakeProc = { pid: number; ppid: number; pgid: number; state?: string; start: number; env?: string[] | null; comm?: string }

/** A /proc with the given processes. `env: null` is an environ that can't be read; a missing stat is a gone pid. */
function fakeProc(procs: FakeProc[], o: { unreadableStat?: number[] } = {}): ProcReader {
  const by = new Map(procs.map((p) => [p.pid, p]))
  return {
    pids: () => [...by.keys(), ...(o.unreadableStat ?? [])],
    stat(pid) {
      const p = by.get(pid)
      if (!p) return null
      const rest = [p.state ?? 'S', p.ppid, p.pgid, p.pgid, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, p.start, 1000, 10]
      return `${pid} (${p.comm ?? 'node'}) ${rest.join(' ')}\n`
    },
    environ(pid) {
      const p = by.get(pid)
      if (!p || p.env === null) return null
      return (p.env ?? ['PATH=/usr/bin']).map((e) => `${e}\0`).join('')
    },
  }
}

const marked = [`${'OPENAFLOW_RUN'}=${MARKER}`, 'PATH=/usr/bin']

describe('stat lines', () => {
  test('a name with spaces and brackets still parses', () => {
    const line = '4242 (a) (b c)) Z 7 4242 4242 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 987654 1 1 18446744073709551615\n'
    expect(parseStat(line)).toEqual({ pid: 4242, ppid: 7, pgid: 4242, state: 'Z', startTime: '987654' })
  })

  test('a broken line is null', () => {
    expect(parseStat('')).toBeNull()
    expect(parseStat('12 (x) S 1 2')).toBeNull()
    expect(parseStat('x (y) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20')).toBeNull()
  })

  test.runIf(process.platform === 'linux')('this process reads from the real /proc', () => {
    const me = readStat(procReader(), process.pid)
    expect(me).toMatchObject({ pid: process.pid, ppid: process.ppid, state: expect.any(String) })
    expect(me?.startTime).toMatch(/^[0-9]+$/)
  })

  test('the marker matches a whole env entry only', () => {
    expect(holdsMarker(`A=1\0OPENAFLOW_RUN=${MARKER}\0B=2\0`, MARKER)).toBe(true)
    expect(holdsMarker(`OPENAFLOW_RUN=${MARKER}`, MARKER)).toBe(true)
    expect(holdsMarker(`OPENAFLOW_RUN=${MARKER}x\0`, MARKER)).toBe(false)
    expect(holdsMarker(`XOPENAFLOW_RUN=${MARKER}\0`, MARKER)).toBe(false)
    expect(holdsMarker(`OPENAFLOW_RUN=\0`, '')).toBe(false)
    expect(holdsMarker(`OPENAFLOW_RUN=A\0`, 'A')).toBe(false)
  })
})

describe('snapshot', () => {
  const table = () =>
    fakeProc([
      { pid: 1, ppid: 0, pgid: 1, start: 1 },
      { pid: 900, ppid: 1, pgid: 900, start: 50 }, // the host
      { pid: 1000, ppid: 900, pgid: 1000, start: 100, env: marked }, // the session's root, its group leader
      { pid: 1001, ppid: 1000, pgid: 1000, start: 101, env: ['PATH=/usr/bin'] }, // group member, env cleared
      { pid: 1002, ppid: 1000, pgid: 1002, start: 102, env: null }, // detached child: descendant, environ unreadable
      { pid: 1003, ppid: 1002, pgid: 1002, start: 103, env: ['A=1'] }, // its child
      { pid: 1004, ppid: 1, pgid: 1004, start: 104, env: marked }, // setsid orphan, found by its marker
      { pid: 1005, ppid: 1, pgid: 1005, start: 105, env: [`OPENAFLOW_RUN=${MARKER}0`] }, // another marker
      { pid: 1006, ppid: 1, pgid: 1006, start: 106, env: null }, // unreadable stranger
      { pid: 1007, ppid: 1000, pgid: 1000, state: 'Z', start: 107, env: marked }, // a zombie is gone already
      { pid: 2000, ppid: 1, pgid: 2000, start: 200, env: ['PATH=/usr/bin'] }, // a stranger
      { pid: 2001, ppid: 1, pgid: 2001, start: 201, env: ['OPENAFLOW_RUN='] }, // empty marker
      { pid: 2002, ppid: 1, pgid: 2002, start: 202, env: ['OPENAFLOW_RUN=A B'] }, // not a marker
    ], { unreadableStat: [3000] })

  test('holds the group, the descendants, and marker holders with start times, and skips unreadable entries', () => {
    const snap = snapshot(table(), { pid: 1000, marker: MARKER })
    expect([...snap.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1000, '100'],
      [1001, '101'],
      [1002, '102'],
      [1003, '103'],
      [1004, '104'],
    ])
  })

  test('pid 0 takes marker holders only', () => {
    expect([...snapshot(table(), { pid: 0, marker: MARKER }).keys()].sort()).toEqual([1000, 1004])
  })

  test('a root pid without the marker is not the session any more: marker holders only', () => {
    expect([...snapshot(table(), { pid: 2000, marker: MARKER }).keys()].sort()).toEqual([1000, 1004])
  })

  test('a bad marker matches nothing, and takes no tree', () => {
    expect(snapshot(table(), { pid: 1000, marker: '' }).size).toBe(0)
    expect(snapshot(table(), { pid: 1000, marker: 'A B' }).size).toBe(0)
  })

  test('a root that leads no group adds its descendants but not its group', () => {
    const r = fakeProc([
      { pid: 900, ppid: 1, pgid: 900, start: 50 },
      { pid: 1000, ppid: 900, pgid: 900, start: 100, env: marked },
      { pid: 1001, ppid: 1000, pgid: 900, start: 101 },
    ])
    expect([...snapshot(r, { pid: 1000, marker: MARKER }).keys()].sort()).toEqual([1000, 1001])
  })
})
