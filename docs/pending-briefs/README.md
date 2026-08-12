# Pending task briefs

These are the full specifications for the work that is not yet finished. They were written
in the SDD workspace under `.superpowers/`, which is **git-ignored**, so they are copied
here to survive.

Read them in this order — later ones depend on earlier ones:

| Brief | Task | Depends on |
| --- | --- | --- |
| `task-23-brief.md` | Make the Claude gauge row readable. Adds `lineSizes` to `KeySpec` and variable line advance. | nothing |
| `task-24-brief.md` | Fix the weather tiles: the emoji overlaps the text, the text is too small, plus a per-condition background tint. | Task 23's `lineSizes` |
| `task-22-brief.md` | Animate the Claude crabs. Adds `Page.tickMs` and `render(now, nowMs)`. Frames already extracted. | frames from Task 21, done |
| `task-16-brief.md` | Per-window terminal focus, and press feedback. | Task 22's faster tick |

`docs/PROJECT-STATE.md` records which of these were in progress when the briefs were
copied, and lists the deferred minor items that are not covered by any brief.

Every brief assumes you have read `docs/VERIFIED-FACTS.md` and `docs/LESSONS.md`.
