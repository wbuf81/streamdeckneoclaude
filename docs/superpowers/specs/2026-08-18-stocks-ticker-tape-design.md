# Stocks ticker tape — design

Date: 2026-08-18. Status: approved direction, not yet implemented.

## Goal

The strip crawls a stock tape: `TSLA 92.30 ▼1.10% · MSFT 101.33 ▲0.19% · …`,
each symbol coloured by its own direction. It is the most iconic "this is a
stock board" signal there is, and the strip is the deck's most wasted surface.

## Why the motion is different here

The weather effects and the heat wash freeze when their data is not live, because
their motion is decoration — it carries nothing the still frame does not.

**A tape's motion carries the content.** The strip fits about 30 characters; the
tape is roughly 145. If it stops, seven of the eight symbols become unreachable.
So the tape scrolls whenever there are quotes to show, and staleness is expressed
in colour and in line 1's timestamp, never by stopping.

This is a deliberate exception, not an inconsistency, and it is the reason it is
written down.

## The renderer addition

`StripSpec` gains one optional field:

```ts
export interface TapeSegment {
  text: string
  /** Absent takes the default strip text colour. */
  color?: Rgb
}

export interface TapeSpec {
  segments: readonly TapeSegment[]
  /**
   * How far the tape has scrolled, in pixels, increasing without bound. The
   * RENDERER wraps it, because only the renderer can measure the tape's real
   * width. A page therefore never needs font metrics to scroll a tape.
   */
  offsetPx: number
}
```

`StripSpec.tape` is **opt-in**. Absent, `renderStrip` is byte-identical to
before the field existed — the same discipline `KeySpec.fx` follows, and what
keeps every other page's strip proof valid.

Drawing rules:

- The tape occupies **line 2's band only**. When `tape` is set, line 2's text is
  not drawn; `lines[0]` still draws normally, so the market state and the as-of
  timestamp stay put.
- The tape draws inside a **clip rectangle** covering its own band. A clip makes
  it impossible for the tape to paint over line 1, over the bar, or outside the
  strip — impossible by construction rather than by careful arithmetic
  (lesson 21).
- When `right` is also set, the clip excludes `right`'s gutter, so the two can
  coexist instead of one silently overwriting the other.
- Segments are joined by a separator and repeated as many times as needed to
  cover the clip width, so the wrap seam is never visible. A tape narrower than
  the strip still fills it.
- `offsetPx` passes through `sanitizeStripSpec`, like every other numeric field,
  because a non-finite value reaching `fillText` or a clip is not survivable.

## The page side

- `tapeOffsetPx(nowMs, pxPerSec)` is a pure exported function. Speed is a page
  decision; the renderer stays mechanical.
- One segment per symbol: `SYMBOL price ▲change%`, coloured by `trendOf` — the
  same call the tile border, the change line and the heat wash already use, so
  all four agree about direction.
- A per-symbol stale quote takes the dim colour for its own segment. One lagging
  ticker never dims the whole tape, matching how the tiles already behave.
- No tape when the source is offline or no quote has arrived. Line 2 keeps its
  current text in that case, so an offline board still says so.
- `StocksPage.tickMs` becomes a getter returning a fast tick only while a tape
  is showing, exactly as `WeatherPage.tickMs` and `SpotifyPage.tickMs` do.
  `tests/pages/tick-rate.test.ts` currently asserts that `StocksPage` declares
  no `tickMs`; that assertion changes shape rather than being deleted, and it
  must not be left passing by accident against an empty fake reader — the trap
  the weather change already walked into.

## Rate and cost

The strip was measured at **1218 writes per second** (`docs/VERIFIED-FACTS.md`),
so it is not the constraint. A 50 ms tick is 20 strip writes per second.

Scroll speed and the resulting loop length get tuned against a rendered preview,
not guessed. At 13 px Menlo the eight segments plus separators measure roughly
1130 px, so the loop takes about 35 seconds at 32 px per second. If reading the
whole board takes too long, the price comes out of each segment before the speed
goes up — an unreadable tape is worse than a slow one.

## Testing

1. Absent `tape`, `renderStrip` output is byte-identical.
2. The tape paints in line 2's band and line 1 still draws.
3. Nothing is painted outside the clip: line 1's band and the bar's band are
   untouched at every offset, including offsets far past one full loop.
4. The seam is invisible: at every offset across a full loop, the clip width is
   covered — no background gap.
5. Advancing `offsetPx` moves the tape, and equal offsets render identically.
6. `offsetPx` wraps: an offset one full loop on renders identically to the
   original. Proven by finding the loop width from the renderer, not by assuming
   it.
7. A non-finite `offsetPx` renders a full strip buffer rather than aborting.
8. Per-segment colour reaches the glass: an up segment and a down segment differ.
9. A stale symbol's segment dims without dimming the rest.
10. Offline and empty keep the existing line 2 and no tape.
11. `tickMs` is fast only while a tape shows, and undefined otherwise.
12. A single segment, and an empty segment list, both render safely.

Every new test gets the break-the-fix check.

## Preview

Two sheets, because one distribution hides defects:

- A tape at several offsets across one full loop, to judge speed and the seam.
- The same at every market state and in the offline case.

Both go to the user before deployment.

## Out of scope

- Any change to the tiles, the heat wash, or the breadth lights.
- The directional drift effect, still deferred.
- A tape on any other page's strip. This ships on stocks only.
