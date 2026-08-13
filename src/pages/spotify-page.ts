import type { DeckFrame, KeySpec, StripSpec, ImageCrop, PulseSpec } from '../render/specs.js'
import { blankKey } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate, formatClock } from '../render/text.js'
import type { Image } from '@napi-rs/canvas'
import type { Page } from './types.js'
import type { PlayerState, SpotifyStatus } from '../sources/spotify.js'

const VOLUME_STEP = 10
/** How often the render loop should tick while the idle equaliser is
 * showing instead of album art — see the `tickMs` getter below. Matches the
 * rate already proven smooth for the Claude page's crab animation, well
 * inside what a handful of 96x96 keys can sustain (docs/VERIFIED-FACTS.md's
 * throughput table: `renderKey` costs 0.032 ms, all eight keys sustain
 * 45 fps). */
const PULSE_TICK_MS = 100
/** One full rise-and-fall cycle, in milliseconds. Slow, so the idle keys
 * read as an equaliser at rest rather than a strobe. */
const PULSE_PERIOD_MS = 4000
/** Radians between one idle art key's phase and the next, so a wave appears
 * to travel across the four keys instead of them all breathing in lockstep. */
const PULSE_PHASE_STEP = Math.PI / 2
/** Bars drawn across one idle art key. */
const PULSE_BARS = 6
/**
 * Measured, not guessed. At 13 px Menlo one character advances 7.83 px, and the
 * strip has 236 px of usable width, so a line holds 30 characters. The clock
 * `2:17 / 2:33` needs 11 of them.
 *
 * So the title gets the WHOLE first line, and the artist shares the second line
 * with the clock. An earlier version joined the artist and the title on one line
 * and truncated the pair at 34 characters. A track with three artists then filled
 * the budget and the TITLE became a single ellipsis, which loses the one thing
 * the user most wants to read.
 */
const TITLE_CHARS = 30
const ARTIST_CHARS = 18
/** Album name shown on key 0 while art is still downloading. */
const ALBUM_FALLBACK_CHARS = 10

/**
 * The four quadrants of the shared album-art image, one per spanned key.
 * Keys 0, 1, 4, 5 form the top-left 2x2 block of the deck (0 and 1 are the
 * top row, 4 and 5 are the row beneath them), so the crops split the image
 * into top-left, top-right, bottom-left and bottom-right.
 */
const CROP_TOP_LEFT: ImageCrop = { sx: 0.0, sy: 0.0, sw: 0.5, sh: 0.5 }
const CROP_TOP_RIGHT: ImageCrop = { sx: 0.5, sy: 0.0, sw: 0.5, sh: 0.5 }
const CROP_BOTTOM_LEFT: ImageCrop = { sx: 0.0, sy: 0.5, sw: 0.5, sh: 0.5 }
const CROP_BOTTOM_RIGHT: ImageCrop = { sx: 0.5, sy: 0.5, sw: 0.5, sh: 0.5 }

/** The part of `SpotifySource` this page needs. */
export interface PlayerReader {
  interpolate(now: number): PlayerState | null
  getStatus(): SpotifyStatus
  getArt(trackId: string, url: string | null): Image | null
  play(): Promise<boolean>
  pause(): Promise<boolean>
  next(): Promise<boolean>
  previous(): Promise<boolean>
  setVolume(percent: number): Promise<boolean>
  setVisible(visible: boolean): void
}

export class SpotifyPage implements Page {
  readonly name = 'spotify'

  constructor(private readonly source: PlayerReader) {}

  /**
   * Raises the render rate only while the idle equaliser is showing. A
   * loaded track (playing or paused) leaves this `undefined` — the daemon's
   * default 1000 ms — because the art tile is then a still image, and a
   * faster tick would burn CPU for nothing. `interpolate(0)` is called only
   * for its nullness: a null result means no track is loaded, regardless of
   * what clock value is passed in, and any non-null result (even with a
   * meaningless position, since `now = 0` is not the real clock) proves a
   * track IS loaded. `unauthorized` also stays at the default, because key 0
   * shows the sign-in message there, not the animation.
   */
  get tickMs(): number | undefined {
    if (this.source.getStatus() === 'unauthorized') return undefined
    return this.source.interpolate(0) ? undefined : PULSE_TICK_MS
  }

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.source.setVisible(false)
  }

  render(now: number, nowMs: number = now * 1000): DeckFrame {
    const state = this.source.interpolate(now)
    const status = this.source.getStatus()
    const dead = status === 'no-device' || status === 'unauthorized' || !state
    const art = state ? this.source.getArt(state.trackId, state.artUrl) : null

    return {
      keys: [
        this.primaryArtKey(state, status, art, CROP_TOP_LEFT, nowMs),
        this.spanArtKey(state, status, art, CROP_TOP_RIGHT, nowMs, 1),
        { kind: 'control', glyph: state?.isPlaying ? '❙❙' : '▶', dim: dead },
        { kind: 'control', lines: ['VOL +', volumeLabel(state)], align: 'center', dim: dead },
        this.spanArtKey(state, status, art, CROP_BOTTOM_LEFT, nowMs, 2),
        this.spanArtKey(state, status, art, CROP_BOTTOM_RIGHT, nowMs, 3),
        { kind: 'control', glyph: '◀◀', dim: dead },
        { kind: 'control', glyph: '▶▶', dim: dead },
      ],
      strip: this.strip(state, status, nowMs),
      buttons: [theme.gray, theme.gray],
    }
  }

  /**
   * Key 0. Carries the top-left quadrant when art is available, and is the
   * ONLY key that shows the "sign in" text while unauthorized — a partial
   * image across the 2x2 block is worse than none. While nothing is
   * playing (and the user is not stuck at a sign-in prompt), it carries
   * phase 0 of the idle equaliser instead of the old static fallback text.
   */
  private primaryArtKey(
    state: PlayerState | null,
    status: SpotifyStatus,
    art: Image | null,
    crop: ImageCrop,
    nowMs: number,
  ): KeySpec {
    if (status === 'unauthorized') {
      return { kind: 'control', lines: ['SPOTIFY', 'SIGN IN'], align: 'center', dim: true }
    }
    if (!state) {
      return { kind: 'control', pulse: pulseSpec(nowMs, 0) }
    }
    if (art) {
      return { kind: 'image', image: art, imageKey: state.trackId, imageCrop: crop }
    }
    // The art downloads in the background. Show the album name meanwhile.
    return {
      kind: 'control',
      lines: ['NOW', truncate(state.album, ALBUM_FALLBACK_CHARS)],
      align: 'center',
    }
  }

  /** Keys 1, 4 and 5. Blank while unauthorized (key 0 already carries the
   * sign-in text there) and blank whenever key 0 would show the album-name
   * fallback (state present but art not downloaded yet), so the block never
   * shows three quadrants of art beside one line of text. While nothing is
   * playing, each carries its own phase (`phaseIndex` 1, 2 or 3) of the idle
   * equaliser, so the four keys ripple instead of breathing in lockstep. */
  private spanArtKey(
    state: PlayerState | null,
    status: SpotifyStatus,
    art: Image | null,
    crop: ImageCrop,
    nowMs: number,
    phaseIndex: number,
  ): KeySpec {
    if (status === 'unauthorized') return blankKey()
    if (!state) return { kind: 'control', pulse: pulseSpec(nowMs, phaseIndex) }
    if (!art) return blankKey()
    return { kind: 'image', image: art, imageKey: state.trackId, imageCrop: crop }
  }

  private strip(state: PlayerState | null, status: SpotifyStatus, nowMs: number): StripSpec {
    if (status === 'unauthorized') {
      return { lines: ['spotify not connected', 'run: deckd auth spotify'], dim: true }
    }
    if (!state) {
      // Idle: a clear message plus the clock, so the strip still tells the
      // user something useful while the four art keys carry the animation.
      return { lines: ['spotify', 'nothing playing'], right: formatWallClock(nowMs), dim: true }
    }

    // Title on its own line, artist on the second beside the clock. The title
    // must never be the field that gets truncated away.
    const fraction = state.durationMs > 0 ? state.positionMs / state.durationMs : 0

    return {
      lines: [truncate(state.title, TITLE_CHARS), truncate(state.artist, ARTIST_CHARS)],
      right: `${formatClock(state.positionMs / 1000)} / ${formatClock(state.durationMs / 1000)}`,
      bar: { value: fraction, color: theme.green },
      dim: status === 'offline',
    }
  }

  async onKeyPress(index: number): Promise<void> {
    const state = this.source.interpolate(Math.floor(Date.now() / 1000))
    const volume = state?.volumePercent ?? 50

    switch (index) {
      case 2:
        await (state?.isPlaying ? this.source.pause() : this.source.play())
        return
      case 3:
        await this.source.setVolume(volume + VOLUME_STEP)
        return
      case 6:
        await this.source.previous()
        return
      case 7:
        await this.source.next()
        return
      default:
        // Keys 0, 1, 4 and 5 (the album art) do nothing, and so does any
        // other index. Shuffle and repeat are gone: the user named
        // play/pause, volume, previous and next as what they use, and an
        // unused key invites a misfire.
        return
    }
  }
}

function volumeLabel(state: PlayerState | null): string {
  if (!state || state.volumePercent === null) return '—'
  return `${state.volumePercent}%`
}

/**
 * Builds the pulse spec for one of the four idle art keys. `phaseIndex`
 * (0 to 3) gives each key its own offset, and `nowMs` — never `Date.now()`,
 * supplied by the daemon's render clock — advances the shared phase, so
 * `keyHash` sees a new value on every tick and the daemon keeps redrawing
 * (lesson 11 in docs/LESSONS.md: a field that never changes freezes the
 * animation after one frame).
 */
function pulseSpec(nowMs: number, phaseIndex: number): PulseSpec {
  const phase = (nowMs / PULSE_PERIOD_MS) * 2 * Math.PI + phaseIndex * PULSE_PHASE_STEP
  return { phase, bars: PULSE_BARS, color: theme.green }
}

/** `H:MM`, from the daemon's own millisecond clock — never `Date.now()`, so
 * the strip's idle clock is deterministic in a test. */
function formatWallClock(nowMs: number): string {
  const d = new Date(nowMs)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}
