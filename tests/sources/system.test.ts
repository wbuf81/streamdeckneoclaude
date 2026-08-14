import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SystemSource,
  PRIMARY_INTERFACE,
  cpuPercent,
  normalizedLoadPercent,
  parseBattery,
  parseDf,
  parseNetstatInterface,
  parsePageouts,
  parsePressureLevel,
  parsePsList,
  parseSwapUsedMb,
  type CpuTimes,
  type Runner,
} from '../../src/sources/system.js'
import { createLogger } from '../../src/log.js'

/**
 * A test's `runner` must never fall back to a real shell command — the same
 * discipline `stocks.test.ts` enforces for `fetch`. Anything that expects no
 * call at all passes this instead of leaving the constructor's default.
 */
const neverRun: Runner = async () => {
  throw new Error('test: runner must not be called')
}

const NOW = 1_755_000_000

// ---------------------------------------------------------------------------
// Fixtures captured live on this machine (docs/VERIFIED-FACTS.md /
// task-41-brief.md). Per docs/LESSONS.md #22, a fixture invented from
// documentation rather than real output has already hidden a Critical on
// this project — these are the actual command output, not a guess at its
// shape.
// ---------------------------------------------------------------------------

/** `df -H /System/Volumes/Data`, captured live. */
const DF_OUTPUT = [
  'Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on',
  '/dev/disk3s5    995G    133G    838G    14%    2.0M  8.2G    0%   /System/Volumes/Data',
].join('\n')

/** `pmset -g batt`, captured live: AC attached, optimised charging — the
 * state that looks like a fault but is not. */
const PMSET_AC_HOLDING = [
  "Now drawing from 'AC Power'",
  " -InternalBattery-0 (id=35848291)\t80%; AC attached; not charging present: true",
].join('\n')

/**
 * NOT captured on this machine — this Mac was on AC for every measurement
 * taken while building this page, so a genuine discharging reading was
 * never produced. Built from `pmset`'s own well-documented output grammar
 * (the same `N%; <state>; H:MM remaining present: true` shape the AC
 * fixture above shows), the same disclosed-exception treatment
 * `sources/system.ts` already uses for the pressure-level `2`/`4` constants.
 */
const PMSET_DISCHARGING = [
  "Now drawing from 'Battery Power'",
  ' -InternalBattery-0 (id=35848291)\t45%; discharging; 2:59 remaining present: true',
].join('\n')

/** Same disclosed-exception basis: a desktop Mac's real, well-documented
 * shape (no `InternalBattery` line at all), not reproduced on this
 * (laptop-class) measurement machine. */
const PMSET_NO_BATTERY = "Now drawing from 'AC Power'"

/** `netstat -ib`, trimmed to the rows that matter, captured live: `lo0`'s
 * `<Link#>` row has no MAC address (one field shorter than `en0`'s), and
 * both `lo0` and `en0` appear a second time on an inet/inet6 row with
 * IDENTICAL counters. */
const NETSTAT_OUTPUT = [
  'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
  'lo0        16384 <Link#1>                        421063     0  168209585   421063     0  168209585     0',
  'lo0        16384 127           localhost         421063     -  168209585   421063     -  168209585     -',
  'en0        1500  <Link#15>   fc:b2:14:ba:91:ce 27958782     0 25077128113 21363919     0 17459250667     0',
  'en0        1500  j2fhf3270v- fe80:f::1033:564a 27958782     - 25077128113 21363919     - 17459250667     -',
].join('\n')

/** `sysctl vm.swapusage kern.memorystatus_vm_pressure_level`, captured live
 * — the healthy baseline this Mac actually measured: zero swap in use,
 * pressure level 1 (normal). */
const SYSCTL_HEALTHY = [
  'vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)',
  'kern.memorystatus_vm_pressure_level: 1',
].join('\n')

/** `memory_pressure`, trimmed to the section this file reads, captured live. */
const MEMORY_PRESSURE_OUTPUT = [
  'File I/O:',
  'Pageins: 22754588 ',
  'Pageouts: 145393 ',
  '',
  'System-wide memory free percentage: 79%',
].join('\n')

/** `ps -Ao pcpu,rss,comm -r`, trimmed to the header plus a few real rows,
 * captured live — including one long `.app/Contents/MacOS/...` path with a
 * space in it, the exact shape docs/VERIFIED-FACTS.md measured at roughly
 * 250 characters for the longest real line. */
const PS_CPU_OUTPUT = [
  ' %CPU    RSS COMM',
  ' 31.8 393616 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
  ' 27.4 530080 /Applications/Microsoft Defender.app/Contents/MacOS/wdavdaemon_unprivileged.app/Contents/MacOS/wdavdaemon_unprivileged',
  ' 16.1 494960 /Applications/Microsoft Edge.app/Contents/Frameworks/Microsoft Edge Framework.framework/Versions/151.0.4129.78/Helpers/Microsoft Edge Helper (Renderer).app/Contents/MacOS/Microsoft Edge Helper (Renderer)',
  ' 10.3 879488 claude',
].join('\n')

/** `ps -Ao pmem,rss,comm -m`, same treatment. */
const PS_MEM_OUTPUT = [
  '%MEM    RSS COMM',
  ' 2.2 1111040 /Applications/Microsoft Teams.app/Contents/Helpers/Microsoft Teams WebView.app/Contents/Frameworks/Microsoft Edge Framework.framework/Versions/151.0.4129.78/Helpers/Microsoft Teams WebView Helper (Renderer).app/Contents/MacOS/Microsoft Teams WebView Helper (Renderer)',
  ' 1.7 879488 claude',
].join('\n')

function core(t: Partial<CpuTimes>): { times: CpuTimes } {
  return { times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...t } }
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe('cpuPercent', () => {
  it('computes busy percent from the delta between two samples', () => {
    const prev = [core({ user: 1000, idle: 9000 }), core({ user: 1000, idle: 9000 })]
    const next = [core({ user: 1500, idle: 9500 }), core({ user: 1500, idle: 9500 })]
    expect(cpuPercent(prev, next)).toBeCloseTo(50, 5)
  })

  it('returns null, never 0, when the interval does not advance', () => {
    const sample = [core({ user: 1000, idle: 9000 })]
    expect(cpuPercent(sample, sample)).toBeNull()
  })

  it('returns null when ticks went backwards (a counter reset)', () => {
    const prev = [core({ user: 2000, idle: 9000 })]
    const next = [core({ user: 1000, idle: 9000 })]
    expect(cpuPercent(prev, next)).toBeNull()
  })

  it('clamps to [0, 100]', () => {
    // A pathological delta where "busy" outgrew "total" must not report
    // over 100%.
    const prev = [core({ user: 0, sys: 0, idle: 1000 })]
    const next = [core({ user: 5000, sys: 0, idle: 1000 })]
    expect(cpuPercent(prev, next)).toBe(100)
  })
})

describe('normalizedLoadPercent', () => {
  it('normalises load1 by core count — 1.11 on 18 cores reads as about 6%', () => {
    expect(normalizedLoadPercent(1.11, 18)).toBeCloseTo(6.17, 1)
  })

  it('is null when load1 is null or core count is not positive', () => {
    expect(normalizedLoadPercent(null, 18)).toBeNull()
    expect(normalizedLoadPercent(1.11, 0)).toBeNull()
  })
})

describe('parsePressureLevel', () => {
  it('parses the measured healthy value (1) as normal', () => {
    expect(parsePressureLevel(SYSCTL_HEALTHY)).toBe('normal')
  })

  it('maps the documented warn and critical constants', () => {
    expect(parsePressureLevel('kern.memorystatus_vm_pressure_level: 2')).toBe('warn')
    expect(parsePressureLevel('kern.memorystatus_vm_pressure_level: 4')).toBe('critical')
  })

  it('is unknown, never normal, when the line is absent or unparseable', () => {
    expect(parsePressureLevel('')).toBe('unknown')
    expect(parsePressureLevel('kern.memorystatus_vm_pressure_level: banana')).toBe('unknown')
  })
})

describe('parseSwapUsedMb', () => {
  it('parses the measured healthy baseline of exactly zero', () => {
    expect(parseSwapUsedMb(SYSCTL_HEALTHY)).toBe(0)
  })

  it('converts K and G to megabytes', () => {
    expect(parseSwapUsedMb('vm.swapusage: total = 2048.00M  used = 512.00K  free = 1.00M')).toBeCloseTo(0.5, 5)
    expect(parseSwapUsedMb('vm.swapusage: total = 2048.00M  used = 1.50G  free = 1.00M')).toBeCloseTo(1536, 5)
  })

  it('is null, never a fabricated 0, when unparseable', () => {
    expect(parseSwapUsedMb('vm.swapusage: garbage')).toBeNull()
  })
})

describe('parsePageouts', () => {
  it('parses the measured Pageouts count', () => {
    expect(parsePageouts(MEMORY_PRESSURE_OUTPUT)).toBe(145393)
  })

  it('is null when absent', () => {
    expect(parsePageouts('nothing useful here')).toBeNull()
  })
})

describe('parseBattery', () => {
  it('reads the measured AC-attached, optimised-charging state as ac-not-charging', () => {
    const b = parseBattery(PMSET_AC_HOLDING)
    expect(b.state).toBe('ac-not-charging')
    expect(b.percent).toBe(80)
    expect(b.minutesRemaining).toBeNull()
  })

  it('reads a discharging state with a time estimate', () => {
    const b = parseBattery(PMSET_DISCHARGING)
    expect(b.state).toBe('discharging')
    expect(b.percent).toBe(45)
    expect(b.minutesRemaining).toBe(2 * 60 + 59)
  })

  it('degrades to state "none" for a desktop Mac, never a fabricated 0%', () => {
    const b = parseBattery(PMSET_NO_BATTERY)
    expect(b.state).toBe('none')
    expect(b.percent).toBeNull()
  })
})

describe('parseDf', () => {
  it('reads the Data volume, never treating / as the real usage', () => {
    const d = parseDf(DF_OUTPUT)
    expect(d).not.toBeNull()
    expect(d!.usedPercent).toBe(14)
    expect(d!.freeText).toBe('838G')
    expect(d!.totalText).toBe('995G')
  })

  it('returns null for a header with no data row', () => {
    expect(parseDf('Filesystem Size Used Avail Capacity Mounted on')).toBeNull()
  })
})

describe('parseNetstatInterface', () => {
  it('reads en0 from its Link# row only, ignoring the duplicate inet6 row', () => {
    const found = parseNetstatInterface(NETSTAT_OUTPUT, PRIMARY_INTERFACE)
    expect(found).toEqual({ ibytes: 25077128113, obytes: 17459250667 })
  })

  it('reads lo0, whose Link# row has no MAC address and is one field shorter', () => {
    const found = parseNetstatInterface(NETSTAT_OUTPUT, 'lo0')
    expect(found).toEqual({ ibytes: 168209585, obytes: 168209585 })
  })

  it('is null for an interface not present', () => {
    expect(parseNetstatInterface(NETSTAT_OUTPUT, 'en9')).toBeNull()
  })

  it('selects the Link# row specifically, never a same-name row that happens to come first', () => {
    // On the REAL machine (see NETSTAT_OUTPUT above) the duplicate rows
    // happen to carry IDENTICAL counters, so a broken implementation that
    // matched on interface name alone — ignoring the Network column — would
    // still pass against that fixture by accident. This adversarial fixture
    // gives the non-Link duplicate a DELIBERATELY DIFFERENT byte count and
    // places it BEFORE the real Link# row, so only a genuine column check
    // returns the right numbers.
    const adversarial = [
      'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll',
      'en0  1500 fe80    fe80:f::1033:564a 1 - 999 1 - 999 -',
      'en0  1500 <Link#15> fc:b2:14:ba:91:ce 27958782 0 25077128113 21363919 0 17459250667 0',
    ].join('\n')
    expect(parseNetstatInterface(adversarial, 'en0')).toEqual({ ibytes: 25077128113, obytes: 17459250667 })
  })
})

describe('parsePsList', () => {
  it('parses pcpu output, taking the basename of the full comm path', () => {
    const list = parsePsList(PS_CPU_OUTPUT)
    expect(list).toHaveLength(4)
    expect(list[0]).toEqual({ name: 'WindowServer', pct: 31.8, rssKb: 393616 })
    expect(list[1]!.name).toBe('wdavdaemon_unprivileged')
    expect(list[2]!.name).toBe('Microsoft Edge Helper (Renderer)')
    expect(list[3]).toEqual({ name: 'claude', pct: 10.3, rssKb: 879488 })
  })

  it('never includes the header row', () => {
    const list = parsePsList(PS_CPU_OUTPUT)
    expect(list.some((p) => p.name === 'COMM')).toBe(false)
  })

  it('parses pmem output the same way', () => {
    const list = parsePsList(PS_MEM_OUTPUT)
    expect(list).toHaveLength(2)
    expect(list[0]!.name).toBe('Microsoft Teams WebView Helper (Renderer)')
    expect(list[0]!.pct).toBe(2.2)
  })

  it('returns an empty list for unparseable output, never throwing', () => {
    expect(parsePsList('garbage\n\n')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// SystemSource
// ---------------------------------------------------------------------------

function makeOsReader(cpuSeq: { times: CpuTimes }[][], load1 = 1.11, coreCount = 18, uptime = 12345) {
  let i = 0
  return {
    cpus: vi.fn(() => {
      const sample = cpuSeq[Math.min(i, cpuSeq.length - 1)]!
      i++
      return sample.length ? sample : Array.from({ length: coreCount }, () => core({}))
    }),
    loadavg: vi.fn(() => [load1, load1, load1]),
    uptime: vi.fn(() => uptime),
  }
}

describe('SystemSource', () => {
  afterEach(() => vi.useRealTimers())

  it('reports status empty until the first OS-tier poll, then ok', async () => {
    const source = new SystemSource(neverRun, () => NOW, makeOsReader([[core({})]]), createLogger(() => {}))
    expect(source.getStatus()).toBe('empty')
    source.setVisible(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(source.getStatus()).toBe('ok')
    await source.stop()
  })

  it('renders CPU percent as null (never 0) on the very first sample, then a real delta on the second', async () => {
    vi.useFakeTimers()
    const cpuA = [core({ user: 1000, idle: 9000 })]
    const cpuB = [core({ user: 1500, idle: 9500 })]
    const osReader = makeOsReader([cpuA, cpuB])
    const source = new SystemSource(neverRun, () => NOW, osReader, createLogger(() => {}))

    source.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getCpu().percent).toBeNull()
    expect(source.getCpu().spark).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    expect(source.getCpu().percent).toBeCloseTo(50, 5)
    expect(source.getCpu().spark).toEqual([50])

    await source.stop()
  })

  it('polls each tier at its own rate while visible, and not at all while hidden', async () => {
    vi.useFakeTimers()
    const runner = vi.fn(async (file: string) => {
      if (file === '/usr/sbin/sysctl') return { stdout: SYSCTL_HEALTHY, stderr: '' }
      if (file === '/usr/bin/pmset') return { stdout: PMSET_AC_HOLDING, stderr: '' }
      if (file === '/usr/sbin/netstat') return { stdout: NETSTAT_OUTPUT, stderr: '' }
      if (file === '/usr/bin/memory_pressure') return { stdout: MEMORY_PRESSURE_OUTPUT, stderr: '' }
      if (file === '/bin/ps') return { stdout: PS_CPU_OUTPUT, stderr: '' }
      if (file === '/bin/df') return { stdout: DF_OUTPUT, stderr: '' }
      throw new Error(`unexpected command: ${file}`)
    })
    const osReader = makeOsReader([[core({ user: 1000, idle: 9000 })]])
    const source = new SystemSource(runner, () => NOW, osReader, createLogger(() => {}))

    source.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    // One immediate round: sysctl + pmset + netstat + memory_pressure (shell
    // tier) + 2 ps calls (ps tier) + df (disk tier) = 7.
    expect(runner).toHaveBeenCalledTimes(7)
    const osCallsAfterFirstRound = osReader.cpus.mock.calls.length

    await vi.advanceTimersByTimeAsync(2_000)
    // Only the OS tier should have ticked again — no new shell-outs.
    expect(runner).toHaveBeenCalledTimes(7)
    expect(osReader.cpus.mock.calls.length).toBeGreaterThan(osCallsAfterFirstRound)

    await vi.advanceTimersByTimeAsync(5_000) // total 7s: the shell tier fires
    expect(runner).toHaveBeenCalledTimes(11) // +4 shell-tier commands

    source.setVisible(false)
    const callsWhileHidden = runner.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runner).toHaveBeenCalledTimes(callsWhileHidden)

    await source.stop()
  })

  it('never restarts polling after stop(), even if setVisible(true) is called again', async () => {
    vi.useFakeTimers()
    const osReader = makeOsReader([[core({ user: 1000, idle: 9000 })]])
    const source = new SystemSource(neverRun, () => NOW, osReader, createLogger(() => {}))

    source.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    await source.stop()
    const callsAtStop = osReader.cpus.mock.calls.length

    source.setVisible(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(osReader.cpus.mock.calls.length).toBe(callsAtStop)
  })

  it('does not arm another poll when stop() runs during an in-flight shell probe', async () => {
    vi.useFakeTimers()
    let release: ((v: { stdout: string; stderr: string }) => void) | undefined
    const runner = vi.fn(() => new Promise<{ stdout: string; stderr: string }>((resolve) => { release = resolve }))
    const osReader = makeOsReader([[core({})]])
    const source = new SystemSource(runner, () => NOW, osReader, createLogger(() => {}))

    source.setVisible(true)
    await Promise.resolve()
    await source.stop()
    release?.({ stdout: SYSCTL_HEALTHY, stderr: '' })
    await Promise.resolve()
    await Promise.resolve()
    const callsAtStop = runner.mock.calls.length

    await vi.advanceTimersByTimeAsync(60_000)
    expect(runner.mock.calls.length).toBe(callsAtStop)
  })

  it('emits change only when the whole snapshot actually differs', async () => {
    vi.useFakeTimers()
    const runner = vi.fn(async () => ({ stdout: SYSCTL_HEALTHY, stderr: '' }))
    // A flat CPU sample sequence (no ticks moving) so os-tier polls never
    // change anything on their own — isolates the shell tier's own
    // change-detection.
    const osReader = makeOsReader([[core({ user: 1000, idle: 9000 })]])
    const source = new SystemSource(runner, () => NOW, osReader, createLogger(() => {}))
    let changes = 0
    source.on('change', () => changes++)

    source.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    const afterFirstRound = changes
    expect(afterFirstRound).toBeGreaterThan(0)

    // Advance one more full round of every tier with IDENTICAL fixtures.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(changes).toBe(afterFirstRound)

    await source.stop()
  })

  it('logs a probe failure once, clears it on recovery, and logs again on a later failure', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    let dfShouldFail = true
    const runner = vi.fn(async (file: string) => {
      if (file === '/bin/df') {
        if (dfShouldFail) throw new Error('df unavailable')
        return { stdout: DF_OUTPUT, stderr: '' }
      }
      return { stdout: SYSCTL_HEALTHY, stderr: '' }
    })
    const osReader = makeOsReader([[core({})]])
    const source = new SystemSource(runner, () => NOW, osReader, createLogger((l) => lines.push(l)))

    source.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(lines.filter((l) => l.includes('df probe failed'))).toHaveLength(1)

    // A second disk tick while still failing must not log a second line.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lines.filter((l) => l.includes('df probe failed'))).toHaveLength(1)

    dfShouldFail = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(source.getDisk().usedPercent).toBe(14)

    dfShouldFail = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lines.filter((l) => l.includes('df probe failed'))).toHaveLength(2)

    await source.stop()
  })

  it('copies deeply enough that mutating a getter result cannot corrupt the source', async () => {
    vi.useFakeTimers()
    const runner = vi.fn(async (file: string) => {
      if (file === '/bin/ps') return { stdout: PS_CPU_OUTPUT, stderr: '' }
      return { stdout: SYSCTL_HEALTHY, stderr: '' }
    })
    const osReader = makeOsReader([
      [core({ user: 1000, idle: 9000 })],
      [core({ user: 1500, idle: 9500 })],
    ])
    const source = new SystemSource(runner, () => NOW, osReader, createLogger(() => {}))

    source.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_000)

    const cpu = source.getCpu()
    cpu.spark.push(999)
    expect(source.getCpu().spark).not.toContain(999)

    const top = source.getTopCpu()
    top[0]!.name = 'corrupted'
    expect(source.getTopCpu()[0]!.name).not.toBe('corrupted')

    await source.stop()
  })

  it('reads the DATA volume, never the sealed system volume /', async () => {
    vi.useFakeTimers()
    const runner = vi.fn<Runner>(async () => ({ stdout: DF_OUTPUT, stderr: '' }))
    const osReader = makeOsReader([[core({})]])
    const source = new SystemSource(runner, () => NOW, osReader, createLogger(() => {}))

    source.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)

    const dfCall = runner.mock.calls.find((c) => c[0] === '/bin/df')
    expect(dfCall).toBeDefined()
    expect(dfCall![1]).toEqual(['-H', '/System/Volumes/Data'])

    await source.stop()
  })

  it('computes a network rate only from the SECOND sample, never fabricating one from the first', async () => {
    vi.useFakeTimers()
    let call = 0
    const netstatSamples = [
      NETSTAT_OUTPUT,
      NETSTAT_OUTPUT.replace('25077128113', '25077129113').replace('17459250667', '17459251667'),
    ]
    const runner = vi.fn(async (file: string) => {
      if (file === '/usr/sbin/netstat') {
        const out = netstatSamples[Math.min(call, netstatSamples.length - 1)]!
        return { stdout: out, stderr: '' }
      }
      return { stdout: SYSCTL_HEALTHY, stderr: '' }
    })
    let nowValue = NOW
    const osReader = makeOsReader([[core({})]])
    const source = new SystemSource(runner, () => nowValue, osReader, createLogger(() => {}))

    source.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getNet().downBytesPerSec).toBeNull()
    expect(source.getNet().upBytesPerSec).toBeNull()

    call = 1
    nowValue = NOW + 7
    await vi.advanceTimersByTimeAsync(7_000)
    expect(source.getNet().downBytesPerSec).toBeCloseTo(1000 / 7, 2)
    expect(source.getNet().upBytesPerSec).toBeCloseTo(1000 / 7, 2)

    await source.stop()
  })
})
