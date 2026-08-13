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
    const live = new Set(sessions.map((s) => s.sessionId))

    for (let i = 0; i < SESSION_SLOTS; i++) {
      const id = this.slots[i]!
      if (id !== null && !live.has(id)) this.slots[i] = null
    }

    const held = new Set(this.slots.filter((v): v is string => v !== null))
    const waiting = sessions
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
