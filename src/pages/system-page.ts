import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate, formatDuration } from '../render/text.js'
import type { Page, PressOutcome } from './types.js'
import type {
  BatteryInfo,
  CpuInfo,
  DiskInfo,
  LoadInfo,
  MemInfo,
  NetInfo,
  PressureLevel,
  ProcessSample,
  SystemStatus,
} from '../sources/system.js'

/** Measured limit for one strip line. See `render/canvas.ts`. */
const STRIP_CHARS = 30
/** How many processes each drill-down shows, matching `SystemSource`'s own
 * `TOP_N`. Kept as a separate constant here because the page must not import
 * a source's private implementation detail — only its public reader shape. */
const DETAIL_PROCESS_COUNT = 5

/** Fixed size for short, known-vocabulary header words (`MEM`, `DISK`,
 * `LOAD`, and so on) — the same role `DAY_LABEL_SIZE` plays on the weather
 * page. */
const HEADER_SIZE = 12
/** Fixed size for a short, bounded-length data line, matching the stocks
 * page's own `LABEL_SIZE` — used only where every possible value is known to
 * fit (a fixed word like `NORMAL`, or a small count like a core count). */
const DATA_SIZE = 16
/**
 * Candidate sizes, largest first, for any line built from a COMMAND's raw
 * output rather than this project's own fixed vocabulary — a process name, a
 * `df` free-space string, a formatted swap or network value. Per
 * docs/LESSONS.md #17, this page never reasons about whether such a string
 * fits; it declares intent and lets `renderKey` measure with a real canvas,
 * exactly like the weather and stocks pages already do for their own
 * variable-length lines.
 */
const VARIABLE_SIZES = [13, 11]
/** Fixed size for the detail view's BACK label, matching the other two
 * drill-downs. */
const BACK_SIZE = 16

/** Disk under this percent free is an alert, per the task brief. */
export const DISK_LOW_FREE_PERCENT = 10

const PRESSURE_LABELS: Record<PressureLevel, string> = {
  normal: 'NORMAL',
  warn: 'WARN',
  critical: 'CRITICAL',
  unknown: '--',
}

/** `12` becomes `CPU 12%`. Null (the first sample after start has no delta
 * to compute from yet — see `cpuPercent` in `sources/system.ts`) becomes
 * `CPU --`, never a fabricated `CPU 0%`. */
function formatCpuLine(percent: number | null): string {
  return `CPU ${percent !== null ? `${Math.round(percent)}%` : '--'}`
}

/** `0` becomes `swap 0` — the healthy baseline this page must be able to
 * show plainly, per the task brief. `null` (the probe has not succeeded
 * yet) becomes `swap --`, never `swap 0`. */
export function formatSwapLine(mb: number | null): string {
  if (mb === null) return 'swap --'
  if (mb === 0) return 'swap 0'
  if (mb >= 1024) return `swap ${(mb / 1024).toFixed(1)}G`
  return `swap ${Math.round(mb)}M`
}

/** `true` when swap is genuinely in use — the "why is my Mac slow" signal
 * the task brief names, measured as `0.00M` (healthy) on this machine. */
export function swapInUse(mem: MemInfo): boolean {
  return mem.swapUsedMb !== null && mem.swapUsedMb > 0
}

/** `100 - usedPercent`, or null when disk usage was never read. Kept as a
 * small pure function so `diskLowOnSpace` and the strip's alert text share
 * one calculation. */
export function diskFreePercent(disk: DiskInfo): number | null {
  return disk.usedPercent !== null ? 100 - disk.usedPercent : null
}

/** `true` when free space is under the brief's 10% threshold. `false` — not
 * an alert — when disk usage was never read, since there is nothing
 * measured to grade. */
export function diskLowOnSpace(disk: DiskInfo): boolean {
  const free = diskFreePercent(disk)
  return free !== null && free < DISK_LOW_FREE_PERCENT
}

/** `1234567` (bytes per second) becomes `1.2M/s`. `null` becomes `--`. */
export function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec === null) return '--'
  const abs = Math.abs(bytesPerSec)
  if (abs >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)}M/s`
  if (abs >= 1024) return `${Math.round(bytesPerSec / 1024)}K/s`
  return `${Math.round(bytesPerSec)}B/s`
}

/** `4200000` (KB, `ps`'s own RSS unit) becomes `4.0G`. */
export function formatRssKb(rssKb: number): string {
  if (rssKb >= 1024 * 1024) return `${(rssKb / 1024 / 1024).toFixed(1)}G`
  if (rssKb >= 1024) return `${Math.round(rssKb / 1024)}M`
  return `${Math.round(rssKb)}K`
}

/** `load1` normalised by core count (`LoadInfo.normalizedPercent`), already
 * computed by the source — measured on this Mac (docs/VERIFIED-FACTS.md): a
 * raw `1.11` on 18 cores means nothing to a human, but the normalised `6%`
 * does. `null` becomes `--`. */
function formatLoadPercent(normalizedPercent: number | null): string {
  return normalizedPercent !== null ? `${Math.round(normalizedPercent)}%` : '--'
}

/** The three lines the BATTERY tile shows, and whether that state counts as
 * an alert. Measured on this Mac (docs/VERIFIED-FACTS.md): `AC attached;
 * not charging` is macOS's normal optimised-charging state and must NOT be
 * coloured as a problem — only `discharging` is. A desktop Mac with no
 * `InternalBattery` line degrades to `state: 'none'` and shows `no battery`,
 * never a fabricated `0%`.
 */
export function batteryLines(battery: BatteryInfo): { lines: [string, string, string]; alert: boolean } {
  if (battery.state === 'none') return { lines: ['BATTERY', '--', 'no battery'], alert: false }
  if (battery.state === 'unknown') return { lines: ['BATTERY', '--', '--'], alert: false }

  const pctText = battery.percent !== null ? `${battery.percent}%` : '--'
  if (battery.state === 'ac-charging') return { lines: ['BATTERY', `${pctText} AC`, 'charging'], alert: false }
  if (battery.state === 'ac-not-charging') {
    return { lines: ['BATTERY', `${pctText} AC`, 'holding'], alert: false }
  }
  // 'discharging'
  const remaining =
    battery.minutesRemaining !== null ? formatDuration(battery.minutesRemaining * 60) : 'on battery'
  return { lines: ['BATTERY', pctText, remaining], alert: true }
}

/** The worst active alert, in priority order, or the uptime when nothing is
 * wrong. Shown on the strip in BOTH modes — per the weather and stocks
 * pages' own "M2" finding, a status signal must not disappear just because
 * a drill-down is open. */
function statusLine(disk: DiskInfo, mem: MemInfo, battery: BatteryInfo, uptimeSeconds: number | null): string {
  if (mem.pressure === 'critical') return 'MEMORY PRESSURE: CRITICAL'
  if (diskLowOnSpace(disk)) {
    const free = diskFreePercent(disk)
    return `LOW DISK: ${free !== null ? Math.round(free) : '--'}% free`
  }
  if (mem.pressure === 'warn') return 'MEMORY PRESSURE: WARN'
  if (swapInUse(mem)) return `SWAP IN USE: ${formatSwapLine(mem.swapUsedMb).replace('swap ', '')}`
  if (battery.state === 'discharging') {
    return battery.percent !== null ? `ON BATTERY: ${battery.percent}%` : 'ON BATTERY'
  }
  return uptimeSeconds !== null ? `up ${formatDuration(uptimeSeconds)}` : 'up --'
}

function secondaryLine(load: LoadInfo): string {
  return `${load.coreCount} cores · load ${formatLoadPercent(load.normalizedPercent)}`
}

/** The part of `SystemSource` this page needs. */
export interface SystemReader {
  getCpu(): CpuInfo
  getMem(): MemInfo
  getDisk(): DiskInfo
  getNet(): NetInfo
  getBattery(): BatteryInfo
  getLoad(): LoadInfo
  getUptimeSeconds(): number | null
  getTopCpu(): ProcessSample[]
  getTopMem(): ProcessSample[]
  getProcessCount(): number | null
  getStatus(): SystemStatus
  setVisible(visible: boolean): void
}

type DrillMode = 'cpu' | 'mem'

/**
 * CPU, memory, disk, network, battery, and load, one per key on the grid,
 * plus the single top CPU and top memory consumer — the page's answer to
 * the task brief's bar: naming the culprit (`Chrome Helper`, not just a
 * percentage) is what a press-once glance needs that a generic stats app
 * does not give as directly.
 *
 * Pressing the CPU tile or the MEM tile enters a top-five-processes
 * drill-down for that one metric, spread across all eight keys, with
 * `◀ BACK` on key 7 — the same mode-of-the-page pattern `stocks-page.ts` and
 * `weather-page.ts` already use for their own drill-downs.
 *
 * Pure: reads only through `SystemReader`, never the wall clock, never a
 * canvas, never a shell command. Every tile dims while `getStatus()` is
 * `'empty'` (no poll has completed yet), the same convention the weather
 * page uses for "no forecast yet".
 */
export class SystemPage implements Page {
  readonly name = 'system'

  /** The metric whose drill-down is open, or null on the grid. `onLeave`
   * always clears this, so the page reopens on the grid every time it
   * becomes visible again — matching `WeatherPage.selected` and
   * `StocksPage.selected`. */
  private selected: DrillMode | null = null

  constructor(private readonly source: SystemReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.selected = null
    this.source.setVisible(false)
  }

  render(_now: number): DeckFrame {
    const empty = this.source.getStatus() === 'empty'

    if (this.selected) return this.detailFrame(this.selected, empty)

    const cpu = this.source.getCpu()
    const mem = this.source.getMem()
    const disk = this.source.getDisk()
    const net = this.source.getNet()
    const battery = this.source.getBattery()
    const load = this.source.getLoad()
    const topCpu = this.source.getTopCpu()
    const topMem = this.source.getTopMem()

    const keys: KeySpec[] = [
      this.cpuKey(cpu, empty),
      this.memKey(mem, empty),
      this.diskKey(disk, empty),
      this.netKey(net, empty),
      this.batteryKey(battery, empty),
      this.loadKey(load, empty),
      this.topProcessKey('TOP CPU', topCpu[0], (p) => `${Math.round(p.pct)}%`, empty),
      this.topProcessKey('TOP MEM', topMem[0], (p) => formatRssKb(p.rssKb), empty),
    ]

    return {
      keys,
      strip: this.strip(disk, mem, battery, load),
      buttons: [theme.gray, theme.gray],
    }
  }

  private cpuKey(cpu: CpuInfo, dim: boolean): KeySpec {
    const key: KeySpec = {
      kind: 'gauge',
      lines: [formatCpuLine(cpu.percent)],
      lineSizes: [DATA_SIZE],
    }
    if (cpu.spark.length >= 2) key.spark = { values: cpu.spark, color: theme.cyan }
    if (dim) key.dim = true
    return key
  }

  private memKey(mem: MemInfo, dim: boolean): KeySpec {
    const pressureColor = mem.pressure === 'critical' ? theme.red : mem.pressure === 'warn' ? theme.amber : undefined
    const swapColor = swapInUse(mem) ? theme.amber : undefined
    const key: KeySpec = {
      kind: 'gauge',
      lines: ['MEM', PRESSURE_LABELS[mem.pressure], formatSwapLine(mem.swapUsedMb)],
      lineSizes: [HEADER_SIZE, DATA_SIZE, VARIABLE_SIZES],
      lineColors: [undefined, pressureColor, swapColor],
    }
    if (pressureColor === theme.red || swapColor === theme.amber) key.border = pressureColor ?? swapColor
    if (dim) key.dim = true
    return key
  }

  private diskKey(disk: DiskInfo, dim: boolean): KeySpec {
    const low = diskLowOnSpace(disk)
    const key: KeySpec = {
      kind: 'gauge',
      lines: ['DISK', disk.freeText ?? '--', 'free'],
      lineSizes: [HEADER_SIZE, VARIABLE_SIZES, HEADER_SIZE],
      lineColors: [undefined, low ? theme.red : undefined, undefined],
    }
    if (low) key.border = theme.red
    if (dim) key.dim = true
    return key
  }

  private netKey(net: NetInfo, dim: boolean): KeySpec {
    const key: KeySpec = {
      kind: 'gauge',
      lines: ['NET', `↓${formatRate(net.downBytesPerSec)}`, `↑${formatRate(net.upBytesPerSec)}`],
      lineSizes: [HEADER_SIZE, VARIABLE_SIZES, VARIABLE_SIZES],
    }
    if (dim) key.dim = true
    return key
  }

  private batteryKey(battery: BatteryInfo, dim: boolean): KeySpec {
    const { lines, alert } = batteryLines(battery)
    const key: KeySpec = {
      kind: 'gauge',
      lines,
      lineSizes: [HEADER_SIZE, VARIABLE_SIZES, VARIABLE_SIZES],
      lineColors: [undefined, alert ? theme.amber : undefined, alert ? theme.amber : undefined],
    }
    if (alert) key.border = theme.amber
    if (dim) key.dim = true
    return key
  }

  private loadKey(load: LoadInfo, dim: boolean): KeySpec {
    const key: KeySpec = {
      kind: 'gauge',
      lines: ['LOAD', formatLoadPercent(load.normalizedPercent), `${load.coreCount} cores`],
      lineSizes: [HEADER_SIZE, DATA_SIZE, HEADER_SIZE],
    }
    if (dim) key.dim = true
    return key
  }

  /** Keys 6 and 7 on the grid: the SINGLE top process by CPU or by memory —
   * the task brief's whole differentiator from a generic stats app. `label`
   * is `TOP CPU`/`TOP MEM`; `valueOf` turns that one sample into its own
   * metric's display string. No sample yet (the `ps` tier has not completed
   * its first poll) shows `--`, never a fabricated name or percent. */
  private topProcessKey(
    label: string,
    sample: ProcessSample | undefined,
    valueOf: (p: ProcessSample) => string,
    dim: boolean,
  ): KeySpec {
    const key: KeySpec = {
      kind: 'gauge',
      lines: [label, sample ? sample.name : '--', sample ? valueOf(sample) : '--'],
      lineSizes: [HEADER_SIZE, VARIABLE_SIZES, VARIABLE_SIZES],
    }
    if (dim) key.dim = true
    return key
  }

  /**
   * The drill-down for one metric, spread across all eight keys:
   *
   * - Key 0: the same CPU or MEM tile shown on the grid, so the tile the
   *   user just pressed stays recognisable inside the detail view.
   * - Keys 1 to 5: the top five processes by that metric, ranked.
   * - Key 6: a bonus reading from the SAME probe family — total process
   *   count for the CPU view, cumulative pageouts for the memory view —
   *   rather than an empty tile.
   * - Key 7: BACK.
   */
  private detailFrame(mode: DrillMode, dim: boolean): DeckFrame {
    const cpu = this.source.getCpu()
    const mem = this.source.getMem()
    const disk = this.source.getDisk()
    const battery = this.source.getBattery()
    const list = mode === 'cpu' ? this.source.getTopCpu() : this.source.getTopMem()

    const keys: KeySpec[] = [mode === 'cpu' ? this.cpuKey(cpu, dim) : this.memKey(mem, dim)]
    for (let i = 0; i < DETAIL_PROCESS_COUNT; i++) {
      keys.push(this.processKey(mode, list[i], i, dim))
    }
    keys.push(
      mode === 'cpu'
        ? this.countKey('PROCS', this.source.getProcessCount(), dim)
        : this.countKey('PAGEOUTS', mem.pageouts, dim),
    )
    keys.push(this.backKey())

    return {
      keys,
      strip: this.detailStrip(mode, disk, mem, battery),
      buttons: [theme.gray, theme.gray],
    }
  }

  /** One ranked process tile. A rank with no sample (fewer than five
   * processes ever reported — should not happen on a real Mac, but a page
   * must never assume five exist) shows a dashed placeholder rather than a
   * blank key. */
  private processKey(mode: DrillMode, sample: ProcessSample | undefined, rank: number, dim: boolean): KeySpec {
    const value = sample ? (mode === 'cpu' ? `${Math.round(sample.pct)}%` : formatRssKb(sample.rssKb)) : '--'
    const key: KeySpec = {
      kind: 'gauge',
      lines: [`#${rank + 1}`, sample?.name ?? '--', value],
      lineSizes: [HEADER_SIZE, VARIABLE_SIZES, VARIABLE_SIZES],
    }
    if (dim) key.dim = true
    return key
  }

  private countKey(label: string, value: number | null, dim: boolean): KeySpec {
    const key: KeySpec = {
      kind: 'gauge',
      lines: [label, value !== null ? String(value) : '--'],
      lineSizes: [HEADER_SIZE, VARIABLE_SIZES],
    }
    if (dim) key.dim = true
    return key
  }

  /** Key 7: BACK. A gray border and no fill colour, matching the stocks and
   * weather detail views exactly, so it never reads as one more data
   * tile. */
  private backKey(): KeySpec {
    return {
      kind: 'control',
      lines: ['◀ BACK'],
      lineSizes: [BACK_SIZE],
      lineY: [40],
      align: 'center',
      border: theme.gray,
    }
  }

  private strip(disk: DiskInfo, mem: MemInfo, battery: BatteryInfo, load: LoadInfo): StripSpec {
    const line1 = statusLine(disk, mem, battery, this.source.getUptimeSeconds())
    const line2 = secondaryLine(load)
    return { lines: [truncate(line1, STRIP_CHARS), truncate(line2, STRIP_CHARS)] }
  }

  /** Per the weather and stocks pages' own "M2" finding, the status line
   * (an active alert, or the uptime) must not disappear just because a
   * drill-down is open — so this reuses the SAME `statusLine` the grid strip
   * shows, on line 2, rather than dropping it in favour of the mode title
   * alone. */
  private detailStrip(mode: DrillMode, disk: DiskInfo, mem: MemInfo, battery: BatteryInfo): StripSpec {
    const line1 = mode === 'cpu' ? 'TOP CPU PROCESSES' : 'TOP MEMORY PROCESSES'
    const line2 = statusLine(disk, mem, battery, this.source.getUptimeSeconds())
    return { lines: [truncate(line1, STRIP_CHARS), truncate(line2, STRIP_CHARS)] }
  }

  onKeyPress(index: number): PressOutcome {
    if (this.selected === null) {
      if (index === 0) {
        this.selected = 'cpu'
        return 'handled'
      }
      if (index === 1) {
        this.selected = 'mem'
        return 'handled'
      }
      // DISK, NET, BATTERY, LOAD, TOP CPU and TOP MEM have no drill-down of
      // their own, per the task brief — only CPU and MEM do.
      return 'ignored'
    }

    if (index === 7) {
      this.selected = null
      return 'handled'
    }
    // Keys 0 to 6 do nothing while a drill-down is open. Read-only: no
    // refresh-on-press.
    return 'ignored'
  }
}
