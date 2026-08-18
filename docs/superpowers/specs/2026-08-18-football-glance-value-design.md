# Football page glance value — design

Date: 2026-08-18. Status: approved by the user, not yet implemented.

## Scope

Five changes, all free of new network requests. The live-scoreboard work is a
separate piece, because it alone changes how the source polls.

## 1. Team colour, from the crest itself

`dominantColor` already exists (task 44) and each team's logo is already decoded
in the source. Extract the accent from the RAW crest — not the composited one,
whose reserved bottom band is flat `theme.bg` — once per team, at load time, and
cache it beside the image. `getTeamColor(team)` exposes it.

It themes the logo tile's border, the three next-game tiles' borders, the strip
accent, and the two round buttons.

**This is the one page where the two round buttons should differ.** Every other
page shows one board-level signal, so two colours would read as two unrelated
controls. Here the deck genuinely splits by row — Gators on top, Jaguars beneath —
so the left light takes the Gators' colour and the right the Jaguars'.

`null` is a real answer for a crest with no usable accent, and the page falls
back to the theme rather than inventing a hue.

## 2. Record as a heat wash

The logo tile's background leans green above .500 and red below, neutral at
.500, from `wins - losses`. It saturates at `RECORD_SATURATION_GAMES` so a 12-0
season and a 6-0 one look equally emphatic.

An absent record draws no wash at all — never a neutral-looking fabrication.

### One blend function, not two

The stocks page already has `blendToward`. A second copy here is exactly the
family drift this project calls its dominant defect, so the arithmetic moves to
`render/theme.ts` as `blend(from, to, fraction)` and BOTH pages call it. The
stocks tests already pin its behaviour, so the refactor is covered as it lands.

## 3. Countdown warmth on the next-game tiles

Each upcoming tile warms as kickoff approaches: nothing a week out, ramping to
full on game day, and staying full through a game-length window after kickoff so
a game in progress reads as hot rather than instantly going cold.

`kickoffWarmth(kickoffEpochMs, nowMs)` is pure and exported. A TBD kickoff
(`kickoffEpochMs === null`) yields 0 — an unknown time is not a countdown.

This is the stocks heat pattern with time as the signal instead of price.

## 4. A schedule ticker tape on the strip

`TapeSpec` already exists (task 43). The strip crawls the next several games
across BOTH teams in date order, each segment carrying the team's short code and
its own colour:

```
GATORS SEP 6 vs LSU  ·  JAGS SEP 7 @ IND  ·  GATORS SEP 13 @ UT  ·  …
```

Capped at `TAPE_GAME_COUNT` segments so the loop stays short enough to watch;
the existing text line 1 stays above it, so the nearest game is still readable
without waiting for the tape.

No tape when there are no upcoming games — line 2 keeps its current message.

## 5. Per-game win and loss, which ESPN already sends

**Measured on 2026-08-18:** each competitor in the event payload carries
`winner: true | false` **inline**. Scores and the game clock are `$ref` links
needing separate fetches, but the result costs nothing — and `parseEvent`
currently throws it away.

`Game` gains `result: 'win' | 'loss' | null`:

- my competitor `winner: true` → `'win'`
- the opponent `winner: true` → `'loss'`
- neither → `null`

`null` therefore covers both "not played yet" and a genuine tie, because the
inline flags cannot tell those apart. That is honest and documented; the season
tie count remains available on `TeamRecord`. A tie renders as no result rather
than as a guess.

The drill-down schedule then tints each played tile green or red, so the season's
shape reads at a glance.

## Testing

1. The team colour is extracted from the RAW crest, once per team, off the
   render path — proven by a fake that counts calls across many renders.
2. A crest with no usable accent falls back to the theme.
3. The two round buttons carry DIFFERENT colours, one per team, and the left one
   matches the top row's team.
4. The record wash leans the right way either side of .500, saturates, and is
   absent for an unknown record.
5. `blend` is shared: the stocks page's existing heat tests still pass unchanged.
6. `kickoffWarmth` is monotonic approaching kickoff, full through the game
   window, zero a week out, zero for a TBD kickoff, and zero long after.
7. The tape lists both teams in date order, colours each segment by team, caps
   its length, and is absent when nothing is upcoming.
8. `parseEvent` reads `result` from real captured payload shapes — a win, a loss,
   and an undecided game — built from the real API's field layout, not invented
   fixtures.
9. A played tile is tinted by result in the drill-down; an unplayed one is not.
10. Every existing guarantee: staleness dimming, the TBD kickoff text, the
    schedule window, and BACK.

Every new test gets the break-the-fix check.

## Preview

A contact sheet on more than one situation, since one hides defects: a week out,
game day, a game in progress, a winning record, a losing record, an unknown
record, and the drill-down with wins and losses mixed.

## Out of scope

- Scores, the live clock, and any faster polling. Separate piece.
- `FxSpec.color` and team-coloured drift. That belongs with the live work, which
  is what earns it a second consumer.
