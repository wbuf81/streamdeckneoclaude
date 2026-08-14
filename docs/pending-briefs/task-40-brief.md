### Task 40: Football page — Gators and Jaguars schedules, with helmet art

The user's request, verbatim:

> "how about a screen that shows upcoming florida gator and jacksonville jaguar football
> schedules complete with helmet art and date and times kidna thing ?"

A sixth page. The page manager restores by name (lesson 19's fix), so adding a page is
safe — add it BEFORE `restorePage` per invariant 2, and expect every existing page to
render identically.

---

## Data sources — measured 2026-08-13, do not trust beyond what is stated

**ESPN's unofficial schedule API is BLOCKED from this machine.** Measured: HTTP 403
(Akamai "Access Denied") on `site.api.espn.com/.../teams/jax/schedule`, with plain curl
AND with full browser headers. Do not build on it without first proving Node's `fetch`
gets through (a different TLS fingerprint MIGHT pass — that is a hypothesis, not a fact;
one probe settles it). If it stays blocked, it is dead — do not retry-loop against a 403
(lesson 10).

**ESPN's logo CDN is OPEN.** Measured 200 with real PNGs:
- Gators: `https://a.espncdn.com/i/teamlogos/ncaa/500/57.png` (99 KB)
- Jaguars: `https://a.espncdn.com/i/teamlogos/nfl/500/jax.png` (79 KB)
These are logos, not literal helmets — good enough for tile art. Decode off the render
path with `await loadImage`, cache like album art, dim with `globalAlpha` (lesson 15).
500 px PNGs downscale to 96 px keys; render a preview to confirm legibility.

**TheSportsDB free tier WORKS** (`.../api/v1/json/3/eventsnext.php?id=<team>`), keyless
with the public test key `3`. **The trap, measured:** querying id `134938` — widely
listed online as the Jaguars — returned *Chicago Bears vs Cleveland Browns*. Team IDs
from the internet are wrong; resolve them yourself via `searchteams.php?t=...` and
record the verified IDs in `docs/VERIFIED-FACTS.md`. Unknowns to measure before design:
how many future events the free tier returns per call, whether NCAA college football
coverage includes Florida's full schedule, and the timezone of `strTime`.

If neither source covers the Gators' college schedule reliably, say so and propose the
narrowest honest alternative — a Jaguars-only page beats a page that lies about
kickoff times.

## Design sketch (adjust after measuring the data)

- Key 0: Gators logo tile. Keys 1–3: next three Gators games — opponent, date, kickoff.
- Key 4: Jaguars logo tile. Keys 5–7: next three Jaguars games.
- Strip: the nearest upcoming game of either team, with a countdown
  (`SAT 3:30 PM EDT · UF vs UGA`).
- All times through `formatEasternTime` (AGENTS.md convention) — verify the source's
  timezone by measurement first; a wrong-timezone kickoff is worse than none.
- Press a game tile → detail drill-down (venue, TV network if the data has it), BACK on
  key 7, same pattern as stocks/weather. Logo tiles and empty slots report `ignored`.
- Poll rarely — schedules change weekly, not hourly. Hours, not minutes, with the
  standard cooldown-on-failure. A past game must age out of the tiles the day after.

## Constraints

All the standing ones: AGENTS.md fix-brief rules, pages pure, `keyHash` covers new
fields, measured text budgets (opponent names run long — "Texas A&M", "Jacksonville"),
`log.once`, no test touches `~` or the network, break-the-fix proof on every new test.
Season note: college football and the NFL both start within weeks of this brief — bye
weeks and TBD kickoff times ("TBA") must render honestly as `TBA`, never as a fabricated
time (lesson 18).
