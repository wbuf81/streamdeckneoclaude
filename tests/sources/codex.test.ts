import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSource, parseRolloutTail } from '../../src/sources/codex.js'

const TOKEN_EVENT = JSON.stringify({
  timestamp: '2026-08-13T12:00:00.000Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { total_tokens: 1_250_000 } },
    rate_limits: {
      primary: { used_percent: 27, window_minutes: 10080, resets_at: 1787068486 },
      secondary: null,
      plan_type: 'team',
    },
  },
})

describe('parseRolloutTail', () => {
  it('reports a task active when the newest lifecycle event is task_started', () => {
    const text = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    ].join('\n')
    expect(parseRolloutTail(text).active).toBe(true)
  })

  it('reports a task complete when completion follows its start', () => {
    const text = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n')
    expect(parseRolloutTail(text).active).toBe(false)
  })

  it('extracts limits, plan and total tokens without reading message bodies', () => {
    const state = parseRolloutTail(TOKEN_EVENT)
    expect(state.usage).toMatchObject({ totalTokens: 1_250_000, plan: 'team' })
    expect(state.usage?.limits[0]).toEqual({
      usedPct: 27, windowMinutes: 10080, resetsAt: 1787068486,
    })
  })

  it('ignores malformed and unrelated lines', () => {
    expect(parseRolloutTail('not json\n{"type":"response_item"}')).toEqual({
      active: false, usage: null,
    })
  })
})

describe('CodexSource', () => {
  it('keeps only active user tasks and publishes the newest usage sample', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const sqlite = vi.fn(async () => JSON.stringify([
      {
        id: 'active', rollout_path: '/active.jsonl', updated_at_ms: 200000,
        title: 'Build the Codex page', cwd: '/work/deckd', model: 'gpt-5.6-sol', tokens_used: 1234,
      },
      {
        id: 'done', rollout_path: '/done.jsonl', updated_at_ms: 100000,
        title: 'Old work', cwd: '/work/old', model: 'gpt-5.6-sol', tokens_used: 99,
      },
    ]))
    const readTail = (file: string) => {
      const text = file.includes('active')
        ? `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n${TOKEN_EVENT}\n`
        : `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      return { text, size: text.length }
    }
    const source = new CodexSource(database, sqlite, readTail, () => 500)
    try {
      await source.refresh()
      expect(source.isAvailable()).toBe(true)
      expect(source.getSnapshot().tasks).toEqual([expect.objectContaining({
        threadId: 'active', project: 'deckd', title: 'Build the Codex page',
      })])
      expect(source.getSnapshot().usage?.totalTokens).toBe(1_250_000)
    } finally {
      await source.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed to unavailable when the Codex schema cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const source = new CodexSource(database, async () => { throw new Error('schema changed') })
    try {
      await source.refresh()
      expect(source.isAvailable()).toBe(false)
      expect(source.getSnapshot().tasks).toEqual([])
    } finally {
      await source.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
