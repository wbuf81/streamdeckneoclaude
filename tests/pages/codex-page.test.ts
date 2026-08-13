import { describe, it, expect } from 'vitest'
import { CodexPage, formatTokenCount, limitLabel } from '../../src/pages/codex-page.js'
import type { CodexSnapshot } from '../../src/sources/codex.js'
import { theme } from '../../src/render/theme.js'

const NOW = 1786622400

function snapshot(over: Partial<CodexSnapshot> = {}): CodexSnapshot {
  return {
    tasks: [{
      threadId: 'thread-1', title: 'Improve the Stream Deck integration', project: 'deckd',
      model: 'gpt-5.6-sol', updatedAt: NOW, tokensUsed: 1_250_000,
    }],
    usage: {
      limits: [{ usedPct: 27, windowMinutes: 10080, resetsAt: NOW + 86400 }],
      totalTokens: 1_250_000, plan: 'team', ts: NOW,
    },
    ...over,
  }
}

function build(data = snapshot(), available = true, stale = false) {
  return new CodexPage({
    getSnapshot: () => data,
    isAvailable: () => available,
    isStale: () => stale,
  })
}

describe('CodexPage', () => {
  it('renders exactly eight keys', () => {
    expect(build().render(NOW).keys).toHaveLength(8)
  })

  it('puts active tasks in the first three tiles', () => {
    const key = build().render(NOW).keys[0]!
    expect(key.lines).toEqual(['RUNNING', 'deckd', 'Improve the S…', 'gpt-5.6-sol'])
    expect(key.border).toEqual(theme.green)
  })

  it('leaves unused task slots blank', () => {
    const keys = build().render(NOW).keys
    expect(keys[1]!.kind).toBe('blank')
    expect(keys[2]!.kind).toBe('blank')
  })

  it('keeps a permanent OpenAI Codex identity tile at key 3', () => {
    expect(build().render(NOW).keys[3]!.lines).toEqual(['OPENAI', 'CODEX', '1 ACTIVE'])
  })

  it('shows the account limit percentage and reset countdown', () => {
    const keys = build().render(NOW).keys
    expect(keys[4]!.lines).toEqual(['WEEK CAP', '27%'])
    expect(keys[4]!.bar?.value).toBeCloseTo(0.27)
    expect(keys[7]!.lines?.[1]).toBe('1d0h')
  })

  it('uses key 5 for the plan when there is no second limit', () => {
    expect(build().render(NOW).keys[5]!.lines?.slice(0, 2)).toEqual(['PLAN', 'TEAM'])
  })

  it('shows task token usage compactly', () => {
    expect(build().render(NOW).keys[6]!.lines?.[1]).toBe('1.3M')
  })

  it('dims unavailable data and explains it on the strip', () => {
    const page = build({ tasks: [], usage: null }, false, true)
    const frame = page.render(NOW)
    expect(frame.keys[3]!.dim).toBe(true)
    expect(frame.strip).toEqual({ lines: ['codex', 'task data unavailable'], dim: true })
  })

  it('marks usage stale without hiding the last known values', () => {
    const key = build(snapshot(), true, true).render(NOW).keys[4]!
    expect(key.lines).toEqual(['WEEK CAP', '27%', 'STALE'])
    expect(key.bar).toBeUndefined()
  })

  it('reports overflow on the strip', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      threadId: String(i), title: `Task ${i}`, project: 'deckd', model: 'gpt',
      updatedAt: NOW - i, tokensUsed: 1,
    }))
    expect(build(snapshot({ tasks })).render(NOW).strip.lines[1]).toBe('+2 more')
  })
})

describe('Codex page formatting', () => {
  it('formats common rate-limit windows', () => {
    expect(limitLabel(300)).toBe('5-HR CAP')
    expect(limitLabel(10080)).toBe('WEEK CAP')
  })

  it('formats token counts compactly', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(12_400)).toBe('12.4K')
    expect(formatTokenCount(15_200_000)).toBe('15M')
  })
})
