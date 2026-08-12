import { describe, it, expect } from 'vitest'
import { PageManager } from '../src/page-manager.js'
import type { Page } from '../src/pages/types.js'
import type { DeckFrame } from '../src/render/specs.js'

function fakePage(name: string, log: string[] = []): Page {
  return {
    name,
    render: (): DeckFrame => ({
      keys: Array.from({ length: 8 }, () => ({ kind: 'blank' as const })),
      strip: { lines: [name] },
      buttons: [[0, 0, 0], [0, 0, 0]],
    }),
    onKeyPress: (i) => { log.push(`${name}:${i}`) },
    onEnter: () => { log.push(`${name}:enter`) },
    onLeave: () => { log.push(`${name}:leave`) },
  }
}

describe('PageManager', () => {
  it('starts on the first page', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.add(fakePage('b'))
    expect(m.index).toBe(0)
    expect(m.current().name).toBe('a')
  })

  it('moves to the next page', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.add(fakePage('b'))
    m.next()
    expect(m.current().name).toBe('b')
  })

  it('wraps forward past the last page', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.add(fakePage('b'))
    m.next()
    m.next()
    expect(m.current().name).toBe('a')
  })

  it('wraps backward before the first page', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.add(fakePage('b'))
    m.prev()
    expect(m.current().name).toBe('b')
  })

  it('calls onLeave then onEnter on a page change', () => {
    const log: string[] = []
    const m = new PageManager()
    m.add(fakePage('a', log))
    m.add(fakePage('b', log))
    log.length = 0
    m.next()
    expect(log).toEqual(['a:leave', 'b:enter'])
  })

  it('does not fire lifecycle hooks when the index does not change', () => {
    const log: string[] = []
    const m = new PageManager()
    m.add(fakePage('a', log))
    log.length = 0
    m.next()
    expect(log).toEqual([])
  })

  it('routes a key press to the current page', () => {
    const log: string[] = []
    const m = new PageManager()
    m.add(fakePage('a', log))
    m.add(fakePage('b', log))
    m.next()
    void m.onKeyPress(3)
    expect(log).toContain('b:3')
  })

  it('throws when asked for a page before one is added', () => {
    expect(() => new PageManager().current()).toThrow(/no page/i)
  })

  it('ignores setIndex outside the range', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.setIndex(9)
    expect(m.index).toBe(0)
  })

  it('restores a saved index', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.add(fakePage('b'))
    m.setIndex(1)
    expect(m.current().name).toBe('b')
  })
})
