import type { DeckFrame, KeySpec, Rgb, StripSpec, ImageCrop, IdleSpec, IdleVariant } from '../render/specs.js'
import { blankKey } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate, formatClock, formatEasternTime } from '../render/text.js'
import type { Image } from '@napi-rs/canvas'
import type { Page, PressOutcome } from './types.js'
import type { PlayerState, SpotifyStatus } from '../sources/spotify.js'

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
/**
 * The transport glyphs, drawn with the TEXT font rather than the colour-emoji
 * one (task 44).
 *
 * The emoji versions were Apple's glossy blue-grey buttons. On a deck otherwise
 * filled with album art they read as two plastic stickers on black voids — the
 * user's words were "out of place and not fun" — and being bitmap glyphs they
 * ignore `fillStyle`, so they could never take the album's colour either
 * (lesson 15).
 *
 * MEASURED on 2026-08-18, because Menlo does not have the media-control block:
 * `⏵`, `⏸`, `⏭` and `‖` all render as the SAME missing-glyph box, byte-identical
 * to each other at 202 ink pixels. Reaching for `⏸` in text mode silently gives
 * you tofu. These three are real Menlo glyphs with distinct, healthy coverage:
 * `▶` 241 px, `❚❚` 607 px, `▶▶` 481 px.
 */
const PLAY_GLYPH = '▶'
const PAUSE_GLYPH = '❚❚'
const NEXT_GLYPH = '▶▶'

/**
 * How the two control keys wear the album's colour.
 *
 * The wash is the accent heavily darkened, so white-hot glyphs still read on it.
 * The glyph is the accent LIFTED toward white when the album is dark — without
 * that, a deep-red cover would put a dark red glyph on a near-black wash and the
 * controls would vanish. The lift is what makes the treatment safe for any cover
 * rather than only for bright ones.
 */
const CONTROL_WASH_FACTOR = 0.22
/** The luminance a control glyph must reach, summed across the three channels. */
const CONTROL_GLYPH_MIN_LUM = 330

/**
 * How fast the play/pause glyph breathes while a track is playing, and how far.
 *
 * It is the only thing that moves during playback, and only ONE key changes per
 * frame — so the cost is about ten key-writes a second against a measured USB
 * ceiling of 362 (docs/VERIFIED-FACTS.md). A still deck during playback was the
 * other half of "not fun".
 */
const BREATHE_PERIOD_MS = 2400
const BREATHE_AMPLITUDE = 1

/** How often the render loop should tick while anything on this page is moving —
 * the idle rain, the paused layer, or the play/pause glyph's breath. Matches the
 * rate already proven smooth for the Claude page's crab animation, well inside
 * what a handful of 96x96 keys can sustain (docs/VERIFIED-FACTS.md's throughput
 * table: `renderKey` costs 0.032 ms, all eight keys sustain 45 fps). */
const IDLE_TICK_MS = 100

/**
 * Which of `render/canvas.ts`'s three cyberpunk idle animations ships. The user
 * chose `'rain'` from the previews on 2026-08-13: "i like the matrix one that is
 * sick". It is also the only variant correct across the three-column art block
 * task 44 introduced — `grid` and `glitch` draw one 2x2 scene and clamp.
 */
const IDLE_VARIANT: IdleVariant = 'rain'

/**
 * What a PAUSED cover shows beneath itself. Slow, colourless haze reads as
 * suspended; anything falling or rushing would read as still playing.
 */
const PAUSED_FX_VARIANT = 'fog' as const
const PAUSED_FX_INTENSITY = 0.8

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
/**
 * The six crops of the 3x2 art block (task 44), and why they are not simply
 * `1/3 x 1/2`.
 *
 * Album art is SQUARE — 640x640 — and three keys wide by two tall is 3:2. Naive
 * `sw: 1/3, sh: 1/2` crops would hand each key a 213x320 source rect to draw
 * into a 96x96 key, squashing every tile vertically. `drawCroppedImage` always
 * fills the whole key regardless of the source rect's shape, so the distortion
 * would be silent.
 *
 * So the block shows the CENTRAL 3:2 slice of the cover: source y from 1/6 to
 * 5/6. Each key then takes a `1/3 x 1/3` rect of the square source, which IS
 * square, so nothing distorts.
 *
 * The cost is the top and bottom sixth of the cover. Album covers are
 * centre-weighted, so this is the right trade for a full-bleed image — but it can
 * clip a title printed hard against the top or bottom edge.
 */
const ART_COLS = 3
const ART_ROWS = 2
/** Where the central 3:2 slice starts, as a fraction of the square source. */
const ART_SLICE_TOP = 1 / 6
/** Each key's source rect, square by construction. */
const ART_CELL = 1 / 3

/** The crop for one cell of the art block. Exported so a test can prove the six
 * cells tile the slice exactly, with no gap, no overlap and no distortion. */
export function artCrop(col: number, row: number): ImageCrop {
  return {
    sx: col * ART_CELL,
    sy: ART_SLICE_TOP + row * ART_CELL,
    sw: ART_CELL,
    sh: ART_CELL,
  }
}

/** The part of `SpotifySource` this page needs. */
export interface PlayerReader {
  interpolate(now: number): PlayerState | null
  getStatus(): SpotifyStatus
  getArt(trackId: string, url: string | null): Image | null
  /** The current cover's accent colour, or null when it has none. Computed once
   * per track when the art is decoded — never on the render path. */
  getArtColor(trackId: string): Rgb | null
  play(): Promise<boolean>
  pause(): Promise<boolean>
  next(): Promise<boolean>
  setVisible(visible: boolean): void
}

export class SpotifyPage implements Page {
  readonly name = 'spotify'

  constructor(private readonly source: PlayerReader) {}

  /**
   * The `now` (seconds) this page last handed to `interpolate` while
   * `status` was `'offline'` — see `render`'s freeze below (I3). `null`
   * whenever `status` is anything else, so the very next `offline` render
   * re-anchors instead of reusing a value from a PREVIOUS offline spell.
   */
  private offlineAnchorNow: number | null = null

  /**
   * Raises the render rate while the idle animation is showing, OR while a
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
    // Unauthorized shows text on key 0, so nothing animates.
    if (this.source.getStatus() === 'unauthorized') return undefined
    const state = this.source.interpolate(0)
    // Nothing loaded: the matrix rain runs across all six art keys, whatever the
    // status says — a `no-device` or `offline` idle animates just as much as a
    // genuinely empty one.
    if (!state) return IDLE_TICK_MS
    // A track IS loaded, so something moves unless the data is stale: playing
    // breathes on the play/pause glyph, and paused drifts a layer under all six
    // art cells.
    //
    // Reads the SAME `isStale` predicate every dimmed element reads, rather than
    // re-deriving it from `status` — which is how M5's case (a failed transport
    // command leaving `isPlaying` true behind a dead device) stays covered for
    // free instead of needing its own check here.
    return isStale(this.source.getStatus(), state) ? undefined : IDLE_TICK_MS
  }


  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.source.setVisible(false)
  }

  render(now: number, nowMs: number = now * 1000): DeckFrame {
    const status = this.source.getStatus()
    // I3: while `status` is `'offline'`, freeze the clock `interpolate` sees
    // at the value it had the FIRST render this page observed the drop —
    // otherwise `interpolate` keeps extrapolating the position forward for
    // up to `INTERPOLATE_MAX_POLL_AGE_SECONDS` (5 minutes,
    // `sources/spotify.ts`), so the progress bar and the clock kept creeping
    // ahead behind art the page was not yet marking as stale. Any other
    // status clears the anchor, so the NEXT time this page goes offline it
    // re-anchors instead of reusing a stale one from a previous drop.
    if (status === 'offline') {
      this.offlineAnchorNow ??= now
    } else {
      this.offlineAnchorNow = null
    }
    const effectiveNow = status === 'offline' ? this.offlineAnchorNow! : now
    const state = this.source.interpolate(effectiveNow)
    // I3: ONE staleness predicate, used for every element on this page —
    // the control glyphs, the strip, AND the four album-art keys, which
    // previously carried no staleness signal at all. Before this fix, a
    // failed transport command (`status: 'no-device'`, `state` left in
    // place until the next poll) dimmed the transport glyphs but left the
    // art keys bright, and `'offline'` dimmed only the strip — two
    // different, disagreeing checks. `stale` folds `'offline'` in exactly
    // like `'no-device'` and `'unauthorized'` always were.
    const stale = isStale(status, state)
    const art = state ? this.source.getArt(state.trackId, state.artUrl) : null

    // The cover's own accent colour, or the theme when it has none. It borders
    // the two control keys, fills the strip's progress bar, and lights both
    // round buttons, so the whole deck takes on each album.
    const accent = (state ? this.source.getArtColor(state.trackId) : null) ?? theme.gray
    // Paused, with a track loaded, is its own visual state: the art dims and an
    // ambient layer shows THROUGH it. That works only because `renderKey` draws
    // the background, then `fx`, then the image — and `dim` applies to the image
    // through `globalAlpha`, so a 45-percent-opaque cover reveals the layer
    // beneath. No renderer change was needed for this at all.
    const paused = state !== null && !state.isPlaying && !stale

    return {
      keys: [
        // Row 0: three art cells, then play/pause.
        this.primaryArtKey(state, status, art, stale, artCrop(0, 0), nowMs, paused),
        this.spanArtKey(state, status, art, stale, artCrop(1, 0), nowMs, 1, 0, paused),
        this.spanArtKey(state, status, art, stale, artCrop(2, 0), nowMs, 2, 0, paused),
        {
          kind: 'control',
          glyph: state?.isPlaying ? PAUSE_GLYPH : PLAY_GLYPH,
          glyphColor: controlGlyphColor(accent),
          bg: controlWash(accent),
          border: accent,
          // Breathes only while a track is genuinely PLAYING and the data is not
          // stale. A pulsing glyph over a dead device would be decoration with no
          // meaning, exactly as the old volume "thump" was held to.
          glyphPulse:
            state?.isPlaying && !stale ? { phase: breathePhase(nowMs) } : undefined,
          dim: stale,
        },
        // Row 1: three art cells, then next.
        this.spanArtKey(state, status, art, stale, artCrop(0, 1), nowMs, 0, 1, paused),
        this.spanArtKey(state, status, art, stale, artCrop(1, 1), nowMs, 1, 1, paused),
        this.spanArtKey(state, status, art, stale, artCrop(2, 1), nowMs, 2, 1, paused),
        {
          kind: 'control',
          glyph: NEXT_GLYPH,
          glyphColor: controlGlyphColor(accent),
          bg: controlWash(accent),
          border: accent,
          dim: stale,
        },
      ],
      strip: this.strip(state, status, stale, nowMs, accent),
      buttons: [accent, accent],
    }
  }

  /**
   * Key 0. Carries the top-left quadrant when art is available, and is the
   * ONLY key that shows the "sign in" text while unauthorized — a partial
   * image across the 2x2 block is worse than none. While nothing is
   * playing (and the user is not stuck at a sign-in prompt), it carries the
   * top-left quadrant (`col` 0, `row` 0) of the idle animation instead of the
   * old static fallback text.
   */
  private primaryArtKey(
    state: PlayerState | null,
    status: SpotifyStatus,
    art: Image | null,
    stale: boolean,
    crop: ImageCrop,
    nowMs: number,
    paused: boolean,
  ): KeySpec {
    if (status === 'unauthorized') {
      return { kind: 'control', lines: ['SPOTIFY', 'SIGN IN'], align: 'center', dim: true }
    }
    if (!state) {
      return { kind: 'control', idle: idleSpec(nowMs, 0, 0) }
    }
    if (art) {
      // I3: dims like every other element on the page when `stale` — an art
      // key used to be the one thing on this screen with no staleness
      // signal at all, so a dead device or a dropped connection still
      // showed a bright cover behind dim transport glyphs.
      //
      // Routes through the SAME `artKey` builder as the other five cells, so the
      // paused treatment cannot land on five of six.
      return artKey(art, state.trackId, crop, stale, paused, nowMs)
    }
    // The art downloads in the background. Show the album name meanwhile.
    return {
      kind: 'control',
      lines: ['NOW', truncate(state.album, ALBUM_FALLBACK_CHARS)],
      align: 'center',
      dim: stale,
    }
  }

  /** Keys 1, 4 and 5. Blank while unauthorized (key 0 already carries the
   * sign-in text there) and blank whenever key 0 would show the album-name
   * fallback (state present but art not downloaded yet), so the block never
   * shows three quadrants of art beside one line of text. While nothing is
   * playing, each carries its own quadrant (`col`, `row`) of the idle
   * animation, so the four keys form one coherent design instead of each
   * inventing its own. */
  private spanArtKey(
    state: PlayerState | null,
    status: SpotifyStatus,
    art: Image | null,
    stale: boolean,
    crop: ImageCrop,
    nowMs: number,
    col: 0 | 1 | 2,
    row: 0 | 1,
    paused: boolean,
  ): KeySpec {
    if (status === 'unauthorized') return blankKey()
    if (!state) return { kind: 'control', idle: idleSpec(nowMs, col, row) }
    if (!art) return blankKey()
    return artKey(art, state.trackId, crop, stale, paused, nowMs)
  }

  private strip(
    state: PlayerState | null,
    status: SpotifyStatus,
    stale: boolean,
    nowMs: number,
    accent: Rgb,
  ): StripSpec {
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
      // The album's own accent colour, so the bar belongs to the cover above it.
      // Falls back to the theme when the cover has no usable colour — never a
      // fabricated hue.
      bar: { value: fraction, color: accent },
      // I3: the SAME `stale` predicate the keys use, not a separate
      // `status === 'offline'` check — that check alone left the strip
      // bright on `'no-device'` while the transport glyphs already dimmed.
      dim: stale,
    }
  }

  async onKeyPress(index: number): Promise<PressOutcome> {
    // `interpolate(0)`, matching what this handler has always done: it needs the
    // playback FLAGS, not an interpolated position, and those do not depend on the
    // clock.
    const state = this.source.interpolate(0)

    // Key 7 advances the track. EVERY other key toggles playback — the six art
    // cells as well as the labelled play/pause on key 3 — so the control the user
    // asked for is always under a finger, wherever they press. Key 3 stays as the
    // discoverable, glyphed one.
    if (index === 7) {
      const ok = await this.source.next()
      return ok ? 'handled' : 'failed'
    }

    if (index < 0 || index > 6) return 'ignored'

    // Nothing loaded means nothing to toggle. The daemon still flashes the red
    // ring, so a press is never silently swallowed.
    if (!state) return 'ignored'

    const ok = state.isPlaying ? await this.source.pause() : await this.source.play()
    return ok ? 'handled' : 'failed'
  }
}


/**
 * The ONE staleness predicate for this whole page (I3). Every element that
 * dims — the two control keys, the strip, and the six album-art keys —
 * reads this same function, so they can no longer disagree the way `dead`
 * (which omitted `'offline'`) and the strip's own `status === 'offline'`
 * check used to.
 *
 * `!state` counts as stale too: nothing is loaded, so there is nothing valid
 * for a transport press to act on — matching the original `dead` formula's
 * treatment of that case. The six idle-animation art keys never reach this
 * predicate for their OWN dimming (an idle scene is not "stale data", it is
 * "no data"), but the control glyphs still need it while idle, exactly as
 * before.
 */
function isStale(status: SpotifyStatus, state: PlayerState | null): boolean {
  return status === 'no-device' || status === 'unauthorized' || status === 'offline' || !state
}


/**
 * Phase for the volume key's "thump", the same `nowMs`-driven pattern
 * `idleSpec` below uses for the idle animation: never `Date.now()`, so two
 * calls with the same `nowMs` always agree, and the phase actually advances

/** The control keys' background: the album's accent, heavily darkened. */
export function controlWash(accent: Rgb): Rgb {
  return [
    Math.round(accent[0] * CONTROL_WASH_FACTOR),
    Math.round(accent[1] * CONTROL_WASH_FACTOR),
    Math.round(accent[2] * CONTROL_WASH_FACTOR),
  ]
}

/**
 * The control glyphs' colour: the album's accent, lifted toward white until it is
 * bright enough to read against `controlWash`. A dark album would otherwise put a
 * dark glyph on a near-black wash.
 */
export function controlGlyphColor(accent: Rgb): Rgb {
  const lum = accent[0] + accent[1] + accent[2]
  if (lum >= CONTROL_GLYPH_MIN_LUM) return accent
  // Mix toward white by however much is missing, so the hue survives the lift.
  const t = Math.min(1, (CONTROL_GLYPH_MIN_LUM - lum) / (765 - lum))
  return [
    Math.round(accent[0] + (255 - accent[0]) * t),
    Math.round(accent[1] + (255 - accent[1]) * t),
    Math.round(accent[2] + (255 - accent[2]) * t),
  ]
}

/** The breathing phase for the play/pause glyph. Never `Date.now()` — the daemon
 * injects the clock, so two renders at one instant are identical. */
export function breathePhase(nowMs: number): number {
  if (!Number.isFinite(nowMs)) return 0
  return ((nowMs % BREATHE_PERIOD_MS) / BREATHE_PERIOD_MS) * 2 * Math.PI
}

/**
 * One art cell. `paused` dims the cover and puts an ambient layer beneath it, so
 * a glance says "paused" without reading a glyph.
 *
 * ONE function for all six cells, so the paused treatment cannot land on five of
 * them and be forgotten on the sixth — the family-drift defect this project calls
 * its dominant pattern.
 */
function artKey(
  art: Image,
  trackId: string,
  crop: ImageCrop,
  stale: boolean,
  paused: boolean,
  nowMs: number,
): KeySpec {
  const key: KeySpec = {
    kind: 'image',
    image: art,
    imageKey: trackId,
    imageCrop: crop,
    dim: stale,
  }
  if (paused) {
    // `dim` is what lets the layer show through: it drops the image to
    // `DIM_FACTOR` opacity, and the layer is drawn before the image.
    key.dim = true
    key.fx = {
      variant: PAUSED_FX_VARIANT,
      nowMs,
      intensity: PAUSED_FX_INTENSITY,
      // Seeded from the crop, so the six cells drift out of step with each other
      // instead of moving as one sheet.
      seed: Math.round(crop.sx * 100 + crop.sy * 10),
    }
  }
  return key
}

/**
 * Builds the idle-animation spec for one of the four idle art keys. `col`
 * and `row` (each 0 or 1) place this key at its own corner of the shared 2x2
 * design, and `nowMs` — never `Date.now()`, supplied by the daemon's render
 * clock — is what `render/canvas.ts` advances the animation from, so
 * `keyHash` sees a new value on every tick and the daemon keeps redrawing
 * (lesson 11 in docs/LESSONS.md: a field that never changes freezes the
 * animation after one frame).
 */
function idleSpec(nowMs: number, col: 0 | 1 | 2, row: 0 | 1): IdleSpec {
  return { variant: IDLE_VARIANT, nowMs, col, row }
}
