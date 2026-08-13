import { describe, it, expect } from 'vitest'
import { SpotifyPage } from '../../src/pages/spotify-page.js'
import { StocksPage } from '../../src/pages/stocks-page.js'
import { WeatherPage } from '../../src/pages/weather-page.js'
import type { PlayerReader } from '../../src/pages/spotify-page.js'
import type { StockReader } from '../../src/pages/stocks-page.js'
import type { WeatherReader } from '../../src/pages/weather-page.js'

/**
 * Task 22 gave `Page` an optional `tickMs`, defaulting to 1000 ms when a page
 * never sets it. These three pages have no reason to animate — Spotify's own
 * player-position interpolation already reads `now` in whole seconds, stocks
 * update every five minutes, and weather every fifteen — so none of them
 * should declare `tickMs` at all. A future edit that accidentally added it
 * here would raise their render rate for no benefit and would slip past a
 * type check, since `tickMs` is optional; this test is the guard.
 *
 * Minimal fakes stand in for each page's reader: only construction and the
 * `tickMs` property matter here, not the rendered content.
 */
describe('pages that must keep the default 1000 ms render interval', () => {
  it('SpotifyPage declares no tickMs', () => {
    const fake = {
      interpolate: () => null,
      getStatus: () => 'no-token',
      getArt: () => null,
      isSaved: () => null,
      setVisible: () => {},
    } as unknown as PlayerReader
    const page = new SpotifyPage(fake)
    expect(page.tickMs).toBeUndefined()
  })

  it('StocksPage declares no tickMs', () => {
    const fake = {
      getQuotes: () => new Map(),
      getStatus: () => 'ok',
      getMarketState: () => 'closed',
      isSymbolStale: () => false,
      setVisible: () => {},
    } as unknown as StockReader
    const page = new StocksPage(fake)
    expect(page.tickMs).toBeUndefined()
  })

  it('WeatherPage declares no tickMs', () => {
    const fake = {
      getDays: () => [],
      getConditions: () => null,
      getStatus: () => 'ok',
      getPlace: () => 'x',
      isStale: () => false,
      setVisible: () => {},
    } as unknown as WeatherReader
    const page = new WeatherPage(fake)
    expect(page.tickMs).toBeUndefined()
  })
})
