### Task 25: Stock detail drill-down

The user's request, verbatim:

> "when I push one of the eight stock buttons it pulls up more detail details about
> each stock it makes a new screen that uses the eight tiles to show detailed stock
> information just for that stock with maybe like a bottom left button or bottom right
> you pick with like a little backer road that takes me back to all the stocks"

So: press a ticker on the stocks grid, get eight tiles of detail for that one symbol, and
a BACK key that returns to the grid. **Back goes on key 7, the bottom right.**

**Files:** `src/sources/stocks.ts`, `src/pages/stocks-page.ts`, `src/render/specs.ts`,
`src/render/canvas.ts`, `src/render/text.ts`, plus their tests. Append the new measurements
to `docs/VERIFIED-FACTS.md`.

---

## Approach: keep it inside `StocksPage`. Do NOT change `PageManager`.

The detail view is a **mode of the stocks page**, not a fifth page. `StocksPage` holds
`selected: string | null`:

- `render()` branches: a selected symbol renders the detail layout, otherwise the grid.
- `onKeyPress(i)` branches: with nothing selected, key `i` selects the symbol shown at key
  `i`; with a symbol selected, key 7 clears the selection and keys 0 to 6 do nothing.
- `onLeave()` clears the selection, so the page always reopens on the grid. That is
  predictable, and the round buttons keep working exactly as they do today.

**Do not touch `src/page-manager.ts` or `bin/deckd.ts`.** Adding a page would break the
`restorePage` ordering invariant documented in `docs/PROJECT-STATE.md`, and it is not
needed.

Selecting a key with no quote behind it does nothing — the grid can hold fewer than eight
symbols, and an empty key must not enter a detail view for a symbol that does not exist.

---

## The data — every field below is VERIFIED present, measured on TSLA

Probed live from `https://query1.finance.yahoo.com/v8/finance/chart/TSLA?range=1d&interval=5m`
with `User-Agent: Mozilla/5.0`. Real values shown:

| `meta` field | Value |
| --- | --- |
| `regularMarketPrice` | `327.51` |
| `previousClose` | `332.81` |
| `regularMarketDayHigh` | `335.5` |
| `regularMarketDayLow` | `323.64` |
| `fiftyTwoWeekHigh` | `498.83` |
| `fiftyTwoWeekLow` | `297.38` |
| `regularMarketVolume` | `27695899` |
| `longName` | `"Tesla, Inc."` |
| `fullExchangeName` | `"NasdaqGS"` |

Add these to `Quote` as `dayHigh`, `dayLow`, `week52High`, `week52Low` and `volume`, each
`number | null`, parsed with the **existing `numberOrNull` helper**. Every one can be
absent, and **absent must render as `--`, never as `0`**. That rule already exists in this
codebase for `probabilityOfPrecipitation`; follow it.

Do not add `longName`, `fullExchangeName` or anything else the layout below does not use.
YAGNI.

**Do not fetch a second endpoint.** Everything comes from the response the source already
requests, so the detail view costs no extra network call and works while the market is shut.

---

## Layout

```
┌─────────┬─────────┬─────────┬─────────┐
│ TSLA    │ ▼ 1.59% │ DAY     │ 52 WK   │
│ 327.51  │ -5.30   │ 335.50  │ 498.83  │
│         │         │ 323.64  │ 297.38  │
├─────────┴─────────┴─────────┼─────────┤
│  wide intraday chart        │  ◀ BACK │
│  spanning keys 4, 5 and 6   │         │
└─────────────────────────────┴─────────┘
```

- **Key 0** — symbol, then price.
- **Key 1** — change percent with the existing trend arrow, then the change in currency.
  Both carry the existing trend colour: green up, red down, gray flat or unknown.
- **Key 2** — label `DAY`, then the day high and the day low.
- **Key 3** — label `52 WK`, then the 52-week high and the 52-week low.
- **Keys 4, 5, 6** — one intraday chart, drawn across all three.
- **Key 7** — `◀ BACK`. Give it a visibly different look from the data tiles so it does not
  read as data: a border in `theme.gray` and no trend colour is enough.

Reuse the grid's existing helpers for the arrow, the trend, the trend colour and the price
formatting. Do not write second copies of them.

### The wide chart

`SparkSpec` is drawn procedurally by `drawSpark` in `src/render/canvas.ts`, so this needs
**no image machinery at all**. Extend `SparkSpec` with an optional slice:

```ts
/** Draws one horizontal slice of a chart that spans `count` keys. */
slice?: { index: number; count: number }
```

`drawSpark` lays the series out across `count` key widths and draws only the slice belonging
to `index`. Absent `slice`, the existing single-key behaviour must be **byte-identical** —
the grid page depends on it. Prove that with a before-and-after hash, the way Task 23 proved
`lineSizes`.

The physical gaps between keys mean the curve loses a sliver at each boundary. That is
expected and acceptable; the Spotify album art already spans four keys the same way.

**`keyHash` must include `slice`.** All three keys share one series, so without it two of
the three slices would never redraw. This is lesson 11 in `docs/LESSONS.md`, and it is the
exact defect that hit the Spotify 2×2 art.

---

## Text must be MEASURED to fit. This is the part most likely to go wrong.

Usable width is **81 px** per key. From `docs/VERIFIED-FACTS.md`, a 24 px font advances
14.45 px per character, so a six-character price like `327.51` needs 86.7 px and **does not
fit at 24 px**. `NOW` trades near $1000, so seven characters occur in practice.

Add a helper to `src/render/text.ts` that picks the **largest size from a candidate list
that actually measures within the budget**, and use it for the price and the change:

```ts
export function fitSize(text: string, candidates: number[], maxWidth: number): number
```

Measure with canvas, exactly as every other layout number in this project was measured. Do
not compute widths from the advance table — that table is a guide, not an oracle.

**Required test:** for all eight real symbols (`TSLA MSFT NVDA NOW SOFI HIMS SPCX AMZN`),
with prices spanning at least `9.99`, `327.51` and `1234.56`, assert every rendered line
fits inside the usable width. A clipped price is the failure this task must not ship, and it
has already happened twice in this project.

---

## Also fold in: per-symbol staleness

`StockSource.isSymbolStale(symbol)` was added in commit `5c6f7d0` and **nothing consumes
it**. Add it to the `StockReader` interface and use it to dim a single lagging ticker on the
grid, instead of the current whole-source `isStale()` dimming every tile at once. Dim the
detail view the same way when its own symbol is stale.

Keep `isStale()` working and keep using it where a source-wide failure really is source-wide.

---

## Constraints

- ESM only, no `require(` in `src/`, `bin/`, `scripts/`. Strict TypeScript with
  `noUncheckedIndexedAccess`. Imports use `.js`.
- Pages stay **pure**: no canvas, no HID, no `Date.now()`. The daemon supplies both clocks.
- A page must never throw from `render` or `onKeyPress`.
- `log.once` on any repeating path. Never `log.warn` there. A log call must never throw.
- The other three pages must render **identically**. Hash a key from each before and after.
- No test may open the device, do real network I/O, or touch any path under `~`.
- Prose in ASD-STE100 Simplified Technical English: short sentences, active voice, present
  tense.
- Read `docs/VERIFIED-FACTS.md` and `docs/LESSONS.md` first. Lessons 11, 14 and 17 apply.
