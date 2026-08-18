import { describe, it, expect } from 'vitest'
import { SpotifyPage } from '../../src/pages/spotify-page.js'
import { StocksPage } from '../../src/pages/stocks-page.js'
import { WeatherPage } from '../../src/pages/weather-page.js'
import type { PlayerReader } from '../../src/pages/spotify-page.js'
import type { StockReader } from '../../src/pages/stocks-page.js'
import type { WeatherReader } from '../../src/pages/weather-page.js'
import type { DayForecast } from '../../src/sources/weather.js'
import type { Page } from '../../src/pages/types.js'

/**
 * Task 22 gave `Page` an optional `tickMs`, defaulting to 1000 ms when a page
 * never sets it. Stocks updates every five minutes and has no reason to
 * animate, so it should never declare `tickMs` at all. A future edit that
 * accidentally added it would raise the render rate for no benefit and would
 * slip past a type check, since `tickMs` is optional; this test is the guard.
 *
 * Two pages are exceptions, each covered separately below, and each raising
 * its rate ONLY while something is actually moving:
 *
 * - Spotify (task 27, then 39): a cyberpunk idle animation across its four
 *   album-art keys, shown only while nothing is playing.
 * - Weather (task 42): an ambient effect behind every day tile, chosen by that
 *   tile's own forecast condition and frozen whenever the forecast is stale,
 *   offline, or absent.
 *
 * Weather used to be asserted here as a page that never animates. That
 * assertion could not simply be deleted: the invariant it guarded still
 * matters, it just changed shape, from "never raises its rate" to "raises its
 * rate only while an effect actually shows". Note that the old test would
 * still PASS unchanged against the new page, because its fake reader returns
 * no days — which is exactly the frozen case. A passing test that no longer
 * covers the shipped behaviour is lesson 22's shape, so it was rewritten
 * rather than left green.
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

})

/**
 * WeatherPage's condition effects (task 42) need a faster tick only while they
 * are actually moving. A stale, offline, or empty forecast freezes every
 * effect, so a faster clock would buy nothing there — and `tickMs` reads the
 * same `isDimmed` decision `render` uses, so the declared rate cannot disagree
 * with what the frame actually draws.
 */
describe('WeatherPage tickMs: fast only while a condition effect shows', () => {
  const aDay = {
    label: 'NOW', id: 'NOW', emoji: '🌧', high: 80, low: 70,
    precipPercent: 60, shortForecast: 'Rain', day: null, night: null,
  } as unknown as DayForecast

  function fakeReader(over: Partial<WeatherReader> = {}): WeatherReader {
    return {
      getDays: () => [aDay],
      getConditions: () => null,
      getStatus: () => 'ok',
      getLastUpdatedAt: () => 0,
      getPlace: () => 'x',
      isStale: () => false,
      setVisible: () => {},
      ...over,
    } as unknown as WeatherReader
  }

  it('raises the rate while a fresh forecast is showing', () => {
    const page: Page = new WeatherPage(fakeReader())
    expect(page.tickMs).toBeDefined()
    expect(page.tickMs!).toBeLessThan(1000)
  })

  it('keeps the default 1000 ms tick when no data has arrived', () => {
    const page: Page = new WeatherPage(fakeReader({ getDays: () => [] }))
    expect(page.tickMs).toBeUndefined()
  })

  it('keeps the default 1000 ms tick when the forecast is stale, since the effects freeze', () => {
    const page: Page = new WeatherPage(fakeReader({ isStale: () => true }))
    expect(page.tickMs).toBeUndefined()
  })

  it('keeps the default 1000 ms tick when the source is offline', () => {
    const page: Page = new WeatherPage(fakeReader({ getStatus: () => 'offline' }))
    expect(page.tickMs).toBeUndefined()
  })

  it('re-reads the source every time, rather than fixing the rate at construction', () => {
    // The daemon re-reads `tickMs` on every tick and re-arms its timer when it
    // changes, so this must follow the data rather than snapshot it.
    let stale = false
    const page: Page = new WeatherPage(fakeReader({ isStale: () => stale }))
    expect(page.tickMs).toBeDefined()
    stale = true
    expect(page.tickMs).toBeUndefined()
    stale = false
    expect(page.tickMs).toBeDefined()
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
