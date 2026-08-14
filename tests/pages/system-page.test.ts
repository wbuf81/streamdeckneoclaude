import { describe, it, expect } from 'vitest'
import {
  SystemPage,
  batteryLines,
  diskFreePercent,
  diskLowOnSpace,
  formatRate,
  formatRssKb,
  formatSwapLine,
  swapInUse,
  DISK_LOW_FREE_PERCENT,
  type SystemReader,
} from '../../src/pages/system-page.js'
import { theme } from '../../src/render/theme.js'
import { renderKey, probe, KEY_SIZE } from '../../src/render/canvas.js'
import type {
  BatteryInfo,
  CpuInfo,
  DiskInfo,
  LoadInfo,
  MemInfo,
  NetInfo,
  ProcessSample,
  SystemStatus,
} from '../../src/sources/system.js'

const NOW = 1_755_000_000

/** Allows a small difference, because canvas anti-aliases edges — same
 * tolerance `weather-page.test.ts` and `stocks-page.test.ts` use. */
function near3(actual: readonly number[], expected: readonly number[], tol = 12): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(actual[i]! - expected[i]!) > tol) return false
  }
  return true
}

interface Fakes {
  cpu: CpuInfo
  mem: MemInfo
  disk: DiskInfo
  net: NetInfo
  battery: BatteryInfo
  load: LoadInfo
  uptimeSeconds: number | null
  topCpu: ProcessSample[]
  topMem: ProcessSample[]
  processCount: number | null
  status: SystemStatus
}

function process(name: string, pct: number, rssKb: number): ProcessSample {
  return { name, pct, rssKb }
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    cpu: { percent: 34, spark: [10, 20, 34] },
    mem: { pressure: 'normal', swapUsedMb: 0, pageouts: 145393 },
    disk: { usedPercent: 14, freeText: '838G', totalText: '995G' },
    net: { downBytesPerSec: 2_100_000, upBytesPerSec: 300_000 },
    battery: { percent: 80, state: 'ac-not-charging', minutesRemaining: null },
    load: { load1: 1.11, coreCount: 18, normalizedPercent: 6.2 },
    uptimeSeconds: 3 * 3600 + 12 * 60,
    topCpu: [process('Chrome Helper', 41, 512_000), process('claude', 10.3, 879_488)],
    topMem: [process('Xcode', 22, 4_200_000), process('claude', 1.7, 879_488)],
    processCount: 1006,
    status: 'ok',
    ...over,
  }
  const calls: string[] = []
  const source: SystemReader = {
    getCpu: () => f.cpu,
    getMem: () => f.mem,
    getDisk: () => f.disk,
    getNet: () => f.net,
    getBattery: () => f.battery,
    getLoad: () => f.load,
    getUptimeSeconds: () => f.uptimeSeconds,
    getTopCpu: () => f.topCpu,
    getTopMem: () => f.topMem,
    getProcessCount: () => f.processCount,
    getStatus: () => f.status,
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
  }
  return { page: new SystemPage(source), calls, f }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('formatSwapLine', () => {
  it('shows the measured healthy baseline of exactly zero plainly', () => {
    expect(formatSwapLine(0)).toBe('swap 0')
  })

  it('shows -- for an unknown reading, never swap 0', () => {
    expect(formatSwapLine(null)).toBe('swap --')
  })

  it('formats megabytes and gigabytes', () => {
    expect(formatSwapLine(512)).toBe('swap 512M')
    expect(formatSwapLine(2048)).toBe('swap 2.0G')
  })
})

describe('swapInUse', () => {
  it('is false at the healthy zero baseline', () => {
    expect(swapInUse({ pressure: 'normal', swapUsedMb: 0, pageouts: null })).toBe(false)
  })

  it('is false, not an alert, when unknown', () => {
    expect(swapInUse({ pressure: 'normal', swapUsedMb: null, pageouts: null })).toBe(false)
  })

  it('is true for any positive amount', () => {
    expect(swapInUse({ pressure: 'normal', swapUsedMb: 1, pageouts: null })).toBe(true)
  })
})

describe('diskFreePercent / diskLowOnSpace', () => {
  it('derives free percent from used percent', () => {
    expect(diskFreePercent({ usedPercent: 14, freeText: '838G', totalText: '995G' })).toBe(86)
  })

  it('flags low space under the brief-defined threshold', () => {
    expect(diskLowOnSpace({ usedPercent: 91, freeText: '9G', totalText: '100G' })).toBe(true)
    expect(diskLowOnSpace({ usedPercent: 90, freeText: '10G', totalText: '100G' })).toBe(false)
    expect(DISK_LOW_FREE_PERCENT).toBe(10)
  })

  it('is not an alert when disk usage was never read', () => {
    expect(diskLowOnSpace({ usedPercent: null, freeText: null, totalText: null })).toBe(false)
  })
})

describe('formatRate', () => {
  it('formats bytes, kilobytes and megabytes per second', () => {
    expect(formatRate(500)).toBe('500B/s')
    expect(formatRate(2048)).toBe('2K/s')
    expect(formatRate(2_100_000)).toBe('2.0M/s')
  })

  it('is -- for an unknown rate (the first sample), never 0B/s', () => {
    expect(formatRate(null)).toBe('--')
  })
})

describe('formatRssKb', () => {
  it('formats kilobytes, megabytes and gigabytes', () => {
    expect(formatRssKb(512)).toBe('512K')
    expect(formatRssKb(879_488)).toBe('859M')
    expect(formatRssKb(4_200_000)).toBe('4.0G')
  })
})

describe('batteryLines', () => {
  it('shows the measured AC-attached optimised-charging state as "holding", never an alert', () => {
    const { lines, alert } = batteryLines({ percent: 80, state: 'ac-not-charging', minutesRemaining: null })
    expect(lines).toEqual(['BATTERY', '80% AC', 'holding'])
    expect(alert).toBe(false)
  })

  it('shows charging plainly', () => {
    const { lines, alert } = batteryLines({ percent: 55, state: 'ac-charging', minutesRemaining: null })
    expect(lines).toEqual(['BATTERY', '55% AC', 'charging'])
    expect(alert).toBe(false)
  })

  it('flags discharging as an alert and shows the remaining time', () => {
    const { lines, alert } = batteryLines({ percent: 45, state: 'discharging', minutesRemaining: 179 })
    expect(lines).toEqual(['BATTERY', '45%', '2h59m'])
    expect(alert).toBe(true)
  })

  it('degrades a desktop Mac to "no battery", never a fabricated 0%', () => {
    const { lines, alert } = batteryLines({ percent: null, state: 'none', minutesRemaining: null })
    expect(lines).toEqual(['BATTERY', '--', 'no battery'])
    expect(alert).toBe(false)
  })

  it('shows -- for an unknown state without guessing an alert', () => {
    const { lines, alert } = batteryLines({ percent: null, state: 'unknown', minutesRemaining: null })
    expect(lines).toEqual(['BATTERY', '--', '--'])
    expect(alert).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Grid layout
// ---------------------------------------------------------------------------

describe('SystemPage grid', () => {
  it('returns 8 keys in the brief-specified order', () => {
    const { page } = build()
    const keys = page.render(NOW).keys
    expect(keys).toHaveLength(8)
    expect(keys[0]!.lines![0]).toBe('CPU 34%')
    expect(keys[1]!.lines![0]).toBe('MEM')
    expect(keys[2]!.lines![0]).toBe('DISK')
    expect(keys[3]!.lines![0]).toBe('NET')
    expect(keys[4]!.lines![0]).toBe('BATTERY')
    expect(keys[5]!.lines![0]).toBe('LOAD')
    expect(keys[6]!.lines![0]).toBe('TOP CPU')
    expect(keys[7]!.lines![0]).toBe('TOP MEM')
  })

  it('shows CPU -- (never CPU 0%) on the first sample, per lesson 18', () => {
    const { page } = build({ cpu: { percent: null, spark: [] } })
    expect(page.render(NOW).keys[0]!.lines).toEqual(['CPU --'])
  })

  it('carries a sparkline only once at least 2 samples exist', () => {
    const { page: withSpark } = build({ cpu: { percent: 34, spark: [10, 34] } })
    expect(withSpark.render(NOW).keys[0]!.spark).toBeDefined()

    const { page: noSpark } = build({ cpu: { percent: null, spark: [] } })
    expect(noSpark.render(NOW).keys[0]!.spark).toBeUndefined()
  })

  it('names the culprit on TOP CPU and TOP MEM — the whole differentiator', () => {
    const { page } = build()
    const keys = page.render(NOW).keys
    expect(keys[6]!.lines).toEqual(['TOP CPU', 'Chrome Helper', '41%'])
    expect(keys[7]!.lines).toEqual(['TOP MEM', 'Xcode', '4.0G'])
  })

  it('shows -- for top process tiles when no sample has arrived yet', () => {
    const { page } = build({ topCpu: [], topMem: [] })
    const keys = page.render(NOW).keys
    expect(keys[6]!.lines).toEqual(['TOP CPU', '--', '--'])
    expect(keys[7]!.lines).toEqual(['TOP MEM', '--', '--'])
  })

  it('shows the MEM tile pressure label and swap line', () => {
    const { page } = build()
    expect(page.render(NOW).keys[1]!.lines).toEqual(['MEM', 'NORMAL', 'swap 0'])
  })

  it('colours the MEM tile red on critical pressure', () => {
    const { page } = build({ mem: { pressure: 'critical', swapUsedMb: 0, pageouts: null } })
    const key = page.render(NOW).keys[1]!
    expect(key.border).toEqual(theme.red)
  })

  it('colours the MEM tile amber when swap is in use, even with normal pressure', () => {
    const { page } = build({ mem: { pressure: 'normal', swapUsedMb: 512, pageouts: null } })
    const key = page.render(NOW).keys[1]!
    expect(key.border).toEqual(theme.amber)
  })

  it('does not alert the MEM tile at the healthy zero-swap, normal-pressure baseline', () => {
    const { page } = build()
    expect(page.render(NOW).keys[1]!.border).toBeUndefined()
  })

  it('shows the DISK tile free space and flags low space in red', () => {
    const { page: ok } = build()
    expect(ok.render(NOW).keys[2]!.lines).toEqual(['DISK', '838G', 'free'])
    expect(ok.render(NOW).keys[2]!.border).toBeUndefined()

    const { page: low } = build({ disk: { usedPercent: 95, freeText: '5G', totalText: '100G' } })
    expect(low.render(NOW).keys[2]!.border).toEqual(theme.red)
  })

  it('shows NET arrows with the formatted rate, and -- on the first sample', () => {
    const { page } = build()
    expect(page.render(NOW).keys[3]!.lines).toEqual(['NET', '↓2.0M/s', '↑293K/s'])

    const { page: unknown } = build({ net: { downBytesPerSec: null, upBytesPerSec: null } })
    expect(unknown.render(NOW).keys[3]!.lines).toEqual(['NET', '↓--', '↑--'])
  })

  it('shows LOAD normalised by core count', () => {
    const { page } = build()
    expect(page.render(NOW).keys[5]!.lines).toEqual(['LOAD', '6%', '18 cores'])
  })

  it('dims every tile while status is empty, and none while ok', () => {
    const { page: empty } = build({ status: 'empty' })
    for (const key of empty.render(NOW).keys) expect(key.dim).toBe(true)

    const { page: ok } = build({ status: 'ok' })
    for (const key of ok.render(NOW).keys) expect(key.dim).toBeUndefined()
  })

  it('shows the worst active alert on the strip, in priority order', () => {
    const { page: critical } = build({
      mem: { pressure: 'critical', swapUsedMb: 5, pageouts: null },
      disk: { usedPercent: 95, freeText: '5G', totalText: '100G' },
    })
    expect(critical.render(NOW).strip.lines[0]).toBe('MEMORY PRESSURE: CRITICAL')

    const { page: lowDisk } = build({
      mem: { pressure: 'normal', swapUsedMb: 5, pageouts: null },
      disk: { usedPercent: 95, freeText: '5G', totalText: '100G' },
    })
    expect(lowDisk.render(NOW).strip.lines[0]).toBe('LOW DISK: 5% free')

    const { page: swap } = build({ mem: { pressure: 'normal', swapUsedMb: 512, pageouts: null } })
    expect(swap.render(NOW).strip.lines[0]).toBe('SWAP IN USE: 512M')

    const { page: batt } = build({ battery: { percent: 45, state: 'discharging', minutesRemaining: 30 } })
    expect(batt.render(NOW).strip.lines[0]).toBe('ON BATTERY: 45%')
  })

  it('falls back to uptime on the strip when nothing is wrong', () => {
    const { page } = build()
    expect(page.render(NOW).strip.lines[0]).toBe('up 3h12m')
  })

  it('shows up -- rather than a fabricated uptime when unknown', () => {
    const { page } = build({ uptimeSeconds: null })
    expect(page.render(NOW).strip.lines[0]).toBe('up --')
  })
})

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

describe('SystemPage drill-down', () => {
  it('pressing CPU opens the top-five CPU drill-down', () => {
    const { page } = build()
    expect(page.onKeyPress(0)).toBe('handled')
    const keys = page.render(NOW).keys
    expect(keys).toHaveLength(8)
    expect(keys[0]!.lines![0]).toBe('CPU 34%')
    expect(keys[1]!.lines).toEqual(['#1', 'Chrome Helper', '41%'])
    expect(keys[2]!.lines).toEqual(['#2', 'claude', '10%'])
    expect(keys[7]!.lines).toEqual(['◀ BACK'])
  })

  it('pressing MEM opens the top-five memory drill-down, in gigabytes/megabytes', () => {
    const { page } = build()
    expect(page.onKeyPress(1)).toBe('handled')
    const keys = page.render(NOW).keys
    expect(keys[0]!.lines![0]).toBe('MEM')
    expect(keys[1]!.lines).toEqual(['#1', 'Xcode', '4.0G'])
    expect(keys[2]!.lines).toEqual(['#2', 'claude', '859M'])
  })

  it('shows total process count on key 6 of the CPU drill-down', () => {
    const { page } = build()
    page.onKeyPress(0)
    expect(page.render(NOW).keys[6]!.lines).toEqual(['PROCS', '1006'])
  })

  it('shows cumulative pageouts on key 6 of the MEM drill-down', () => {
    const { page } = build()
    page.onKeyPress(1)
    expect(page.render(NOW).keys[6]!.lines).toEqual(['PAGEOUTS', '145393'])
  })

  it('shows a dashed placeholder, never a crash, for a missing rank', () => {
    const { page } = build({ topCpu: [process('Solo', 5, 1024)] })
    page.onKeyPress(0)
    const keys = page.render(NOW).keys
    expect(keys[2]!.lines).toEqual(['#2', '--', '--'])
    expect(keys[5]!.lines).toEqual(['#5', '--', '--'])
  })

  it('keeps the status line visible on the strip inside the drill-down (per weather/stocks M2)', () => {
    const { page } = build({ mem: { pressure: 'critical', swapUsedMb: 0, pageouts: null } })
    page.onKeyPress(0)
    const strip = page.render(NOW).strip
    expect(strip.lines[0]).toBe('TOP CPU PROCESSES')
    expect(strip.lines[1]).toBe('MEMORY PRESSURE: CRITICAL')
  })

  it('BACK on key 7 returns to the grid', () => {
    const { page } = build()
    page.onKeyPress(0)
    expect(page.render(NOW).keys[1]!.lines![0]).toBe('#1') // confirms detail mode
    expect(page.onKeyPress(7)).toBe('handled')
    expect(page.render(NOW).keys[0]!.lines![0]).toBe('CPU 34%')
    expect(page.render(NOW).keys[1]!.lines![0]).toBe('MEM')
  })
})

// ---------------------------------------------------------------------------
// Press outcomes — truthful for every key in both modes
// ---------------------------------------------------------------------------

describe('SystemPage press outcomes', () => {
  it('ignores every grid key except CPU and MEM', () => {
    const { page } = build()
    for (const i of [2, 3, 4, 5, 6, 7]) {
      const { page: fresh } = build()
      expect(fresh.onKeyPress(i)).toBe('ignored')
    }
    expect(page.onKeyPress(0)).toBe('handled')
  })

  it('ignores keys 0 to 6 while a drill-down is open', () => {
    const { page } = build()
    page.onKeyPress(0)
    for (const i of [0, 1, 2, 3, 4, 5, 6]) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('SystemPage lifecycle', () => {
  it('tells the source it is visible on enter, and not visible on leave', () => {
    const { page, calls } = build()
    page.onEnter?.()
    page.onLeave?.()
    expect(calls).toEqual(['visible:true', 'visible:false'])
  })

  it('resets to the grid when the page becomes visible again', () => {
    const { page } = build()
    page.onKeyPress(0)
    page.onLeave?.()
    expect(page.render(NOW).keys[0]!.lines![0]).toBe('CPU 34%')
  })
})

// ---------------------------------------------------------------------------
// Real-canvas geometry: the widest realistic process name must not spill
// past the key's right margin. Same proof shape as
// tests/pages/weather-page.test.ts's own "text fits the usable key width"
// block: `lineSizes` declares candidates, `renderKey` measures and
// truncates, so the proof has to render real pixels and probe a REGION, not
// read the declared candidates as final (docs/LESSONS.md #22).
// ---------------------------------------------------------------------------

describe('SystemPage keeps process names clear of the right margin', () => {
  const RIGHT_EDGE_X = 90 // BORDER(3) + PAD(6) + usable width(81)
  const RIGHT_EDGE_BAND_END = 95 // KEY_SIZE(96) - 1: probe the whole margin

  function noInkAtOrPastRightEdge(buf: Buffer): boolean {
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = RIGHT_EDGE_X; x <= RIGHT_EDGE_BAND_END; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) return false
      }
    }
    return true
  }

  it('shrinks the measured 250-character comm path basename to fit the grid TOP CPU tile', () => {
    // Measured on this Mac (docs/VERIFIED-FACTS.md): even the BASENAME of a
    // real long comm path is well over budget —
    // "Microsoft Teams WebView Helper (Renderer)" is 42 characters, several
    // times the 81 px budget at any candidate size in VARIABLE_SIZES.
    const longest = 'Microsoft Teams WebView Helper (Renderer)'
    const { page } = build({ topCpu: [process(longest, 41, 1_111_040)] })
    const key = page.render(NOW).keys[6]!
    expect(noInkAtOrPastRightEdge(renderKey(key))).toBe(true)
  })

  it('shrinks the same long name to fit a ranked process tile in the drill-down', () => {
    const longest = 'Microsoft Teams WebView Helper (Renderer)'
    const { page } = build({ topCpu: [process(longest, 41, 1_111_040)] })
    page.onKeyPress(0)
    const key = page.render(NOW).keys[1]!
    expect(noInkAtOrPastRightEdge(renderKey(key))).toBe(true)
  })

  it('keeps every grid tile clear of the right margin at once', () => {
    const { page } = build()
    for (const key of page.render(NOW).keys) {
      expect(noInkAtOrPastRightEdge(renderKey(key))).toBe(true)
    }
  })
})
