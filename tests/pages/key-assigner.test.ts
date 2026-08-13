import { describe, it, expect } from 'vitest'
import { KeyAssigner, SESSION_SLOTS } from '../../src/pages/key-assigner.js'
import type { Session } from '../../src/sources/claude.js'

function s(id: string, ts: number): Session {
  return {
    sessionId: id, state: 'idle', label: '', tool: '', project: id,
    cwd: '', termProgram: 'ghostty', pid: 1, startedAt: 0, ts,
  }
}

describe('KeyAssigner', () => {
  it('has three slots, since key 3 is the permanent crab tile', () => {
    expect(SESSION_SLOTS).toBe(3)
  })

  it('fills slots by ts, newest first, on the first call', () => {
    const a = new KeyAssigner()
    const r = a.assign([s('old', 100), s('new', 300), s('mid', 200)])
    expect(r.slots).toEqual(['new', 'mid', 'old'])
    expect(r.overflow).toBe(0)
  })

  it('keeps a session on its slot when its ts changes', () => {
    const a = new KeyAssigner()
    a.assign([s('x', 100), s('y', 200)])
    // y sorted first, so y is slot 0 and x is slot 1.
    const r = a.assign([s('x', 999), s('y', 200)])
    expect(r.slots).toEqual(['y', 'x', null])
  })

  it('gives a new session the lowest free slot', () => {
    const a = new KeyAssigner()
    a.assign([s('a', 300), s('b', 200)])
    expect(a.assign([s('a', 300), s('b', 200), s('c', 400)]).slots)
      .toEqual(['a', 'b', 'c'])
  })

  it('frees a slot when its session goes away', () => {
    const a = new KeyAssigner()
    a.assign([s('a', 300), s('b', 200)])
    expect(a.assign([s('b', 200)]).slots).toEqual([null, 'b', null])
  })

  it('reuses a freed slot for the next new session', () => {
    const a = new KeyAssigner()
    a.assign([s('a', 300), s('b', 200)])
    a.assign([s('b', 200)])
    expect(a.assign([s('b', 200), s('c', 400)]).slots)
      .toEqual(['c', 'b', null])
  })

  it('reports overflow past three sessions', () => {
    const a = new KeyAssigner()
    const r = a.assign([s('a', 600), s('b', 500), s('c', 400), s('d', 300), s('e', 200)])
    expect(r.slots).toEqual(['a', 'b', 'c'])
    expect(r.overflow).toBe(2)
  })

  it('gives a freed slot to the waiting session with the newest ts', () => {
    const a = new KeyAssigner()
    const five = [s('a', 600), s('b', 500), s('c', 400), s('d', 300), s('e', 200)]
    a.assign(five)
    // Drop 'b'. 'd' has a newer ts than 'e', so 'd' claims slot 1.
    const r = a.assign([s('a', 600), s('c', 400), s('d', 300), s('e', 200)])
    expect(r.slots).toEqual(['a', 'd', 'c'])
    expect(r.overflow).toBe(1)
  })

  it('returns all nulls for no sessions', () => {
    const a = new KeyAssigner()
    expect(a.assign([]).slots).toEqual([null, null, null])
  })

  it('empties every slot after every session ends', () => {
    const a = new KeyAssigner()
    a.assign([s('a', 100), s('b', 200)])
    expect(a.assign([]).slots).toEqual([null, null, null])
  })

  it('is stable across repeated identical calls', () => {
    const a = new KeyAssigner()
    const list = [s('a', 300), s('b', 200)]
    const first = a.assign(list)
    expect(a.assign(list).slots).toEqual(first.slots)
    expect(a.assign(list).slots).toEqual(first.slots)
  })

  it('a fourth live session stays invisible, counted as overflow', () => {
    const a = new KeyAssigner()
    const r = a.assign([s('a', 400), s('b', 300), s('c', 200), s('d', 100)])
    expect(r.slots).toHaveLength(3)
    expect(r.slots).not.toContain('d')
    expect(r.overflow).toBe(1)
  })
})
