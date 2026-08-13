import type { DeckFrame, KeySpec, StripSpec, ImageCrop, PulseSpec } from '../render/specs.js'
import { blankKey } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate, formatClock, formatEasternTime } from '../render/text.js'
import type { Image } from '@napi-rs/canvas'
import type { Page, PressOutcome } from './types.js'
import type { PlayerState, SpotifyStatus } from '../sources/spotify.js'

const VOLUME_STEP = 10
/**
 * The four transport-control glyphs, drawn with the colour-emoji font
 * (task 38 — the user's pick over task 37's plain-text Geometric Shapes
 * set, `▶` `▮▮` `◀◀` `▶▶` `▲`, which shipped first and is still available as
 * the non-emoji option via `glyphFont: 'text'`, see `render/canvas.ts`).
 *
 * Task 37 measured the media-control Unicode block and the speaker emoji as
 * an IDENTICAL tofu box and rejected them. That measurement used the
 * plain-TEXT font, which has no emoji coverage at all — every codepoint
 * falls back to the SAME `.notdef` box there, so the "identical" result was
 * a font-choice bug in the measurement, not a fact about the glyphs.
 * Re-measured against the real colour-emoji font
 * (`render/canvas.ts`'s `EMOJI_GLYPH_SIZE`), they render correctly.
 *
 * `glyphFont: 'emoji'` on every control key below is set PER KEY, not a
 * global switch — `render/canvas.ts` reads this field per key, so a future
 * key on this same page could still use the text path if that ever made
 * sense for it.
 */
const PLAY_GLYPH = '▶️'
const PAUSE_GLYPH = '⏸️'
const PREVIOUS_GLYPH = '⏮️'
const NEXT_GLYPH = '⏭️'
/**
 * DO NOT replace this with a `🔈 → 🔉 → 🔊` cycle for the "thump" below —
 * it was tried, measured, and rejected; re-attempting it as an "obvious"
 * improvement will reproduce the same defect. Measured chromatic pixel
 * weight at `EMOJI_GLYPH_SIZE`: `🔈` 49, `🔉` 92, `🔊` 279 — an UNEVEN step
 * (small jump, then a 3x jump), not a smooth progression. Worse, the three
 * glyphs' own ink CENTRES differ from each other by up to 2px (a real,
 * measured jitter, not anti-aliasing noise), so cycling between them reads
 * as the icon twitching sideways as much as it pulses outward — confirmed
 * visually, not just numerically (see the task's rejected-cycle preview:
 * `🔈` shows no wave lines at all, `🔉` adds a faint one, `🔊` pops in two
 * bright cyan waves — a visible identity change between frames, not a
 * radiating wave).
 *
 * A single glyph scaled by `glyphPulse` has none of that: its ink centre is
 * re-measured and re-corrected at every frame's actual size
 * (`render/canvas.ts`'s `drawCenteredGlyph`), so `🔊` alone is what
 * animates, and only its size changes from frame to frame — never its
 * colour or identity.
 */
const VOLUME_UP_GLYPH = '🔊'
/**
 * One full "thump" cycle, in milliseconds. Nothing in the data this page
 * reads carries the track's actual tempo — Spotify's audio-features
 * endpoint has it, but this app has no access to that endpoint, and this
 * page must not attempt it (it would need the user's real OAuth token,
 * which pages never touch directly). This is a fixed, decorative rhythm,
 * not synced to the music.
 */
const VOLUME_THUMP_PERIOD_MS = 800
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
 * Coarse, character-count pre-limits — NOT the thing that guarantees a fit.
 * `renderStrip` (`src/render/canvas.ts`) is what actually measures both
 * lines against the real font and shrinks whichever one needs it to make
 * room for the right-aligned clock, so these two constants only bound how
 * much text this page ever hands to the renderer in the first place.
 *
 * An earlier version of this comment reasoned from one example value (the
 * clock `2:17 / 2:33` "needs 11" characters) to conclude the budget always
 * fit — exactly the habit lesson 17 in docs/LESSONS.md exists to stop. A
 * two-hour track's clock (`120:00 / 120:00`) needs 15, and an 18-character
 * artist beside it measured 22.3 px of real overlap before the renderer
 * started measuring for itself (I5).
 *
 * The title gets the WHOLE first line, and the artist shares the second
 * line with the clock. An earlier version joined the artist and the title
 * on one line and truncated the pair at 34 characters. A track with three
 * artists then filled the budget and the TITLE became a single ellipsis,
 * which loses the one thing the user most wants to read.
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
   * Raises the render rate while the idle equaliser is showing, OR while a
   * track is playing (task 38's volume-key "thump" — see `glyphPulse` on
   * key 3 below). A loaded but PAUSED track is the one case left at the
   * daemon's default 1000 ms, because nothing on the page animates then; a
   * faster tick there would still burn CPU for a still image, exactly the
   * reasoning task 27 wrote here originally.
   *
   * UPDATE THIS COMMENT, do not just revert the rate, if a future page
   * change removes the last thing that animates while playing — task 27's
   * original version said "a loaded track ... leaves this undefined ...
   * because the art tile is a still image," which was true THEN and stopped
   * being true the moment anything on this page started moving during
   * playback. Leaving stale reasoning here is exactly what invites the next
   * person to "fix" this back to task 27's version.
   *
   * `interpolate(0)` is called only to read `isPlaying`/nullness: a null
   * result means no track is loaded, regardless of what clock value is
   * passed in, and any non-null result (even with a meaningless position,
   * since `now = 0` is not the real clock) proves a track IS loaded.
   * `unauthorized` stays at the default, because key 0 shows the sign-in
   * message there, not the animation.
   */
  get tickMs(): number | undefined {
    if (this.source.getStatus() === 'unauthorized') return undefined
    const state = this.source.interpolate(0)
    if (!state) return PULSE_TICK_MS
    return state.isPlaying ? PULSE_TICK_MS : undefined
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
        { kind: 'control', glyph: state?.isPlaying ? PAUSE_GLYPH : PLAY_GLYPH, glyphFont: 'emoji', dim: dead },
        {
          kind: 'control',
          glyph: VOLUME_UP_GLYPH,
          glyphFont: 'emoji',
          glyphCaption: volumeLabel(state),
          // The "thump" — only while a track is actually PLAYING. A
          // thumping speaker beside a paused track would be decoration with
          // no meaning; static here matches static everywhere else on a
          // paused or idle page.
          glyphPulse: state?.isPlaying ? { phase: volumePulsePhase(nowMs) } : undefined,
          dim: dead,
        },
        this.spanArtKey(state, status, art, CROP_BOTTOM_LEFT, nowMs, 2),
        this.spanArtKey(state, status, art, CROP_BOTTOM_RIGHT, nowMs, 3),
        { kind: 'control', glyph: PREVIOUS_GLYPH, glyphFont: 'emoji', dim: dead },
        { kind: 'control', glyph: NEXT_GLYPH, glyphFont: 'emoji', dim: dead },
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
      return { lines: ['spotify', 'nothing playing'], right: formatEasternTime(nowMs), dim: true }
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

  async onKeyPress(index: number): Promise<PressOutcome> {
    // Press handling needs playback flags and volume, not the interpolated
    // position. A fixed clock keeps the page pure and deterministic.
    const state = this.source.interpolate(0)
    const volume = state?.volumePercent ?? 50

    switch (index) {
      case 2: {
        const ok = await (state?.isPlaying ? this.source.pause() : this.source.play())
        return ok ? 'handled' : 'failed'
      }
      case 3: {
        const ok = await this.source.setVolume(volume + VOLUME_STEP > 100 ? 0 : volume + VOLUME_STEP)
        return ok ? 'handled' : 'failed'
      }
      case 6: {
        const ok = await this.source.previous()
        return ok ? 'handled' : 'failed'
      }
      case 7: {
        const ok = await this.source.next()
        return ok ? 'handled' : 'failed'
      }
      default:
        // Keys 0, 1, 4 and 5 (the album art) do nothing, and so does any
        // other index. Shuffle and repeat are gone: the user named
        // play/pause, volume, previous and next as what they use, and an
        // unused key invites a misfire.
        return 'ignored'
    }
  }
}

function volumeLabel(state: PlayerState | null): string {
  if (!state || state.volumePercent === null) return '—'
  return `${state.volumePercent}%`
}

/**
 * Phase for the volume key's "thump", the same `nowMs`-driven pattern
 * `pulseSpec` below uses for the idle equaliser: never `Date.now()`, so two
 * calls with the same `nowMs` always agree, and the phase actually advances
 * from one render to the next so `keyHash` sees a new value every tick
 * (lesson 11 — the exact defect that once hit this page's `imageCrop`, and
 * would just as easily freeze this animation after one frame).
 */
function volumePulsePhase(nowMs: number): number {
  return (nowMs / VOLUME_THUMP_PERIOD_MS) * 2 * Math.PI
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
