import { describe, it, expect } from 'vitest'
import { SpotifyPage } from '../../src/pages/spotify-page.js'
import { StocksPage } from '../../src/pages/stocks-page.js'
import { WeatherPage } from '../../src/pages/weather-page.js'
import type { PlayerReader } from '../../src/pages/spotify-page.js'
import type { StockReader } from '../../src/pages/stocks-page.js'
import type { WeatherReader } from '../../src/pages/weather-page.js'
import type { Page } from '../../src/pages/types.js'

/**
 * Task 22 gave `Page` an optional `tickMs`, defaulting to 1000 ms when a page
 * never sets it. Stocks (updates every five minutes) and weather (every
 * fifteen) still have no reason to animate, so neither should declare
 * `tickMs` at all. A future edit that accidentally added it here would raise
 * their render rate for no benefit and would slip past a type check, since
 * `tickMs` is optional; this test is the guard.
 *
 * Spotify is the exception, covered separately below: task 27 gave it an
 * idle equaliser animation across its four album-art keys, shown only while
 * nothing is playing, so it now DOES raise its tick rate — but only then.
 *
 * Minimal fakes stand in for each page's reader: only construction and the
 * `tickMs` property matter here, not the rendered content.
 */
describe('pages that must keep the default 1000 ms render interval', () => {
  it('StocksPage declares no tickMs', () => {
    const fake = {
      getQuotes: () => new Map(),
      getStatus: () => 'ok',
      getMarketState: () => 'closed',
      isSymbolStale: () => false,
      setVisible: () => {},
    } as unknown as StockReader
    // Typed as `Page`, not the concrete class (I8): `StocksPage` correctly
    // never declares `tickMs` at all, since it is optional on `Page` and
    // this page has no reason to animate — but that means the CONCRETE
    // class type has no such member for `tsc` to see, even though reading
    // it through the interface (exactly how the daemon does) is fine.
    const page: Page = new StocksPage(fake)
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
    const page: Page = new WeatherPage(fake)
    expect(page.tickMs).toBeUndefined()
  })
})

/**
 * SpotifyPage's idle equaliser (task 27) needs a faster tick only while it
 * is actually showing — a still album-art image gains nothing from a faster
 * clock, and the device's render interval is the only throughput constraint
 * (docs/VERIFIED-FACTS.md). So `tickMs` here is a getter, re-read every time
 * the page becomes current, rather than a fixed value like the other pages'.
 */
describe('SpotifyPage tickMs: fast only while the idle animation shows', () => {
  function fakeReader(over: Partial<PlayerReader>): PlayerReader {
    return {
      interpolate: () => null,
      getStatus: () => 'ok',
      getArt: () => null,
      play: async () => true,
      pause: async () => true,
      next: async () => true,
      previous: async () => true,
      setVolume: async () => true,
      setVisible: () => {},
      ...over,
    } as unknown as PlayerReader
  }

  it('keeps the default 1000 ms tick while a track is loaded, playing or paused', () => {
    const fake = fakeReader({ interpolate: () => ({} as never), getStatus: () => 'ok' })
    const page = new SpotifyPage(fake)
    expect(page.tickMs).toBeUndefined()
  })

  it('raises the tick rate while nothing is playing', () => {
    const fake = fakeReader({ interpolate: () => null, getStatus: () => 'no-device' })
    const page = new SpotifyPage(fake)
    expect(page.tickMs).toBeDefined()
    expect(page.tickMs!).toBeLessThan(1000)
  })

  it('keeps the default 1000 ms tick while unauthorized, since key 0 shows text, not the animation', () => {
    const fake = fakeReader({ interpolate: () => null, getStatus: () => 'unauthorized' })
    const page = new SpotifyPage(fake)
    expect(page.tickMs).toBeUndefined()
  })
})
