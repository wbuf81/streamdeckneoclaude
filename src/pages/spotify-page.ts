import type { DeckFrame, KeySpec, StripSpec, ImageCrop } from '../render/specs.js'
import { blankKey } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate, formatClock } from '../render/text.js'
import type { Image } from '@napi-rs/canvas'
import type { Page } from './types.js'
import type { PlayerState, SpotifyStatus } from '../sources/spotify.js'

const VOLUME_STEP = 10
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
  /** True when saved, false when not, null when unknown. */
  isSaved(): boolean | null
  play(): Promise<boolean>
  pause(): Promise<boolean>
  next(): Promise<boolean>
  setVolume(percent: number): Promise<boolean>
  /** Toggles the saved state of the current track. Returns true on success. */
  toggleSaved(): Promise<boolean>
  setVisible(visible: boolean): void
}

export class SpotifyPage implements Page {
  readonly name = 'spotify'

  constructor(private readonly source: PlayerReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.source.setVisible(false)
  }

  render(now: number): DeckFrame {
    const state = this.source.interpolate(now)
    const status = this.source.getStatus()
    const dead = status === 'no-device' || status === 'unauthorized' || !state
    const art = state ? this.source.getArt(state.trackId, state.artUrl) : null

    return {
      keys: [
        this.primaryArtKey(state, status, art, CROP_TOP_LEFT),
        this.spanArtKey(state, art, CROP_TOP_RIGHT),
        { kind: 'control', glyph: state?.isPlaying ? '❙❙' : '▶', dim: dead },
        { kind: 'control', glyph: '▶▶', dim: dead },
        this.spanArtKey(state, art, CROP_BOTTOM_LEFT),
        this.spanArtKey(state, art, CROP_BOTTOM_RIGHT),
        this.heartKey(dead),
        { kind: 'control', lines: ['VOL +', volumeLabel(state)], align: 'center', dim: dead },
      ],
      strip: this.strip(state, status),
      buttons: [theme.gray, theme.gray],
    }
  }

  /**
   * Key 0. Carries the top-left quadrant when art is available, and is the
   * ONLY key that shows a fallback while art is missing or the source is
   * unusable — a partial image across the 2x2 block is worse than none.
   */
  private primaryArtKey(
    state: PlayerState | null,
    status: SpotifyStatus,
    art: Image | null,
    crop: ImageCrop,
  ): KeySpec {
    if (status === 'unauthorized') {
      return { kind: 'control', lines: ['SPOTIFY', 'SIGN IN'], align: 'center', dim: true }
    }
    if (!state) {
      return { kind: 'control', lines: ['SPOTIFY', '—'], align: 'center', dim: true }
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

  /** Keys 1, 4 and 5. Blank whenever key 0 would show a fallback, so the
   * block never shows three quadrants of art beside one line of text. */
  private spanArtKey(state: PlayerState | null, art: Image | null, crop: ImageCrop): KeySpec {
    if (!state || !art) return blankKey()
    return { kind: 'image', image: art, imageKey: state.trackId, imageCrop: crop }
  }

  /**
   * Key 6. Filled and red when saved, outline when not, and a dim outline
   * when the saved state is unknown (not yet fetched, or the token lacks the
   * library scopes). This is the one place colour earns its keep on this
   * page, because the art supplies everything else. There is no play count:
   * Spotify exposes none, and a locally-derived one would look like a
   * Spotify statistic without being one.
   */
  private heartKey(dead: boolean): KeySpec {
    const saved = this.source.isSaved()
    if (saved === true) {
      return { kind: 'control', glyph: '♥', glyphColor: theme.red, dim: dead }
    }
    if (saved === false) {
      return { kind: 'control', glyph: '♡', dim: dead }
    }
    // Unknown: dim regardless of `dead`, since there is nothing to act on.
    return { kind: 'control', glyph: '♡', dim: true }
  }

  private strip(state: PlayerState | null, status: SpotifyStatus): StripSpec {
    if (status === 'unauthorized') {
      return { lines: ['spotify not connected', 'run: deckd auth spotify'], dim: true }
    }
    if (!state) {
      return { lines: ['spotify', 'nothing playing'], dim: true }
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
        await this.source.next()
        return
      case 6:
        await this.source.toggleSaved()
        return
      case 7:
        await this.source.setVolume(volume + VOLUME_STEP)
        return
      default:
        // Keys 0, 1, 4 and 5 (the album art) do nothing, and so does any
        // other index. Previous-track, shuffle and repeat are gone: the
        // user named play/pause, next and favourite as what they use, and
        // an unused key invites a misfire.
        return
    }
  }
}

function volumeLabel(state: PlayerState | null): string {
  if (!state || state.volumePercent === null) return '—'
  return `${state.volumePercent}%`
}
