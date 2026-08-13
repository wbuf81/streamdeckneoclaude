import type { Session } from '../sources/claude.js'

/**
 * Task 26 dedicated key 3 to a permanent crab mascot tile, so only three
 * keys are left for live sessions. A fourth live session is intentionally
 * invisible rather than rotating or shrinking in — see the task brief.
 */
export const SESSION_SLOTS = 3

export interface Assignment {
  /** Session id per key, index 0 to 2. `null` means the key is free. */
  slots: (string | null)[]
  /** Live sessions that got no key. */
  overflow: number
}

/**
 * Holds a session on its key. The deck must not reshuffle while the user reads
 * it, so a live session never moves. One algorithm covers the first call and
 * every later call:
 *
 *   1. Free a slot when its session is gone.
 *   2. Collect the sessions with no slot, newest `ts` first.
 *   3. Give each one the lowest free slot.
 *
 * On the first call every slot is free, so step 3 fills by `ts` order. That is
 * the spec's start rule, with no special case.
 */
export class KeyAssigner {
  private slots: (string | null)[] = new Array(SESSION_SLOTS).fill(null)

  assign(sessions: Session[]): Assignment {
    // M2 — a stray or copied session-state file can produce two entries
    // that share one `sessionId`: `ClaudeSource.getSessions` (see
    // `sources/claude.ts`) takes the id from each file's CONTENTS, not its
    // name, so nothing on disk stops two files from claiming the same id.
    // The `live` Set two lines below already assumes ids are unique — an
    // un-deduped input let one session occupy two slots (measured:
    // `[x(ts 3), x(ts 2), y(ts 1)]` returned `slots: ['x', 'x', 'y']`),
    // which both wastes a slot a real second session could have used and
    // double-counts the duplicate in `ClaudePage.strip`'s `${live.length}
    // active`. Deduped by id here, keeping whichever entry has the newest
    // `ts`, before anything else in this method runs.
    const bySessionId = new Map<string, Session>()
    for (const s of sessions) {
      const existing = bySessionId.get(s.sessionId)
      if (!existing || s.ts > existing.ts) bySessionId.set(s.sessionId, s)
    }
    const deduped = [...bySessionId.values()]

    const live = new Set(deduped.map((s) => s.sessionId))

    for (let i = 0; i < SESSION_SLOTS; i++) {
      const id = this.slots[i]!
      if (id !== null && !live.has(id)) this.slots[i] = null
    }

    const held = new Set(this.slots.filter((v): v is string => v !== null))
    const waiting = deduped
      .filter((s) => !held.has(s.sessionId))
      .sort((a, b) => b.ts - a.ts)

    let placed = 0
    for (const session of waiting) {
      const free = this.slots.indexOf(null)
      if (free === -1) break
      this.slots[free] = session.sessionId
      placed += 1
    }

    return { slots: [...this.slots], overflow: waiting.length - placed }
  }
}
