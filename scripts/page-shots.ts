/**
 * Renders one deck-shaped screenshot per page into `docs/images/`, for the
 * README.
 *
 * These are NOT mock-ups drawn by hand. Every pixel comes from the real page
 * class and the real `renderKey`/`renderStrip` the daemon writes to the
 * device, driven by fixture readers instead of live sources — so a rendering
 * change shows up here on the next run, and a screenshot can never drift away
 * from what the hardware actually displays.
 *
 * The fixtures are deliberately plausible rather than empty: a page drawn with
 * no data proves nothing about layout. Where a page has a genuinely different
 * second state worth showing (the stocks detail view), it gets its own shot.
 *
 * Run with `npm run page:shots`. Output IS committed, unlike the
 * `*-contact-sheet` previews next to it, because the README links to it.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas'
import {
  renderKey, renderStrip, KEY_SIZE, STRIP_WIDTH, STRIP_HEIGHT,
} from '../src/render/canvas.js'
import { loadSprites } from '../src/render/sprites.js'
import type { DeckFrame, Rgb } from '../src/render/specs.js'
import type { Page } from '../src/pages/types.js'
import { ClaudePage } from '../src/pages/claude-page.js'
import { CodexPage } from '../src/pages/codex-page.js'
import { SpotifyPage, type PlayerReader } from '../src/pages/spotify-page.js'
import { StocksPage, type StockReader } from '../src/pages/stocks-page.js'
import { WeatherPage, type WeatherReader } from '../src/pages/weather-page.js'
import { FootballPage } from '../src/pages/football-page.js'
import { SystemPage, type SystemReader } from '../src/pages/system-page.js'
import { SYMBOLS } from '../src/sources/stocks.js'
import type { MarketState, Quote, YearlyState } from '../src/sources/stocks.js'
import type { Session } from '../src/sources/claude.js'
import type { UsageSnapshot } from '../src/sources/usage.js'
import type { CodexSnapshot } from '../src/sources/codex.js'
import type { PlayerState } from '../src/sources/spotify.js'
import type { Conditions, DayForecast } from '../src/sources/weather.js'
import type { Game, Team, TeamRecord } from '../src/sources/football.js'

/** Walks up to the repository root — the same helper the contact sheets use,
 * for the same reason: this runs from both `scripts/` and `dist/scripts/`, so
 * a fixed number of `..` segments is wrong for one of them (lesson 2). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('could not find the repository root')
}
const REPO_ROOT = findRepoRoot()
const OUT_DIR = join(REPO_ROOT, 'docs', 'images')

/** A fixed clock, so re-running this produces the same frames. Any animated
 * page is sampled at this instant rather than at whatever time the build
 * happened to run. */
const NOW = 1786549560
const NOW_MS = NOW * 1000

// ---------------------------------------------------------------------------
// The deck composite
// ---------------------------------------------------------------------------

/** Gap between keys, in unscaled pixels. */
const GAP = 10
/** Margin around the whole deck. */
const MARGIN = 22
/** Radius of a round touch button. */
const BUTTON_R = 15
/** Space between the key grid and the strip row. */
const STRIP_GAP = 18
/** Nearest-neighbour upscale, so 96 px key text stays legible on a README at
 * typical GitHub content widths. */
const SCALE = 2

const GRID_W = 4 * KEY_SIZE + 3 * GAP
const DECK_W = MARGIN * 2 + GRID_W
const DECK_H = MARGIN * 2 + 2 * KEY_SIZE + GAP + STRIP_GAP + STRIP_HEIGHT

function rgbaToCanvas(buf: Buffer, w: number, h: number): Canvas {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const data = ctx.createImageData(w, h)
  data.data.set(buf)
  ctx.putImageData(data, 0, 0)
  return canvas
}

function css(rgb: Rgb | readonly number[]): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

/**
 * Draws one frame as the physical deck: two rows of four keys, the info strip
 * centred beneath them, and a round touch button either side of the strip —
 * the Neo's real arrangement, so a reader can map a screenshot onto the
 * hardware in front of them without a caption explaining the layout.
 */
function drawDeck(frame: DeckFrame): Canvas {
  const canvas = createCanvas(DECK_W * SCALE, DECK_H * SCALE)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.scale(SCALE, SCALE)

  // The deck's own shell, not the theme background: it separates the eight
  // black key faces from each other and from a dark README.
  ctx.fillStyle = 'rgb(26, 26, 30)'
  ctx.fillRect(0, 0, DECK_W, DECK_H)
  ctx.fillStyle = 'rgb(16, 16, 19)'
  roundRect(ctx, 8, 8, DECK_W - 16, DECK_H - 16, 14)
  ctx.fill()

  for (let i = 0; i < 8; i++) {
    const col = i % 4
    const row = Math.floor(i / 4)
    const x = MARGIN + col * (KEY_SIZE + GAP)
    const y = MARGIN + row * (KEY_SIZE + GAP)
    const spec = frame.keys[i]
    if (!spec) continue
    ctx.drawImage(rgbaToCanvas(renderKey(spec), KEY_SIZE, KEY_SIZE), x, y)
  }

  const stripY = MARGIN + 2 * KEY_SIZE + GAP + STRIP_GAP
  const stripX = MARGIN + Math.round((GRID_W - STRIP_WIDTH) / 2)
  ctx.drawImage(
    rgbaToCanvas(renderStrip(frame.strip), STRIP_WIDTH, STRIP_HEIGHT),
    stripX, stripY,
  )

  const buttonY = stripY + STRIP_HEIGHT / 2
  drawButton(ctx, MARGIN + BUTTON_R + 4, buttonY, frame.buttons[0])
  drawButton(ctx, MARGIN + GRID_W - BUTTON_R - 4, buttonY, frame.buttons[1])

  return canvas
}

function drawButton(ctx: SKRSContext2D, cx: number, cy: number, rgb: Rgb): void {
  ctx.beginPath()
  ctx.arc(cx, cy, BUTTON_R, 0, Math.PI * 2)
  ctx.fillStyle = css(rgb)
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgb(40, 40, 46)'
  ctx.stroke()
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// ---------------------------------------------------------------------------
// Fixtures — one per page
// ---------------------------------------------------------------------------

function session(over: Partial<Session>): Session {
  return {
    sessionId: 'a', state: 'tool', label: 'Running command', tool: 'Bash',
    project: 'deckd', cwd: '/x', termProgram: 'ghostty', pid: 4242,
    startedAt: NOW - 840, ts: NOW, ...over,
  }
}

function claudePage(): Page {
  const sessions: Session[] = [
    session({
      sessionId: 'a', state: 'thinking', label: 'Planning the change',
      tool: '', project: 'deckd', startedAt: NOW - 1_260,
    }),
    session({
      sessionId: 'b', state: 'tool', label: 'Editing a file', tool: 'Edit',
      project: 'website', startedAt: NOW - 420,
    }),
    session({
      sessionId: 'c', state: 'permission', label: 'Needs approval', tool: 'Bash',
      project: 'knob-fw', startedAt: NOW - 95,
    }),
  ]
  const usage: UsageSnapshot = {
    fiveHourPct: 62, fiveHourResetsAt: NOW + 4_920,
    sevenDayPct: 34, sevenDayResetsAt: NOW + 345_600, ts: NOW,
  }
  return new ClaudePage(
    { getSessions: () => sessions, directoryExists: () => true },
    {
      getUsage: () => usage,
      isStale: () => false,
      getMeta: () => ({ model: 'opus', ctxPct: 41, costUsd: 3.12, ts: NOW }),
    },
    async () => true,
  )
}

function codexPage(): Page {
  const snapshot: CodexSnapshot = {
    tasks: [
      {
        threadId: 't1', title: 'Port the render tests', project: 'deckd',
        model: 'gpt-5.6-sol', updatedAt: NOW - 40, tokensUsed: 1_250_000,
      },
      {
        threadId: 't2', title: 'Audit the auth flow', project: 'website',
        model: 'gpt-5.6-sol', updatedAt: NOW - 610, tokensUsed: 402_000,
      },
      {
        threadId: 't3', title: 'Rewrite the CSV importer', project: 'ledger',
        model: 'gpt-5.6-sol', updatedAt: NOW - 95, tokensUsed: 88_400,
      },
    ],
    usage: {
      limits: [
        { usedPct: 27, windowMinutes: 10_080, resetsAt: NOW + 86_400 },
        { usedPct: 61, windowMinutes: 300, resetsAt: NOW + 5_400 },
      ],
      totalTokens: 1_740_400, plan: 'team', ts: NOW,
    },
  } as unknown as CodexSnapshot
  return new CodexPage({
    getSnapshot: () => snapshot,
    isAvailable: () => true,
    isStale: () => false,
    isUsageUnknown: () => false,
    staleForSeconds: () => null,
    isDegraded: () => false,
    setVisible: () => {},
  })
}

/** A stand-in album cover. Real art is a downloaded JPEG, which cannot live in
 * the repository, so this paints something with the same properties that
 * matter to the page: a strong accent colour to sample, and detail across all
 * four quadrants the art is cropped into. */
async function coverArt(): Promise<Image> {
  const size = 300
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, size, size)
  g.addColorStop(0, 'rgb(196, 62, 44)')
  g.addColorStop(0.55, 'rgb(122, 30, 66)')
  g.addColorStop(1, 'rgb(28, 20, 48)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(255, 226, 180, 0.55)'
  ctx.lineWidth = 3
  for (let r = 26; r < size; r += 26) {
    ctx.beginPath()
    ctx.arc(size * 0.34, size * 0.62, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.fillStyle = 'rgb(250, 240, 226)'
  ctx.font = 'bold 40px Menlo'
  ctx.textBaseline = 'top'
  ctx.fillText('DECKD', 22, 20)
  return loadImage(await canvas.encode('png'))
}

async function spotifyPage(): Promise<Page> {
  const art = await coverArt()
  const state: PlayerState = {
    isPlaying: true, title: 'Everlong', artist: 'Foo Fighters',
    album: 'The Colour and the Shape', positionMs: 96_000, durationMs: 250_000,
    trackId: 'track-1', artUrl: null, shuffle: false, repeat: 'off',
    volumePercent: 65, hasDevice: true,
  } as unknown as PlayerState
  return new SpotifyPage({
    interpolate: () => state,
    getStatus: () => 'ok',
    getArt: () => art,
    getArtColor: () => [196, 62, 44] as Rgb,
    play: async () => true,
    pause: async () => true,
    next: async () => true,
    setVisible: () => {},
  } as unknown as PlayerReader)
}

/** Measured live from Yahoo's keyless chart endpoint on 2026-08-18 — the same
 * distribution `stocks-contact-sheet.ts` calls LIVE, reused so the two
 * previews cannot disagree about what a normal day looks like. */
const STOCK_CHANGES: readonly number[] = [-1.10, 0.19, -2.49, 2.33, -1.80, -1.22, -3.47, -0.11]

function quoteFor(symbol: string, changePercent: number): Quote {
  const price = 100 + changePercent * 7
  const spark = Array.from({ length: 24 }, (_, i) => price - changePercent * (1 - i / 23))
  return {
    symbol, name: symbol, price, previousClose: price / (1 + changePercent / 100),
    changePercent, spark, currency: 'USD', asOf: NOW,
    dayHigh: price * 1.01, dayLow: price * 0.99,
    week52High: price * 1.4, week52Low: price * 0.7, volume: 1_000_000,
  } as unknown as Quote
}

function stocksPage(marketState: MarketState = 'open'): StocksPage {
  const quotes = new Map<string, Quote>()
  SYMBOLS.forEach((sym, i) => quotes.set(sym, quoteFor(sym, STOCK_CHANGES[i] ?? 0)))
  return new StocksPage({
    getQuotes: () => quotes,
    getStatus: () => 'ok',
    getMarketState: () => marketState,
    isSymbolStale: () => false,
    getYearlyState: () => ({ status: 'ok', values: [], updatedAt: 0 } as unknown as YearlyState),
    setWatchedSymbol: () => {},
    setVisible: () => {},
  } as unknown as StockReader)
}

function day(
  label: string, emoji: string, high: number, low: number,
  precipPercent: number, shortForecast: string,
): DayForecast {
  return {
    label, id: label, emoji, high, low, precipPercent, shortForecast,
    day: {
      emoji, temperature: high, precipPercent, shortForecast,
      detailedForecast: shortForecast, windSpeed: '8 mph', windDirection: 'NE',
    },
    night: null,
  } as unknown as DayForecast
}

function weatherPage(): Page {
  const days: DayForecast[] = [
    day('NOW', '⛈', 92, 76, 80, 'Thunderstorms'),
    day('THU', '🌧', 89, 75, 70, 'Rain likely'),
    day('FRI', '⛅', 91, 74, 30, 'Partly sunny'),
    day('SAT', '☀️', 94, 76, 10, 'Sunny'),
    day('SUN', '☀️', 95, 77, 10, 'Sunny'),
    day('MON', '☁️', 90, 75, 40, 'Cloudy'),
    day('TUE', '🌧', 88, 74, 60, 'Showers'),
  ]
  const conditions: Conditions = {
    windSpeed: '8 mph', temperature: 91, shortForecast: 'Thunderstorms',
  }
  return new WeatherPage({
    getZip: () => '10001',
    getDays: () => days,
    getConditions: () => conditions,
    getStatus: () => 'ok',
    getLastUpdatedAt: () => NOW,
    getPlace: () => 'Brooklyn NY',
    isStale: () => false,
    setVisible: () => {},
  } as unknown as WeatherReader)
}

function game(over: Partial<Game>): Game {
  return {
    id: '1', opponent: 'New Orleans Saints', opponentShort: 'NO', isHome: false,
    kickoffEpochMs: NOW_MS + 3 * 86_400_000, timeTbd: false, result: null,
    ...over,
  } as unknown as Game
}

function footballPage(): Page {
  // Kickoffs are offset by real hours as well as days: every game sharing one
  // time of day is a fixture artefact, and it would make the shot look like
  // the page prints a constant.
  const at = (days: number, hour: number) => NOW_MS + days * 86_400_000 + hour * 3_600_000
  const gators: Game[] = [
    game({ id: 'g1', opponent: 'Georgia Bulldogs', opponentShort: 'UGA', isHome: false, kickoffEpochMs: at(2, 4) }),
    game({ id: 'g2', opponent: 'Texas Longhorns', opponentShort: 'TEX', isHome: true, kickoffEpochMs: at(9, 8) }),
    game({ id: 'g3', opponent: 'LSU Tigers', opponentShort: 'LSU', isHome: false, kickoffEpochMs: at(16, 1) }),
  ]
  const jaguars: Game[] = [
    game({ id: 'j1', opponent: 'Houston Texans', opponentShort: 'HOU', isHome: true, kickoffEpochMs: at(4, 2) }),
    game({ id: 'j2', opponent: 'Tennessee Titans', opponentShort: 'TEN', isHome: false, kickoffEpochMs: at(11, 5) }),
    game({ id: 'j3', opponent: 'Indianapolis Colts', opponentShort: 'IND', isHome: true, kickoffEpochMs: at(18, 9) }),
  ]
  const records: Record<Team, TeamRecord> = {
    gators: { wins: 6, losses: 2, ties: 0, started: true },
    jaguars: { wins: 4, losses: 4, ties: 0, started: true },
  }
  const colors: Record<Team, Rgb> = {
    gators: [250, 70, 22],
    jaguars: [0, 103, 120],
  }
  return new FootballPage({
    getTeams: () => ['gators', 'jaguars'] as const,
    getLabel: (team: string) => (team === 'gators' ? 'GATORS' : 'JAGUARS'),
    getShort: (team: string) => (team === 'gators' ? 'UF' : 'JAX'),
    getSchedule: (team: Team) => (team === 'gators' ? gators : jaguars),
    getRecord: (team: Team) => records[team],
    getStatus: () => 'ok',
    getLastUpdatedAt: () => NOW,
    isStale: () => false,
    getLogo: () => null,
    getTeamColor: (team: Team) => colors[team],
    setVisible: () => {},
  } as never)
}

function systemPage(): Page {
  return new SystemPage({
    getCpu: () => ({ percent: 34, spark: [8, 14, 22, 19, 31, 27, 34] }),
    getMem: () => ({ pressure: 'normal', swapUsedMb: 0, pageouts: 145_393 }),
    getDisk: () => ({ usedPercent: 14, freeText: '838G', totalText: '995G' }),
    getNet: () => ({ downBytesPerSec: 2_100_000, upBytesPerSec: 300_000 }),
    getBattery: () => ({ percent: 80, state: 'ac-not-charging', minutesRemaining: null }),
    getLoad: () => ({ load1: 1.11, coreCount: 18, normalizedPercent: 6.2 }),
    getUptimeSeconds: () => 3 * 3600 + 12 * 60,
    getTopCpu: () => [
      { name: 'Chrome Helper', pct: 41, rssKb: 512_000 },
      { name: 'claude', pct: 10.3, rssKb: 879_488 },
    ],
    getTopMem: () => [
      { name: 'Xcode', pct: 22, rssKb: 4_200_000 },
      { name: 'claude', pct: 1.7, rssKb: 879_488 },
    ],
    getProcessCount: () => 1006,
    getStatus: () => 'ok',
    setVisible: () => {},
  } as unknown as SystemReader)
}

// ---------------------------------------------------------------------------

interface Shot {
  file: string
  page: Page
  /** Presses to apply before rendering, for a page whose second state is
   * reached only through the hardware — the stocks detail view. */
  press?: number
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  // The crab mascot on the Claude page is a decoded sprite. Without this the
  // key renders its text fallback, which is not what the deck shows.
  await loadSprites()

  const shots: Shot[] = [
    { file: 'page-claude.png', page: claudePage() },
    { file: 'page-codex.png', page: codexPage() },
    { file: 'page-spotify.png', page: await spotifyPage() },
    { file: 'page-stocks.png', page: stocksPage() },
    { file: 'page-stocks-detail.png', page: stocksPage(), press: 0 },
    { file: 'page-weather.png', page: weatherPage() },
    { file: 'page-football.png', page: footballPage() },
    { file: 'page-system.png', page: systemPage() },
  ]

  for (const shot of shots) {
    if (typeof shot.press === 'number') await shot.page.onKeyPress(shot.press)
    const frame = shot.page.render(NOW, NOW_MS)
    const png = await drawDeck(frame).encode('png')
    const path = resolve(OUT_DIR, shot.file)
    await writeFile(path, png)
    console.log(`${shot.file}  ${(png.length / 1024).toFixed(0)} KB`)
  }

  console.log(`\nWrote ${shots.length} shots to ${OUT_DIR}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
