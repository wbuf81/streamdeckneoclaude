import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate, formatClock } from '../render/text.js'
import type { Image } from '@napi-rs/canvas'
import type { Page } from './types.js'
import type { PlayerState, SpotifyStatus, RepeatMode } from '../sources/spotify.js'

const VOLUME_STEP = 10
const TITLE_CHARS = 34

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
  toggleShuffle(): Promise<boolean>
  cycleRepeat(): Promise<boolean>
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

    return {
      keys: [
        this.artKey(state, status),
        { kind: 'control', glyph: '◀◀', dim: dead },
        { kind: 'control', glyph: state?.isPlaying ? '❙❙' : '▶', dim: dead },
        { kind: 'control', glyph: '▶▶', dim: dead },
        { kind: 'control', lines: ['VOL −'], align: 'center', dim: dead },
        { kind: 'control', lines: ['VOL +'], align: 'center', dim: dead },
        { kind: 'control', lines: ['SHUFFLE', state?.shuffle ? 'on' : 'off'], dim: dead },
        { kind: 'control', lines: ['REPEAT', repeatLabel(state?.repeat ?? 'off')], dim: dead },
      ],
      strip: this.strip(state, status),
      buttons: [theme.gray, theme.gray],
    }
  }

  private artKey(state: PlayerState | null, status: SpotifyStatus): KeySpec {
    if (status === 'unauthorized') {
      return { kind: 'control', lines: ['SPOTIFY', 'SIGN IN'], align: 'center', dim: true }
    }
    if (!state) {
      return { kind: 'control', lines: ['SPOTIFY', '—'], align: 'center', dim: true }
    }
    const art = this.source.getArt(state.trackId, state.artUrl)
    if (art) {
      return { kind: 'image', image: art, imageKey: state.trackId }
    }
    // The art downloads in the background. Show the album name meanwhile.
    return { kind: 'control', lines: ['NOW', truncate(state.album, 10)], align: 'center' }
  }

  private strip(state: PlayerState | null, status: SpotifyStatus): StripSpec {
    if (status === 'unauthorized') {
      return { lines: ['spotify not connected', 'run: deckd auth spotify'], dim: true }
    }
    if (!state) {
      return { lines: ['spotify', 'nothing playing'], dim: true }
    }

    const headline = truncate(
      state.artist ? `${state.artist} — ${state.title}` : state.title,
      TITLE_CHARS,
    )
    const fraction = state.durationMs > 0 ? state.positionMs / state.durationMs : 0

    return {
      lines: [headline, ''],
      right: `${formatClock(state.positionMs / 1000)} / ${formatClock(state.durationMs / 1000)}`,
      bar: { value: fraction, color: theme.green },
      dim: status === 'offline',
    }
  }

  async onKeyPress(index: number): Promise<void> {
    const state = this.source.interpolate(Math.floor(Date.now() / 1000))
    const volume = state?.volumePercent ?? 50

    switch (index) {
      case 0:
        return // The art key does nothing.
      case 1:
        await this.source.previous()
        return
      case 2:
        await (state?.isPlaying ? this.source.pause() : this.source.play())
        return
      case 3:
        await this.source.next()
        return
      case 4:
        await this.source.setVolume(volume - VOLUME_STEP)
        return
      case 5:
        await this.source.setVolume(volume + VOLUME_STEP)
        return
      case 6:
        await this.source.toggleShuffle()
        return
      case 7:
        await this.source.cycleRepeat()
        return
      default:
        return
    }
  }
}

function repeatLabel(mode: RepeatMode): string {
  return mode === 'context' ? 'all' : mode
}
