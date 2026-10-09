/**
 * Renders the football page (task 45) into a contact sheet, so a human can judge
 * the team colours, the record wash, the countdown warmth and the win/loss
 * tinting before any of it reaches the deck.
 *
 * It renders SEVERAL situations on purpose, because one hides defects — the
 * lesson task 42 paid for: a week out, game day, a game in progress, a winning
 * record, a losing record, an unknown record, and the drill-down with results
 * mixed in.
 *
 * Run with: `npm run football:contact-sheet -- [output-path]`. Defaults to
 * `football-page.png` in the repository root. A preview, not a deliverable.
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas'
import { renderKey, renderStrip, KEY_SIZE, STRIP_WIDTH, STRIP_HEIGHT } from '../src/render/canvas.js'
import { theme } from '../src/render/theme.js'
import { FootballPage, type FootballReader } from '../src/pages/football-page.js'
import type { Game, GameResult, LiveGame, ScoringEvent, Team, TeamRecord } from '../src/sources/football.js'
import { nextKickoff } from '../src/sources/football.js'

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

const NOW_S = 1786549560
const NOW_MS = NOW_S * 1000
const DAY = 24 * 60 * 60 * 1000

/** Real team colours, close to what the crests actually yield. */
const GATORS: readonly [number, number, number] = [250, 70, 22]
const JAGUARS: readonly [number, number, number] = [0, 103, 120]

function game(over: Partial<Game> = {}): Game {
  return {
    id: Math.random().toString(36).slice(2),
    opponent: 'New Orleans Saints',
    opponentShort: 'NO',
    isHome: false,
    kickoffEpochMs: NOW_MS + 3 * DAY,
    timeTbd: false,
    result: null,
    ...over,
  }
}

async function crest(rgb: readonly number[]): Promise<Image> {
  const c = createCanvas(96, 96)
  const ctx = c.getContext('2d')
  ctx.fillStyle = `rgb(${rgb.join(',')})`
  ctx.beginPath()
  ctx.arc(48, 40, 30, 0, Math.PI * 2)
  ctx.fill()
  return loadImage(c.toBuffer('image/png'))
}

function rgbaToCanvas(buf: Buffer, w: number, h: number): Canvas {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const data = ctx.createImageData(w, h)
  data.data.set(buf)
  ctx.putImageData(data, 0, 0)
  return canvas
}

interface Situation {
  label: string
  schedules: Partial<Record<Team, Game[]>>
  records: Partial<Record<Team, TeamRecord | null>>
  drillDown?: boolean
  /** The live game per team at render time. */
  live?: Partial<Record<Team, LiveGame>>
  /** The live game per team one render EARLIER, so a score can be new. */
  liveBefore?: Partial<Record<Team, LiveGame>>
  /** How long after the score was first seen the shot is taken. */
  sinceScoreMs?: number
  stale?: boolean
}

/** The Gators game in the live situations below. */
const LIVE_GAME_ID = 'live-uga'

function liveGame(over: Partial<LiveGame> = {}): LiveGame {
  return {
    gameId: LIVE_GAME_ID,
    kickoffEpochMs: NOW_MS - 2 * 60 * 60 * 1000,
    state: 'in',
    detail: '2:58 - 3rd',
    period: 3,
    clock: '2:58',
    clockSeconds: 178,
    myScore: 21,
    opponentScore: 17,
    possession: 'mine',
    downDistance: '2nd & 6',
    fieldPosition: 'UGA 24',
    lastPlay: 'Johnson 7 Yd Run',
    redZone: false,
    lastScore: null,
    updatedAtMs: NOW_MS - 5000,
    stale: false,
    ...over,
  }
}

function score(over: Partial<ScoringEvent>): ScoringEvent {
  return {
    id: `${LIVE_GAME_ID}:1`, seq: 1, side: 'mine', points: 6, kind: 'touchdown',
    atMs: NOW_MS - 1000, playId: null, myScore: 27, opponentScore: 17, ...over,
  }
}

/** Schedules for the live situations: the Gators play Georgia now; the
 * Jaguars play in two days, then again the week after. */
const LIVE_SCHEDULES: Partial<Record<Team, Game[]>> = {
  gators: [
    game({ id: LIVE_GAME_ID, opponent: 'Georgia Bulldogs', opponentShort: 'UGA', kickoffEpochMs: NOW_MS - 2 * 60 * 60 * 1000 }),
    game({ opponentShort: 'TEX', kickoffEpochMs: NOW_MS + 7 * DAY }),
  ],
  jaguars: [
    game({ opponent: 'Houston Texans', opponentShort: 'HOU', isHome: true, kickoffEpochMs: NOW_MS + 2 * DAY + 3 * 60 * 60 * 1000 }),
    game({ opponent: 'Tennessee Titans', opponentShort: 'TEN', kickoffEpochMs: NOW_MS + 9 * DAY }),
  ],
}
const LIVE_RECORDS: Partial<Record<Team, TeamRecord | null>> = {
  gators: { wins: 5, losses: 1, ties: 0, started: true },
  jaguars: { wins: 4, losses: 4, ties: 0, started: true },
}

const SITUATIONS: readonly Situation[] = [
  {
    label: 'a week out',
    schedules: {
      gators: [game({ opponentShort: 'LSU', kickoffEpochMs: NOW_MS + 6.5 * DAY })],
      jaguars: [game({ opponentShort: 'IND', kickoffEpochMs: NOW_MS + 6 * DAY })],
    },
    records: { gators: { wins: 2, losses: 1, ties: 0, started: true } as TeamRecord, jaguars: { wins: 1, losses: 2, ties: 0, started: true } as TeamRecord },
  },
  {
    label: 'game day',
    schedules: {
      gators: [game({ opponentShort: 'LSU', kickoffEpochMs: NOW_MS + 3 * 60 * 60 * 1000 })],
      jaguars: [game({ opponentShort: 'IND', kickoffEpochMs: NOW_MS + 5 * 60 * 60 * 1000 })],
    },
    records: { gators: { wins: 5, losses: 0, ties: 0, started: true } as TeamRecord, jaguars: { wins: 0, losses: 5, ties: 0, started: true } as TeamRecord },
  },
  {
    label: 'kickoff passed',
    schedules: {
      gators: [game({ opponentShort: 'LSU', kickoffEpochMs: NOW_MS - 60 * 60 * 1000 })],
      jaguars: [game({ opponentShort: 'IND', kickoffEpochMs: NOW_MS + 2 * DAY })],
    },
    records: { gators: { wins: 3, losses: 3, ties: 0, started: true } as TeamRecord, jaguars: null },
  },
  {
    label: 'drill-down, W/L',
    drillDown: true,
    schedules: {
      gators: [
        game({ opponentShort: 'MIA', kickoffEpochMs: NOW_MS - 30 * DAY, result: 'win' }),
        game({ opponentShort: 'UT', kickoffEpochMs: NOW_MS - 23 * DAY, result: 'loss' }),
        game({ opponentShort: 'UGA', kickoffEpochMs: NOW_MS - 16 * DAY, result: 'win' }),
        game({ opponentShort: 'LSU', kickoffEpochMs: NOW_MS - 9 * DAY, result: 'win' }),
        game({ opponentShort: 'AUB', kickoffEpochMs: NOW_MS - 2 * DAY, result: 'loss' }),
        game({ opponentShort: 'FSU', kickoffEpochMs: NOW_MS + 5 * DAY }),
        game({ opponentShort: 'TBD', kickoffEpochMs: null, timeTbd: true }),
      ],
    },
    records: { gators: { wins: 3, losses: 2, ties: 0, started: true } as TeamRecord },
  },
]

const LIVE_SITUATIONS: readonly Situation[] = [
  {
    label: 'live, Q3, our ball',
    schedules: LIVE_SCHEDULES, records: LIVE_RECORDS,
    live: { gators: liveGame() },
  },
  {
    label: 'TOUCHDOWN, +450 ms',
    schedules: LIVE_SCHEDULES, records: LIVE_RECORDS,
    liveBefore: { gators: liveGame() },
    live: { gators: liveGame({ myScore: 27, possession: null, downDistance: null, fieldPosition: null, lastPlay: 'Johnson 12 Yd Run', lastScore: score({}) }) },
    sinceScoreMs: 450,
  },
  {
    label: 'TOUCHDOWN, +1.2 s',
    schedules: LIVE_SCHEDULES, records: LIVE_RECORDS,
    liveBefore: { gators: liveGame() },
    live: { gators: liveGame({ myScore: 27, possession: null, downDistance: null, fieldPosition: null, lastPlay: 'Johnson 12 Yd Run', lastScore: score({}) }) },
    sinceScoreMs: 1200,
  },
  {
    label: 'FIELD GOAL, +400 ms',
    schedules: LIVE_SCHEDULES, records: LIVE_RECORDS,
    liveBefore: { gators: liveGame() },
    live: { gators: liveGame({ myScore: 24, possession: null, downDistance: null, fieldPosition: null, lastPlay: 'Mihalek 41 Yd FG', lastScore: score({ points: 3, kind: 'field-goal', myScore: 24 }) }) },
    sinceScoreMs: 400,
  },
  {
    label: 'they score: note only',
    schedules: LIVE_SCHEDULES, records: LIVE_RECORDS,
    liveBefore: { gators: liveGame() },
    live: { gators: liveGame({ opponentScore: 24, possession: 'opponent', fieldPosition: 'UF 25', downDistance: '1st & 10', lastPlay: 'Kickoff, touchback', lastScore: score({ side: 'opponent', myScore: 21, opponentScore: 24 }) }) },
    sinceScoreMs: 3000,
  },
  {
    label: 'red zone, theirs',
    schedules: LIVE_SCHEDULES, records: LIVE_RECORDS,
    live: { gators: liveGame({ possession: 'opponent', fieldPosition: 'UF 12', downDistance: '3rd & 4', redZone: true, period: 4, clock: '0:41', lastPlay: 'Beck pass to Bowers for 9 yds' }) },
  },
  {
    label: 'unknowns, stale',
    schedules: LIVE_SCHEDULES, records: LIVE_RECORDS,
    live: { gators: liveGame({ myScore: null, opponentScore: null, possession: null, downDistance: null, fieldPosition: null, clock: null, period: null, lastPlay: null, redZone: null, stale: true }) },
  },
  {
    label: 'halftime',
    schedules: LIVE_SCHEDULES, records: LIVE_RECORDS,
    live: { gators: liveGame({ detail: 'Halftime', period: 2, clock: '0:00', possession: null, downDistance: null, fieldPosition: null, lastPlay: null }) },
  },
  {
    label: 'pre, 12 min out',
    schedules: LIVE_SCHEDULES, records: LIVE_RECORDS,
    live: { gators: liveGame({ state: 'pre', kickoffEpochMs: NOW_MS + 12 * 60 * 1000, detail: '10/11 - 7:30 PM EDT', period: null, clock: null, clockSeconds: null, myScore: null, opponentScore: null, possession: null, downDistance: null, fieldPosition: null, lastPlay: null, redZone: null }) },
  },
  {
    label: 'final',
    schedules: LIVE_SCHEDULES, records: LIVE_RECORDS,
    live: { gators: liveGame({ state: 'post', detail: 'Final/OT', period: null, clock: null, clockSeconds: null, myScore: 34, opponentScore: 31, possession: null, downDistance: null, fieldPosition: null, lastPlay: null, redZone: null }) },
  },
  {
    label: 'other row TBD time',
    schedules: {
      ...LIVE_SCHEDULES,
      jaguars: [game({ opponent: 'Houston Texans', opponentShort: 'HOU', isHome: true, kickoffEpochMs: NOW_MS + 4 * DAY, timeTbd: true })],
    },
    records: LIVE_RECORDS,
    live: { gators: liveGame() },
  },
]

const ALL_SITUATIONS: readonly Situation[] = [...SITUATIONS, ...LIVE_SITUATIONS]

const M = 14
const LABEL_W = 118
const GAP = 6
const TITLE_H = 26

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? join(REPO_ROOT, 'football-page.png'))
  const gatorCrest = await crest(GATORS)
  const jaguarCrest = await crest(JAGUARS)

  const rowH = 2 * (KEY_SIZE + GAP) + STRIP_HEIGHT + 20
  const width = M * 2 + LABEL_W + 4 * (KEY_SIZE + GAP) + 40
  const height = TITLE_H + ALL_SITUATIONS.length * rowH + M

  const sheet = createCanvas(width, height)
  const ctx = sheet.getContext('2d')
  ctx.fillStyle = 'rgb(24, 24, 28)'
  ctx.fillRect(0, 0, width, height)
  ctx.textBaseline = 'top'
  ctx.fillStyle = `rgb(${theme.text.join(',')})`
  ctx.font = '14px Menlo'
  ctx.fillText('Football page — real FootballPage, real renderKey', M, 6)

  let y = TITLE_H
  for (const sit of ALL_SITUATIONS) {
    let live = sit.liveBefore ?? sit.live ?? {}
    const reader = {
      getTeams: () => ['gators', 'jaguars'] as const,
    getLabel: (team: string) => (team === 'gators' ? 'GATORS' : 'JAGUARS'),
    getShort: (team: string) => (team === 'gators' ? 'UF' : 'JAX'),
    getSchedule: (t: Team) => sit.schedules[t] ?? [],
      getRecord: (t: Team) => sit.records[t] ?? null,
      getStatus: () => 'ok',
      getLastUpdatedAt: () => NOW_S,
      isStale: () => sit.stale === true,
      getLive: (t: Team) => live[t] ?? null,
      getNextKickoff: (t: Team, nowMs: number) => nextKickoff(sit.schedules[t] ?? [], nowMs),
      getLogo: (t: Team) => (t === 'gators' ? gatorCrest : jaguarCrest),
      getTeamColor: (t: Team) => (t === 'gators' ? GATORS : JAGUARS),
      setVisible: () => {},
    } as unknown as FootballReader
    const page = new FootballPage(reader)
    if (sit.drillDown) {
      page.render(NOW_S, NOW_MS)
      page.onKeyPress(0)
    }
    let frame
    if (sit.liveBefore) {
      // The page records the score it sees first and celebrates only a NEW
      // one, so the shot needs a render before the score and one at it.
      const since = sit.sinceScoreMs ?? 0
      page.render(NOW_S, NOW_MS - since - 20_000)
      live = sit.live ?? {}
      page.render(NOW_S, NOW_MS - since)
      frame = page.render(NOW_S, NOW_MS)
    } else {
      frame = page.render(NOW_S, NOW_MS)
    }

    ctx.fillStyle = `rgb(${theme.textDim.join(',')})`
    ctx.font = '10px Menlo'
    ctx.fillText(sit.label, M, y + 4)

    for (let i = 0; i < 8; i++) {
      const col = i % 4
      const row = Math.floor(i / 4)
      ctx.drawImage(
        rgbaToCanvas(renderKey(frame.keys[i]!), KEY_SIZE, KEY_SIZE),
        M + LABEL_W + col * (KEY_SIZE + GAP),
        y + row * (KEY_SIZE + GAP),
      )
    }
    frame.buttons.forEach((rgb, i) => {
      ctx.fillStyle = `rgb(${rgb.join(',')})`
      ctx.beginPath()
      ctx.arc(M + LABEL_W + 4 * (KEY_SIZE + GAP) + 14, y + 14 + i * 32, 11, 0, Math.PI * 2)
      ctx.fill()
    })
    ctx.drawImage(
      rgbaToCanvas(renderStrip(frame.strip), STRIP_WIDTH, STRIP_HEIGHT),
      M + LABEL_W,
      y + 2 * (KEY_SIZE + GAP) + 4,
    )
    y += rowH
  }

  await writeFile(outPath, sheet.toBuffer('image/png'))
  process.stdout.write(`wrote ${outPath}\n`)
}

await main()
