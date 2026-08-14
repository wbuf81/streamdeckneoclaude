import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import { cpus as realCpus, loadavg as realLoadavg, uptime as realUptime } from 'node:os'
import { log, type Logger } from '../log.js'

const run = promisify(execFile)

/** The shape of `run`. A test injects a fake to avoid shelling out — see
 * `focus-window.ts` and `lock-state.ts` for the same seam. */
export type Runner = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>

/** The four fields `os.cpus()` reports per core that this file actually
 * uses. A narrower shape than `os.CpuInfo` so a test can build a fixture
 * without also inventing `model` and `speed`. */
export interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

/** The three `os` functions this source needs, injected so a test can
 * script deterministic CPU deltas, load, and uptime instead of reading the
 * real machine. */
export interface OsReader {
  cpus(): { times: CpuTimes }[]
  loadavg(): number[]
  uptime(): number
}

const realOsReader: OsReader = {
  cpus: () => realCpus(),
  loadavg: () => realLoadavg(),
  uptime: () => realUptime(),
}

// Absolute paths, matching the convention `lock-state.ts` and
// `focus-window.ts` already use for every command this project shells out
// to — never resolved through `$PATH` at run time.
const DF = '/bin/df'
const PMSET = '/usr/bin/pmset'
const NETSTAT = '/usr/sbin/netstat'
const SYSCTL = '/usr/sbin/sysctl'
const PS = '/bin/ps'

/**
 * The data volume, never the sealed system volume. Measured on this Mac
 * (docs/VERIFIED-FACTS.md): `df -H /` reports 2% used on a 995 GB drive
 * because `/` is the READ-ONLY system snapshot; the real usage lives on
 * `/System/Volumes/Data`, measured at 133G used, 838G free, 14% used. `df /`
 * must never be used for this page.
 */
const DATA_VOLUME = '/System/Volumes/Data'

/**
 * The interface this page reports on. Measured on this Mac
 * (docs/VERIFIED-FACTS.md): `en0` carries the real traffic, and `netstat -ib`
 * lists it on more than one row (a `<Link#>` row and an `fe80:` inet6 row)
 * with identical cumulative counters — this is a fixed constant, the same
 * way `ZIP` and `SYMBOLS` are fixed elsewhere in this project, rather than a
 * guess at "the primary interface" on a machine that was never measured.
 */
export const PRIMARY_INTERFACE = 'en0'

/**
 * Poll tiers, per the task brief's "the page measures itself": spawning a
 * shell command every second would make this page a meaningful CPU consumer
 * reporting its own consumption (`ps` already shows the daemon in its own
 * top-process list).
 *
 * - `OS_TICK_MS` costs nothing (no shelling out — `os.cpus()`, `os.loadavg()`
 *   and `os.uptime()` are synchronous in-process reads) so it runs often
 *   enough that the CPU sparkline and the load tile feel live.
 * - `SHELL_TICK_MS` covers the three lightweight one-shot commands (a single
 *   combined `sysctl` for swap and memory pressure, `pmset` for battery,
 *   `netstat` for network) — three process spawns per tick, at the low end
 *   of the brief's suggested 5-10 s band, because none of these values
 *   change fast enough to need OS-tier freshness.
 * - `PS_TICK_MS` is its own, slightly slower tier: `ps -Ao ... -r`/`-m` each
 *   enumerate the WHOLE process table (~1000 lines measured on this
 *   machine), the heaviest of the shelled reads, so it gets the long end of
 *   the same band instead of sharing the faster tier.
 * - `DISK_TICK_MS` is a full minute, per the brief's own reasoning: free
 *   space barely moves between polls, so there is no reason to spawn `df`
 *   any more often than that.
 *
 * All four tiers are gated by `visible` (see `setVisible`) — none of them
 * runs at all while the system page is not the one on screen.
 */
const OS_TICK_MS = 2_000
const SHELL_TICK_MS = 7_000
const PS_TICK_MS = 10_000
const DISK_TICK_MS = 60_000

/** How many CPU-percent samples the sparkline keeps. At `OS_TICK_MS` (2 s)
 * this is one minute of history — enough to show a trend on a 96 px key
 * without the source growing an unbounded array. */
const CPU_HISTORY_MAX = 30

/** How many processes each drill-down shows, per the task brief. */
const TOP_N = 5

export type PressureLevel = 'normal' | 'warn' | 'critical' | 'unknown'
export type BatteryState = 'ac-charging' | 'ac-not-charging' | 'discharging' | 'none' | 'unknown'
export type SystemStatus = 'ok' | 'empty'

export interface CpuInfo {
  /** Percent busy, 0 to 100. Null until the SECOND `os.cpus()` sample
   * arrives — a single snapshot cannot produce a delta, and lesson 18 in
   * docs/LESSONS.md forbids fabricating a `0%` for the first one. */
  percent: number | null
  /** Recent percent samples, oldest first, null values never included. Kept
   * here in the SOURCE, not the page, per the task brief — pages stay pure. */
  spark: number[]
}

export interface MemInfo {
  pressure: PressureLevel
  /** Megabytes of swap actually in use. Measured on this Mac
   * (docs/VERIFIED-FACTS.md): `sysctl -n vm.swapusage` read `0.00M used` at
   * rest, so a healthy baseline is genuinely zero, not a sign the probe
   * failed — only a failed or unparseable read is null. */
  swapUsedMb: number | null
  /** Cumulative pageouts since boot, from `memory_pressure`'s own count.
   * Null when the probe has not succeeded yet. */
  pageouts: number | null
}

export interface DiskInfo {
  /** 0 to 100. Read directly from `df`'s own `Capacity` column — this file
   * never derives it from raw byte math, so there is no unit to get wrong. */
  usedPercent: number | null
  /** `df`'s own human-readable free size, e.g. `838G`. Kept as `df` printed
   * it rather than converted, per docs/LESSONS.md #17: reasoning about a
   * derived unit is how this project has introduced bugs before. */
  freeText: string | null
  totalText: string | null
}

export interface NetInfo {
  /** Bytes per second since the last successful sample. Null on the first
   * sample (no prior byte count to diff against — the same "first sample is
   * unknown, never zero" rule the CPU percent follows) and whenever the
   * counters cannot be trusted (a reset, or the probe failed). */
  downBytesPerSec: number | null
  upBytesPerSec: number | null
}

export interface BatteryInfo {
  percent: number | null
  state: BatteryState
  /** Only set while discharging with a real estimate. Null on AC (the
   * number would be meaningless) and null when macOS reports no estimate
   * yet. */
  minutesRemaining: number | null
}

export interface LoadInfo {
  /** The 1-minute load average, unmodified. Null if `os.loadavg()` ever
   * returns something this file cannot read (never observed, but a source
   * must not assume any platform call can't surprise it). */
  load1: number | null
  coreCount: number
  /** `load1` normalised by `coreCount` as a percent. Measured on this Mac
   * (docs/VERIFIED-FACTS.md): a load of 1.11 on 18 cores is meaningless on
   * its own but reads clearly as "about 6% busy" once normalised — the raw
   * average is not shown anywhere on this page. */
  normalizedPercent: number | null
}

export interface ProcessSample {
  /** The basename of `ps`'s `comm` column. Measured on this Mac
   * (docs/VERIFIED-FACTS.md): `comm` is a full executable path, one real
   * line ran to about 250 characters, so this file always takes the
   * basename — never the raw path. */
  name: string
  /** `%CPU` or `%MEM`, depending on which list this came from. */
  pct: number
  /** Resident set size, in KILOBYTES — `ps`'s own unit, unconverted here so
   * there is one place (the page) that turns it into a human string. */
  rssKb: number
}

/** Maps macOS's own `kern.memorystatus_vm_pressure_level` sysctl to a
 * label. The values are Apple's published `vm_pressure_level_t` constants
 * (`kVMPressureNormal = 1`, `kVMPressureWarning = 2`, `kVMPressureCritical =
 * 4`) — this Mac was only ever observed reporting `1` while measuring for
 * this page (docs/VERIFIED-FACTS.md), so the `1` case is directly measured
 * and the `2`/`4` cases rest on Apple's own constant, not an independent
 * reproduction here. Any other value, or a probe failure, is `'unknown'` —
 * never assumed `'normal'`, per lesson 18.
 */
function pressureFromLevel(n: number): PressureLevel {
  if (n === 1) return 'normal'
  if (n === 2) return 'warn'
  if (n >= 4) return 'critical'
  return 'unknown'
}

/** Parses `kern.memorystatus_vm_pressure_level: N` out of the combined
 * `sysctl` output `refreshShell` requests (see `SYSCTL_KEYS`). Absent or
 * unparseable is `'unknown'`, never a guessed `'normal'`. */
export function parsePressureLevel(output: string): PressureLevel {
  const m = /kern\.memorystatus_vm_pressure_level:\s*(\d+)/.exec(output)
  const raw = m?.[1]
  if (raw === undefined) return 'unknown'
  const n = Number(raw)
  return Number.isFinite(n) ? pressureFromLevel(n) : 'unknown'
}

/** Parses `used = 0.00M` (or `K`/`G`/`T`) out of the same combined `sysctl`
 * output, converting to megabytes. Null when the line is missing or the
 * number does not parse — never a fabricated `0`, even though `0` is the
 * healthy baseline this Mac actually measured. */
export function parseSwapUsedMb(output: string): number | null {
  const m = /used\s*=\s*([\d.]+)\s*([KMGT])/i.exec(output)
  const valueText = m?.[1]
  if (valueText === undefined) return null
  const value = Number(valueText)
  if (!Number.isFinite(value)) return null
  const unit = (m?.[2] ?? 'M').toUpperCase()
  const scale = unit === 'K' ? 1 / 1024 : unit === 'G' ? 1024 : unit === 'T' ? 1024 * 1024 : 1
  return value * scale
}

/** Parses the `Pageouts:` line `memory_pressure` prints under `File I/O:`.
 * Null when absent or unparseable. */
export function parsePageouts(output: string): number | null {
  const m = /Pageouts:\s*(\d+)/.exec(output)
  const raw = m?.[1]
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Parses `pmset -g batt`. Measured on this Mac (docs/VERIFIED-FACTS.md):
 * `Now drawing from 'AC Power'` / `80%; AC attached; not charging present:
 * true` — that `not charging` state is macOS's optimised charging, a
 * NORMAL resting state, not a fault, so it maps to `'ac-not-charging'`
 * rather than anything alert-worthy. A desktop Mac with no
 * `InternalBattery` line degrades to `state: 'none'`, never a fabricated
 * `0%`.
 */
export function parseBattery(output: string): BatteryInfo {
  if (!/InternalBattery/.test(output)) {
    return { percent: null, state: 'none', minutesRemaining: null }
  }

  const pctMatch = /(\d+)%/.exec(output)
  const percentText = pctMatch?.[1]
  const percent = percentText !== undefined ? Number(percentText) : null

  let state: BatteryState = 'unknown'
  if (/discharging/i.test(output)) state = 'discharging'
  else if (/not charging/i.test(output)) state = 'ac-not-charging'
  else if (/\bcharging\b/i.test(output)) state = 'ac-charging'
  else if (/\bcharged\b/i.test(output)) state = 'ac-not-charging'

  const timeMatch = /(\d+):(\d+)\s+remaining/.exec(output)
  const hoursText = timeMatch?.[1]
  const minsText = timeMatch?.[2]
  const minutesRemaining =
    state === 'discharging' && hoursText !== undefined && minsText !== undefined
      ? Number(hoursText) * 60 + Number(minsText)
      : null

  return { percent, state, minutesRemaining }
}

/**
 * Parses `df -H <DATA_VOLUME>`'s second line. Returns null when the output
 * has no usable data row — the caller then leaves the disk fields at their
 * previous (or null) values rather than drawing a zero.
 */
export function parseDf(output: string): DiskInfo | null {
  const lines = output.trim().split('\n')
  const dataLine = lines[1]
  if (dataLine === undefined) return null
  const parts = dataLine.trim().split(/\s+/)
  const totalText = parts[1]
  const availText = parts[3]
  const capacityText = parts[4]
  if (totalText === undefined || availText === undefined || capacityText === undefined) return null
  const capacityMatch = /^(\d+)%$/.exec(capacityText)
  const usedPercent = capacityMatch?.[1] !== undefined ? Number(capacityMatch[1]) : null
  return { usedPercent, freeText: availText, totalText }
}

/**
 * Finds `iface`'s cumulative `Ibytes`/`Obytes` in `netstat -ib` output.
 * Measured on this Mac (docs/VERIFIED-FACTS.md): the same interface appears
 * on MULTIPLE rows (a `<Link#N>` row and an `fe80:` inet6 row) with
 * IDENTICAL counters, so this only ever reads the `<Link#` row — checked by
 * column position (`Network`, the third field), never by row order, because
 * the inet6 row for the SAME interface can appear either before or after it.
 * The two counters are always the third and sixth field counting from the
 * END of the line (`Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll`), which
 * holds regardless of whether the `Address` column is present — measured:
 * `lo0`'s `<Link#>` row has no MAC address and is one field shorter than
 * `en0`'s.
 */
export function parseNetstatInterface(
  output: string,
  iface: string,
): { ibytes: number; obytes: number } | null {
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 7) continue
    if (fields[0] !== iface) continue
    if (!fields[2]?.startsWith('<Link')) continue
    const tail = fields.slice(-7)
    const ibytesText = tail[2]
    const obytesText = tail[5]
    if (ibytesText === undefined || obytesText === undefined) continue
    const ibytes = Number(ibytesText)
    const obytes = Number(obytesText)
    if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) continue
    return { ibytes, obytes }
  }
  return null
}

/**
 * Parses one `ps -Ao pcpu,rss,comm -r` or `-m`-sorted listing into samples,
 * oldest-sort-order preserved (the caller relies on `ps -r`/`-m` for
 * ordering, this function does not re-sort). The header line
 * (`" %CPU    RSS COMM"` / `" %MEM    RSS COMM"`) never matches, because
 * its first column is not numeric.
 *
 * Measured on this Mac (docs/VERIFIED-FACTS.md): `comm` is a FULL PATH, so
 * this always takes the basename — never the raw path, which can run to
 * roughly 250 characters and blow the 81 px key budget many times over.
 */
export function parsePsList(output: string): ProcessSample[] {
  const out: ProcessSample[] = []
  for (const line of output.split('\n')) {
    const m = /^\s*([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const pctText = m[1]
    const rssText = m[2]
    const rawName = m[3]
    if (pctText === undefined || rssText === undefined || rawName === undefined || rawName === '') continue
    const pct = Number(pctText)
    const rssKb = Number(rssText)
    if (!Number.isFinite(pct) || !Number.isFinite(rssKb)) continue
    out.push({ name: basename(rawName), pct, rssKb })
  }
  return out
}

/** Busy (`user+nice+sys+irq`) and total ticks, summed across every core. */
function sumCpuTicks(cores: { times: CpuTimes }[]): { busy: number; total: number } {
  let busy = 0
  let total = 0
  for (const c of cores) {
    const t = c.times
    const coreBusy = t.user + t.nice + t.sys + t.irq
    busy += coreBusy
    total += coreBusy + t.idle
  }
  return { busy, total }
}

/**
 * Percent CPU busy between two `os.cpus()` snapshots. `os.cpus()` reports
 * cumulative ticks since boot, so ONE sample cannot produce a percentage —
 * this always needs two, and returns null (never a fabricated `0`, per
 * lesson 18 in docs/LESSONS.md) when the interval between them is zero or
 * negative, which is also what protects the very first sample after the
 * source starts: `SystemSource` never calls this until it has a `prev`.
 */
export function cpuPercent(prev: { times: CpuTimes }[], next: { times: CpuTimes }[]): number | null {
  const a = sumCpuTicks(prev)
  const b = sumCpuTicks(next)
  const totalDelta = b.total - a.total
  if (totalDelta <= 0) return null
  const pct = ((b.busy - a.busy) / totalDelta) * 100
  if (!Number.isFinite(pct)) return null
  return Math.max(0, Math.min(100, pct))
}

/** `load1` normalised by core count, as a percent. Null when either input
 * is unusable — a load average this file cannot trust is not shown as if
 * it were a real, if odd-looking, number. */
export function normalizedLoadPercent(load1: number | null, coreCount: number): number | null {
  if (load1 === null || !Number.isFinite(load1) || coreCount <= 0) return null
  return (load1 / coreCount) * 100
}

type TimerKind = 'os' | 'shell' | 'ps' | 'disk'

/**
 * CPU, memory, disk, network, battery, load, and the top five processes by
 * CPU and by memory. Polls only while the system page is visible
 * (`setVisible`), at four tiers — see the constants above for the rates and
 * the reasoning.
 *
 * Follows the family disciplines the sources review established
 * (docs/LESSONS.md, `AGENTS.md`): an injected command runner and clock, a
 * one-way `stopped` latch (`stop()` can never be undone by a stray
 * `setVisible(true)`), a whole-snapshot change key, `log.once`/`clearOnce`
 * per failing probe, and every absent reading left as `null` rather than a
 * guessed number.
 *
 * On the "cooldown, never a `finally`-cleared guard" discipline
 * (docs/LESSONS.md #10): that lesson's harm was a request fired again on
 * every RENDER (1 Hz) while a failure stayed live. Every probe here instead
 * runs only on its own fixed poll tier, gated by `visible` — there is no
 * user action (unlike selecting a stock or a Codex thread) that can trigger
 * an extra shell-out between ticks, so the tier's own interval already is
 * the cooldown. What `finally` clears here is only the in-flight flag for
 * ONE tier's own recursive reschedule (matching `StockSource`'s
 * `refreshAndSchedule`), never a per-probe retry-deny — a slow or hanging
 * command delays that tier's own next attempt, it does not start a second
 * one concurrently.
 */
export class SystemSource extends EventEmitter {
  private stopped = false
  private visible = false
  private everPolled = false

  private timers: Record<TimerKind, NodeJS.Timeout | null> = { os: null, shell: null, ps: null, disk: null }

  private prevCpuSample: { times: CpuTimes }[] | null = null
  private cpuPercentValue: number | null = null
  private cpuSpark: number[] = []

  private mem: MemInfo = { pressure: 'unknown', swapUsedMb: null, pageouts: null }
  private disk: DiskInfo = { usedPercent: null, freeText: null, totalText: null }
  private net: NetInfo = { downBytesPerSec: null, upBytesPerSec: null }
  private netPrev: { ibytes: number; obytes: number; atSeconds: number } | null = null
  private battery: BatteryInfo = { percent: null, state: 'unknown', minutesRemaining: null }
  private load: LoadInfo = { load1: null, coreCount: 0, normalizedPercent: null }
  private uptimeSeconds: number | null = null
  private topCpu: ProcessSample[] = []
  private topMem: ProcessSample[] = []
  private processCount: number | null = null

  private lastKey = ''

  constructor(
    private readonly runner: Runner = run,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly osReader: OsReader = realOsReader,
    private readonly logger: Logger = log,
  ) {
    super()
  }

  getCpu(): CpuInfo {
    return { percent: this.cpuPercentValue, spark: [...this.cpuSpark] }
  }

  getMem(): MemInfo {
    return { ...this.mem }
  }

  getDisk(): DiskInfo {
    return { ...this.disk }
  }

  getNet(): NetInfo {
    return { ...this.net }
  }

  getBattery(): BatteryInfo {
    return { ...this.battery }
  }

  getLoad(): LoadInfo {
    return { ...this.load }
  }

  getUptimeSeconds(): number | null {
    return this.uptimeSeconds
  }

  getTopCpu(): ProcessSample[] {
    return this.topCpu.map((p) => ({ ...p })).slice(0, TOP_N)
  }

  getTopMem(): ProcessSample[] {
    return this.topMem.map((p) => ({ ...p })).slice(0, TOP_N)
  }

  getProcessCount(): number | null {
    return this.processCount
  }

  /** `'empty'` until the first (shell-free, cannot fail) OS-tier poll has
   * completed — matches the family's `'empty'` status other sources use
   * before their first successful read. */
  getStatus(): SystemStatus {
    return this.everPolled ? 'ok' : 'empty'
  }

  /** Called when the system page becomes visible or stops being visible.
   * Per lesson 8/the `LockState`/`StockSource` precedent, a source already
   * `stop()`ped stays stopped — this never clears `stopped`, so a stray
   * `setVisible(true)` after shutdown cannot restart polling. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (this.stopped) return
    if (!visible) {
      for (const kind of ['os', 'shell', 'ps', 'disk'] as const) {
        const t = this.timers[kind]
        if (t) clearTimeout(t)
        this.timers[kind] = null
      }
      return
    }
    this.kick('os', OS_TICK_MS, () => this.refreshOs())
    this.kick('shell', SHELL_TICK_MS, () => this.refreshShell())
    this.kick('ps', PS_TICK_MS, () => this.refreshPs())
    this.kick('disk', DISK_TICK_MS, () => this.refreshDisk())
  }

  /** Runs one tier's refresh at once, then arms its next tick regardless of
   * outcome. Mirrors `StockSource.refreshAndSchedule`: an uncaught rejection
   * here must not silently stop this tier from ever polling again. */
  private kick(kind: TimerKind, delay: number, fn: () => Promise<void>): void {
    void fn()
      .catch((e) => {
        this.logger.once(`system-${kind}-unexpected`, `system ${kind} refresh failed unexpectedly: ${String(e)}`)
      })
      .finally(() => this.scheduleNext(kind, delay, fn))
  }

  private scheduleNext(kind: TimerKind, delay: number, fn: () => Promise<void>): void {
    // A refresh started before `stop()` can still be in flight when it
    // settles. Its continuation must not arm a new timer after shutdown, so
    // this check runs first, exactly like `StockSource.schedule`.
    if (this.stopped) return
    const existing = this.timers[kind]
    if (existing) clearTimeout(existing)
    if (!this.visible) return
    this.timers[kind] = setTimeout(() => {
      this.timers[kind] = null
      this.kick(kind, delay, fn)
    }, delay)
  }

  private async refreshOs(): Promise<void> {
    const sample = this.osReader.cpus()
    this.cpuPercentValue = this.prevCpuSample ? cpuPercent(this.prevCpuSample, sample) : null
    this.prevCpuSample = sample
    if (this.cpuPercentValue !== null) {
      this.cpuSpark.push(this.cpuPercentValue)
      if (this.cpuSpark.length > CPU_HISTORY_MAX) this.cpuSpark.shift()
    }

    const coreCount = sample.length
    const load1 = this.osReader.loadavg()[0] ?? null
    this.load = {
      load1,
      coreCount,
      normalizedPercent: normalizedLoadPercent(load1, coreCount),
    }
    this.uptimeSeconds = this.osReader.uptime()
    this.everPolled = true

    this.commitSnapshot()
  }

  private async refreshShell(): Promise<void> {
    const [sysctlResult, battResult, netResult] = await Promise.allSettled([
      this.runner(SYSCTL, ['vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
      this.runner(PMSET, ['-g', 'batt']),
      this.runner(NETSTAT, ['-ib']),
    ])

    if (sysctlResult.status === 'fulfilled') {
      this.logger.clearOnce('system-sysctl')
      const out = sysctlResult.value.stdout
      this.mem = { ...this.mem, pressure: parsePressureLevel(out), swapUsedMb: parseSwapUsedMb(out) }
    } else {
      this.logger.once('system-sysctl', `system sysctl probe failed: ${String(sysctlResult.reason)}`)
    }

    // `memory_pressure`'s own Pageouts count is a separate command — see
    // `refreshPageouts` — folded into this tier rather than its own, since
    // it changes no faster than the rest of this group.
    await this.refreshPageouts()

    if (battResult.status === 'fulfilled') {
      this.logger.clearOnce('system-pmset')
      this.battery = parseBattery(battResult.value.stdout)
    } else {
      this.logger.once('system-pmset', `system battery probe failed: ${String(battResult.reason)}`)
    }

    if (netResult.status === 'fulfilled') {
      this.logger.clearOnce('system-netstat')
      const found = parseNetstatInterface(netResult.value.stdout, PRIMARY_INTERFACE)
      const atSeconds = this.now()
      if (found) {
        const prev = this.netPrev
        if (prev && atSeconds > prev.atSeconds && found.ibytes >= prev.ibytes && found.obytes >= prev.obytes) {
          const elapsed = atSeconds - prev.atSeconds
          this.net = {
            downBytesPerSec: (found.ibytes - prev.ibytes) / elapsed,
            upBytesPerSec: (found.obytes - prev.obytes) / elapsed,
          }
        } else {
          // First sample, a clock that did not advance, or counters that
          // went backwards (an interface reset) — no trustworthy delta yet.
          this.net = { downBytesPerSec: null, upBytesPerSec: null }
        }
        this.netPrev = { ibytes: found.ibytes, obytes: found.obytes, atSeconds }
      } else {
        this.net = { downBytesPerSec: null, upBytesPerSec: null }
      }
    } else {
      this.logger.once('system-netstat', `system network probe failed: ${String(netResult.reason)}`)
    }

    this.commitSnapshot()
  }

  private async refreshPageouts(): Promise<void> {
    try {
      const { stdout } = await this.runner('/usr/bin/memory_pressure', [])
      this.logger.clearOnce('system-memory-pressure')
      this.mem = { ...this.mem, pageouts: parsePageouts(stdout) }
    } catch (e) {
      this.logger.once('system-memory-pressure', `system memory_pressure probe failed: ${String(e)}`)
    }
  }

  private async refreshPs(): Promise<void> {
    const [cpuResult, memResult] = await Promise.allSettled([
      this.runner(PS, ['-Ao', 'pcpu,rss,comm', '-r']),
      this.runner(PS, ['-Ao', 'pmem,rss,comm', '-m']),
    ])

    if (cpuResult.status === 'fulfilled') {
      this.logger.clearOnce('system-ps-cpu')
      const all = parsePsList(cpuResult.value.stdout)
      this.topCpu = all.slice(0, TOP_N)
      this.processCount = all.length
    } else {
      this.logger.once('system-ps-cpu', `system top-CPU probe failed: ${String(cpuResult.reason)}`)
    }

    if (memResult.status === 'fulfilled') {
      this.logger.clearOnce('system-ps-mem')
      this.topMem = parsePsList(memResult.value.stdout).slice(0, TOP_N)
    } else {
      this.logger.once('system-ps-mem', `system top-memory probe failed: ${String(memResult.reason)}`)
    }

    this.commitSnapshot()
  }

  private async refreshDisk(): Promise<void> {
    try {
      const { stdout } = await this.runner(DF, ['-H', DATA_VOLUME])
      const parsed = parseDf(stdout)
      if (parsed) {
        this.logger.clearOnce('system-df')
        this.disk = parsed
      } else {
        this.logger.once('system-df', 'system df probe returned no usable data row.')
      }
    } catch (e) {
      this.logger.once('system-df', `system df probe failed: ${String(e)}`)
    }
    this.commitSnapshot()
  }

  /** Hashes the WHOLE snapshot and emits `change` only when it actually
   * differs from the last one — lesson 7 in docs/LESSONS.md: a
   * partial-field comparison key can miss a real update in one tier while
   * another tier's poll is what triggers the check. */
  private commitSnapshot(): void {
    const key = JSON.stringify({
      cpu: this.cpuPercentValue,
      spark: this.cpuSpark,
      mem: this.mem,
      disk: this.disk,
      net: this.net,
      battery: this.battery,
      load: this.load,
      uptime: this.uptimeSeconds,
      topCpu: this.topCpu,
      topMem: this.topMem,
      processCount: this.processCount,
      status: this.getStatus(),
    })
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit('change')
  }

  async start(): Promise<void> {
    // Nothing to do until the page becomes visible, matching `StockSource`.
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const kind of ['os', 'shell', 'ps', 'disk'] as const) {
      const t = this.timers[kind]
      if (t) clearTimeout(t)
      this.timers[kind] = null
    }
  }
}

// Temperature and fan speed: NOT AVAILABLE on this Mac without a privileged
// helper. Measured (docs/VERIFIED-FACTS.md): `powermetrics --samplers smc -n
// 1` answers `unrecognized sampler: smc` (that sampler was Intel-only on
// Apple Silicon), and `powermetrics` itself needs sudo regardless of
// sampler. Do not re-attempt either reading here without a privileged
// helper process, which is out of scope for this daemon.
