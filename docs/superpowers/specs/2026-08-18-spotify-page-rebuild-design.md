# Spotify page rebuild — design

Date: 2026-08-18. Status: approved by the user, not yet implemented.

## Brief

The user's words: they are not attached to anything on the page, they want to
**play and pause** and **see the album art**. Everything else is free.

They chose the big-art layout and all three extras.

## Layout

Six keys of album art, two keys of controls:

```
cols →   0     1     2     3
       ┌─────┬─────┬─────┬─────┐
row 0  │ art   art   art │ ▶/⏸ │   keys 0 1 2 | 3
       ├     ART 3×2     ├─────┤
row 1  │ art   art   art │  ⏭  │   keys 4 5 6 | 7
       └─────┴─────┴─────┴─────┘
```

Art grows from 192×192 to **288×192**. Play/pause is key 3, next is key 7.

**Every art key also toggles play/pause**, so seven of the eight keys do it and
the control is always under a finger. Key 3 stays as the labelled, discoverable
one.

Dropped: previous, volume, and the volume "thump". The user asked for play/pause
and art; these are the cost of the bigger art, and they said so explicitly.

### The art is SQUARE, and the region is 3:2

Album art is 640×640. A 3-keys-wide by 2-keys-tall region is 3:2. Slicing a
square source into six `1/3 × 1/2` rects would hand each key a 213×320 source
rect to draw into a 96×96 key — a vertical squash on every tile.

So the page takes the **central 3:2 slice** of the square cover first, and then
divides THAT into six squares:

- Source y runs from `1/6` to `5/6`, giving a 3:2 region.
- Each key crops `sx = col/3`, `sw = 1/3`, `sy = 1/6 + row/3`, `sh = 1/3`.
- Every one of those source rects is square, so nothing distorts.

The cost is the top and bottom sixth of the cover. Album covers are
centre-weighted, so this is the right trade for a full-bleed image — but it can
crop text on covers that put the artist name at the very top or bottom. A
letterboxed alternative (whole cover, background bars either side) is a
one-constant change if the user prefers it after seeing real covers.

## Album-colour theming

The dominant colour of the current cover themes the page: the control keys'
borders, the strip's progress bar, and the strip accent.

`dominantColor(img)` lives in `src/render/canvas.ts`, which already owns every
canvas operation and every pixel probe. It downscales the cover to a small
square, buckets the pixels coarsely, and picks the most common bucket that is
not near-black, near-white, or nearly grey — an average would come out muddy on
almost every cover.

It runs **once per track, off the render path**, inside `SpotifySource.loadArt`
right after `loadImage` resolves, and is cached beside the decoded image and
evicted with it. The render loop never decodes and never measures pixels.

A cover with no usable colour (a greyscale sleeve, say) yields `null`, and the
page falls back to its existing theme colour. Never a fabricated hue.

## Progress bar on the strip

`StripSpec.bar` already exists and this page has never used one. The strip gains
a bar showing `positionMs / durationMs`, coloured by the album colour.

The existing text clock stays: the bar is for glancing, the clock for reading.

## Paused looks paused

When a track is loaded but paused, the art dims and an ambient effect shows
**through** it.

This works because of the existing draw order: `renderKey` paints the background,
then the `fx` layer, then the image — and `dim` applies to the image through
`globalAlpha` at `DIM_FACTOR`. A 45-percent-opaque cover therefore lets 55
percent of the layer beneath it show. No renderer change is needed at all.

The variant is `fog`, slow and colourless, which reads as suspended rather than
as broken. Playing shows the cover at full brightness with no layer.

## The matrix rain has to keep working across three columns

The user's very first request in this whole project was the falling-glyph idle
animation. It must survive the layout change.

`IdleSpec.col` is currently `0 | 1`. It becomes `0 | 1 | 2`:

- `drawIdleRain` seeds per key and is independent per tile, so a third column
  needs only the wider type. Its key index becomes `row * 3 + col`.
- `drawIdleGrid` and `drawIdleGlitch` draw one shared scene sized to a 2×2
  block. They **clamp** `col` to at most 1 internally, so a future switch of
  `IDLE_VARIANT` degrades to a repeated column instead of a broken scene. The
  harm is made impossible rather than merely undocumented (lesson 21).
- `sanitizeKeySpec` coerces `col` to 0, 1 or 2.

## Testing

1. The six art crops tile the central 3:2 region exactly, with no gap and no
   overlap, and every source rect is square — proven arithmetically from the
   crops the page emits, not from a comment.
2. All six art keys share one `imageKey` and differ only by crop, so the
   dirty-key check still updates each of them (lesson 11's exact case).
3. Pressing any art key reports `handled` and toggles playback; key 3 does too;
   key 7 advances the track.
4. `dominantColor` is deterministic, picks a vivid colour over a muddy average,
   returns null for greyscale and for near-black covers, and never throws on a
   1×1 or empty image.
5. The colour is computed once per track, off the render path — proven by a fake
   that counts calls across many renders.
6. The strip's bar tracks position, stays inside 0 to 1, and disappears when
   there is no duration.
7. Paused dims the art AND attaches a layer; playing does neither.
8. The idle rain differs across all six art keys, so no two tiles animate alike.
9. `grid` and `glitch` never receive a column beyond 1.
10. Every existing guarantee this page already has: the offline freeze, staleness
    dimming, the unauthorised message, and the no-device case.

Every new test gets the break-the-fix check.

## Preview

Contact sheets before deployment, on more than one input, because one hides
defects:

- A colourful cover, a dark cover, a greyscale cover, and a cover with text at
  the very top — to judge both the crop and the extracted colour.
- Playing and paused, plus the nothing-playing idle across all six keys.

## Out of scope

- Volume control and the previous-track button. Dropped by the user's choice.
- Seeking. The source has no seek method, and adding one is separate work.
- Shuffle and repeat. No key is left for them in this layout.
- Any tempo or beat synchronisation. There is no audio capture, and Spotify's
  audio-features endpoint is deprecated for new applications — a faked beat
  would be a fabricated reading.
