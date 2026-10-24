/**
 * Remembers that a turn was interrupted on purpose, so the streaming bridge
 * keeps the card open instead of closing it as "已中断".
 *
 * A mid-turn message is admitted as a steer input and then the execution is
 * interrupted with `resume=true`: opencode continues the same turn with the
 * new message. The bridge must not treat that interruption as the end of the
 * turn.
 */

const pending = new Map<string, number>()
const TTL_MS = 60_000

export function markSteering(sessionId: string): void {
  pending.set(sessionId, Date.now())
}

export function consumeSteering(sessionId: string): boolean {
  const markedAt = pending.get(sessionId)
  if (markedAt === undefined) return false
  pending.delete(sessionId)
  return Date.now() - markedAt <= TTL_MS
}
