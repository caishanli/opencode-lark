/**
 * Messages that arrived while the agent was still running.
 *
 * They are not queued in the opencode inbox: the user gets a card asking
 * whether to interrupt the current turn, queue this one, or drop it. The
 * entry holds the continuation so the card's button can deliver it later,
 * with the full streaming-bridge wiring.
 */

import { randomUUID } from "node:crypto"

export type PendingPromptChoice = "interrupt" | "queue" | "cancel"

export interface PendingPrompt {
  id: string
  chatId: string
  sessionId: string
  /** A short safe-to-show version of the message. */
  preview: string
  createdAt: number
  onChoose: (choice: PendingPromptChoice) => Promise<void>
}

export interface PendingPromptStore {
  add(entry: Omit<PendingPrompt, "id" | "createdAt">): PendingPrompt
  get(id: string): PendingPrompt | undefined
  /** Remove and return the entry (a card button can be clicked twice). */
  take(id: string): PendingPrompt | undefined
  list(): PendingPrompt[]
  close(): void
}

const DEFAULT_TTL_MS = 10 * 60_000
const CLEANUP_INTERVAL_MS = 60_000

export function createPendingPromptStore(ttlMs = DEFAULT_TTL_MS): PendingPromptStore {
  const entries = new Map<string, PendingPrompt>()

  const cleanup = (now = Date.now()): void => {
    for (const [id, entry] of entries) {
      if (now - entry.createdAt > ttlMs) entries.delete(id)
    }
  }
  const timer = setInterval(() => cleanup(), CLEANUP_INTERVAL_MS)
  timer.unref?.()

  return {
    add(entry) {
      cleanup()
      const pending: PendingPrompt = {
        ...entry,
        id: randomUUID(),
        createdAt: Date.now(),
      }
      entries.set(pending.id, pending)
      return pending
    },
    get(id) {
      cleanup()
      return entries.get(id)
    },
    take(id) {
      cleanup()
      const entry = entries.get(id)
      if (entry) entries.delete(id)
      return entry
    },
    list() {
      cleanup()
      return [...entries.values()]
    },
    close() {
      clearInterval(timer)
      entries.clear()
    },
  }
}
