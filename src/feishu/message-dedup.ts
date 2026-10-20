/**
 * SQLite-backed message deduplication.
 * Caches event_id with a configurable TTL (default 60s).
 * Prevents processing the same Feishu event twice, surviving restarts.
 */

import { type Database, type Statement } from "bun:sqlite"
import { createLogger } from "../utils/logger.js"

const logger = createLogger("message-dedup")

interface MessageDedupOptions {
  db: Database
  ttlMs?: number
  /** TTL for message_id de-duplication (default 24h). */
  messageTtlMs?: number
}

export class MessageDedup {
  private readonly db: Database
  private readonly ttlMs: number
  private readonly messageTtlMs: number
  private readonly insertStmt: Statement
  private readonly checkStmt: Statement
  private readonly cleanupStmt: Statement
  private readonly insertMessageStmt: Statement
  private readonly checkMessageStmt: Statement
  private readonly cleanupMessageStmt: Statement
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: MessageDedupOptions) {
    this.db = options.db
    this.ttlMs = options.ttlMs ?? 60_000
    // A Feishu message is processed once, ever. The long TTL covers
    // reconnects and redeliveries that happen minutes later.
    this.messageTtlMs = options.messageTtlMs ?? 24 * 60 * 60 * 1000


    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_dedup (
        event_id   TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `)

    this.checkStmt = this.db.prepare(
      "SELECT event_id FROM message_dedup WHERE event_id = ?",
    )

    this.insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO message_dedup (event_id, created_at) VALUES (?, ?)",
    )

    this.cleanupStmt = this.db.prepare(
      "DELETE FROM message_dedup WHERE created_at < ?",
    )

    // NOTE: the event_id table above is already called "message_dedup" — this
    // one needs a different name or CREATE TABLE IF NOT EXISTS would silently
    // keep the old (event_id) schema.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feishu_message_dedup (
        message_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `)

    this.checkMessageStmt = this.db.prepare(
      "SELECT message_id FROM feishu_message_dedup WHERE message_id = ?",
    )

    this.insertMessageStmt = this.db.prepare(
      "INSERT OR IGNORE INTO feishu_message_dedup (message_id, created_at) VALUES (?, ?)",
    )

    this.cleanupMessageStmt = this.db.prepare(
      "DELETE FROM feishu_message_dedup WHERE created_at < ?",
    )


    this.cleanupTimer = setInterval(() => this.evictExpired(), 30_000)

    logger.info(`MessageDedup initialized (TTL: ${this.ttlMs}ms)`)
  }

  /**
   * Returns true if this event_id has been seen within the TTL window.
   * If not seen, registers it and returns false.
   */
  isDuplicate(eventId: string): boolean {

    this.evictExpired()

    const existing = this.checkStmt.get(eventId)
    if (existing) {
      logger.debug(`Duplicate event: ${eventId}`)
      return true
    }

    this.insertStmt.run(eventId, Date.now())
    return false
  }

  /**
   * Returns true if this Feishu message_id was already processed.
   *
   * Feishu's long connection redelivers events (at-least-once), and the
   * redelivery carries a NEW event_id, so event_id de-duplication misses it.
   * The message_id is stable, so it is the reliable identity of "the user sent
   * this once". The TTL is much longer because a message is never legitimately
   * processed twice.
   */
  isDuplicateMessage(messageId: string): boolean {
    if (!messageId) return false

    this.evictExpiredMessages()

    const existing = this.checkMessageStmt.get(messageId)
    if (existing) {
      logger.debug(`Duplicate message: ${messageId}`)
      return true
    }

    this.insertMessageStmt.run(messageId, Date.now())
    return false
  }

  private evictExpiredMessages(): void {
    const cutoff = Date.now() - this.messageTtlMs
    this.cleanupMessageStmt.run(cutoff)
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs
    const result = this.cleanupStmt.run(cutoff)
    if (result.changes > 0) {
      logger.debug(`Evicted ${result.changes} expired dedup entries`)
    }
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }
}
