import { describe, it, expect } from 'vitest'
import { theme, stateColor, stateLabel, barColor } from '../../src/render/theme.js'

describe('stateLabel', () => {
  it('maps the five real states', () => {
    expect(stateLabel('idle')).toBe('IDLE')
    expect(stateLabel('thinking')).toBe('THINKING')
    expect(stateLabel('tool')).toBe('TOOL')
    expect(stateLabel('permission')).toBe('PERMIT?')
    expect(stateLabel('done')).toBe('DONE')
  })

  it('maps an unknown state to BUSY', () => {
    expect(stateLabel('unknown')).toBe('BUSY')
  })
})

describe('stateColor', () => {
  it('gives permission the amber colour', () => {
    expect(stateColor('permission')).toEqual(theme.amber)
  })

  it('gives an unknown state the dim gray colour', () => {
    expect(stateColor('unknown')).toEqual(theme.gray)
  })

  it('gives every state a colour', () => {
    for (const s of ['idle', 'thinking', 'tool', 'permission', 'done', 'unknown'] as const) {
      expect(stateColor(s)).toHaveLength(3)
    }
  })
})

describe('barColor', () => {
  it('is green below 60 percent', () => {
    expect(barColor(0.0)).toEqual(theme.green)
    expect(barColor(0.59)).toEqual(theme.green)
  })

  it('is amber from 60 to 85 percent', () => {
    expect(barColor(0.6)).toEqual(theme.amber)
    expect(barColor(0.85)).toEqual(theme.amber)
  })

  it('is red above 85 percent', () => {
    expect(barColor(0.86)).toEqual(theme.red)
    expect(barColor(1.0)).toEqual(theme.red)
  })
})
