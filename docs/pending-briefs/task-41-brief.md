### Task 41: System stats page — CPU, memory, disk, network, battery

The user's request, verbatim:

> "what if we also added a page as like a system stats kinda of thing that showed cpu and
> ram ssd % or usage that kinda thing what would people wana to see for system stats"

A seventh page. **The bar is high:** the user already runs `Stats.app` (measured — it was
the third-largest CPU consumer while probing). This page must beat a dedicated stats app
at a glance, or it is decoration. The thing that beats it: **naming the culprit.**
`CPU 89%` makes you wonder; `CPU 89% — Chrome Helper` makes you act.

---

## Measured on this machine, 2026-08-14, no sudo. Trust these; re-measure rather than reason.

**Three of the four obvious metrics are traps on macOS.**

### CPU — from Node, no shelling out
`os.cpus()` gives per-core `times` (user/nice/sys/idle/irq). CPU percent needs a **delta
between two samples**; a single sample cannot produce one. **The first sample after start
must render unknown, never `0%`** (lesson 18 — a fabricated zero is this project's most
repeated defect). Machine has **18 cores**, **52 GB** RAM.

### Memory — "% free" is MEANINGLESS here
macOS deliberately uses all free memory as cache. Measured: `memory_pressure` reports
`System-wide memory free percentage: 84%` on a machine under real load. The signals that
actually mean something:
- `memory_pressure` (no sudo) — also prints a cumulative `Pageouts:` count (137265 here).
- `sysctl -n vm.swapusage` → `total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)`.
  **Swap actually in use is the "why is my Mac slow" signal.** Zero here, so a healthy
  baseline looks like zero — design for that, do not assume non-zero.

### Disk — `df /` LIES
Measured: `df -H /` reports **2% used** on a 995 GB drive, because that is the sealed
*system* volume. The real number is the data volume:
`df -H /System/Volumes/Data` → **995G total, 133G used, 838G free, 14% used**.
`diskutil info /` also gives `Container Free Space: 837.9 GB`. **Use the Data volume or
the container. Never `/`.**

### Battery — works, and has a state that looks like a fault but is not
`pmset -g batt` (no sudo) → `Now drawing from 'AC Power'` and
`80%; AC attached; not charging`. That last state is macOS optimised charging, **not** a
problem — do not colour it as an alert. States to handle: AC + charging, AC + not
charging (normal), discharging with a time estimate, and **no battery at all** (a desktop
Mac — the tile must degrade, not show `0%`).

### Load — unreadable without the core count
`os.loadavg()` gave `3.00 / 2.19 / 1.73` while agents ran, and `1.11` idle. On **18
cores** a load of 1.11 is ~6% busy. **Normalise by `os.cpus().length`** or the number
means nothing to a human.

### Network — cumulative, and the rows DUPLICATE
`netstat -ib` gives per-interface cumulative `Ibytes`/`Obytes`. **Measured trap:** `en0`
appears on **multiple rows** (a `<Link#15>` row and an `fe80:` inet6 row) with identical
byte counts. Parsing every matching row double-counts. Dedupe by interface name, taking
the `Link#` row. Deltas between polls give throughput. Primary interface here is `en0`.

### Temperature and fans — NOT AVAILABLE. Do not attempt.
Measured: `powermetrics --samplers smc -n 1` → `unrecognized sampler: smc` (that sampler
was Intel-only), and `powermetrics` requires sudo regardless. Every stats page wants
temps; this one cannot have them without a privileged helper, which is out of scope.
**Say so in a comment** so nobody re-attempts it as an obvious addition.

### Top processes — `ps` works, but `comm` is a FULL PATH
`ps -Ao pcpu,rss,comm -r` (CPU-sorted) and `ps -Ao pmem,rss,comm -m` (memory-sorted),
both without sudo. **Measured trap:** `comm` returns the entire executable path — one real
line was ~250 characters
(`.../Microsoft Teams WebView Helper (Renderer).app/Contents/MacOS/...`). Take the
**basename**, and note even basenames like `Microsoft Teams WebView Helper (Renderer)`
blow the **81 px** key budget, so measure and shrink (declare candidate sizes; the
renderer measures — pages never do).

---

## Design

```
┌──────────┬──────────┬──────────┬──────────┐
│ CPU 34%  │ MEM      │ DISK     │ NET      │
│ ▁▂▅▃▂    │ NORMAL   │ 838G     │ ↓2.1M/s  │
│          │ swap 0   │ free     │ ↑0.3M/s  │
├──────────┼──────────┼──────────┼──────────┤
│ BATTERY  │ LOAD     │ TOP CPU  │ TOP MEM  │
│ 80% AC   │ 6%       │ Chrome   │ Xcode    │
│ holding  │ 18 cores │ 41%      │ 4.2G     │
└──────────┴──────────┴──────────┴──────────┘
```

- Strip: uptime, or the worst active condition when something is wrong.
- **Press CPU or MEM → a top-five-processes drill-down**, `◀ BACK` on key 7 — the exact
  mode-of-the-page pattern `stocks-page.ts` and `weather-page.ts` already use and test.
  Copy it; consistency between the three drill-downs matters more than novelty.
- The CPU tile carries a **sparkline** of recent samples (`SparkSpec` exists and is
  tested). Keep the history in the SOURCE, not the page — pages are pure.
- **Alert colours**, reusing the weather page's heat-colour treatment: disk under 10%
  free, swap actually in use, memory pressure not normal, battery discharging. This page's
  real job is catching the eye when something is wrong.

## Poll rates — the page measures itself

The daemon appears in its own top-process list. Spawning `ps`, `pmset`, `netstat` and
`memory_pressure` every second would make this page a meaningful CPU consumer that then
reports its own consumption. Suggested, adjust with measurement: `os`-module metrics
(CPU, load, uptime) every ~2 s since they cost nothing; the shelled reads every ~5–10 s;
disk every ~60 s since it barely moves. **Poll only while the page is visible**, like the
other sources. State the chosen rates and the reasoning in comments.

## Constraints

Everything standing in `AGENTS.md` — especially the fix-brief and review-loop rules. Plus:

- New source follows the **family disciplines** the sources review established: injected
  command runner and clock, explicit one-way `stopped` latch, whole-snapshot change key,
  cooldown on failure (never a `finally`-cleared guard), `log.once` with `clearOnce` on
  recovery, deep-enough copy-on-read, and absent data as **null**, never a fabricated
  number.
- Page pure: no canvas, no `Date.now()`, no shelling out, no mutation in `render()`.
- Press outcomes truthful for every key in both modes.
- Any new `KeySpec` field must be in `keyHash`, proven by a test.
- No test may touch any path under `~`, run a real command, or hit the network — inject
  the runner and feed it captured real output (the measured strings above are the
  fixtures; `sqlite3 -json`'s zero-row surprise is why fixtures must come from reality).
- Every new test: break the fix, watch it fail, restore.
- Prose in ASD-STE100 Simplified Technical English.
