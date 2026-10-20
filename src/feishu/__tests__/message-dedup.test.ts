import { describe, it, expect } from "vitest"
import { Database } from "bun:sqlite"
import { MessageDedup } from "../message-dedup.js"

describe("MessageDedup", () => {
  it("de-duplicates by event id", () => {
    const db = new Database(":memory:")
    const dedup = new MessageDedup({ db })
    expect(dedup.isDuplicate("evt-1")).toBe(false)
    expect(dedup.isDuplicate("evt-1")).toBe(true)
    expect(dedup.isDuplicate("evt-2")).toBe(false)
  })

  it("de-duplicates by message id independently of the event id", () => {
    const db = new Database(":memory:")
    const dedup = new MessageDedup({ db })
    expect(dedup.isDuplicateMessage("msg-1")).toBe(false)
    expect(dedup.isDuplicateMessage("msg-1")).toBe(true)
    // a redelivery carries a new event id but the same message id
    expect(dedup.isDuplicate("evt-other")).toBe(false)
    expect(dedup.isDuplicateMessage("msg-1")).toBe(true)
    expect(dedup.isDuplicateMessage("msg-2")).toBe(false)
  })

  it("works on a database that already has the legacy message_dedup table", () => {
    // The event_id table has been called "message_dedup" from the start; the
    // message_id table must not reuse that name, or CREATE TABLE IF NOT EXISTS
    // silently keeps the old schema and every query fails at startup.
    const db = new Database(":memory:")
    db.exec(
      "CREATE TABLE message_dedup (event_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
    )
    const dedup = new MessageDedup({ db })
    expect(dedup.isDuplicateMessage("msg-1")).toBe(false)
    expect(dedup.isDuplicateMessage("msg-1")).toBe(true)
    expect(dedup.isDuplicate("evt-1")).toBe(false)
  })
})
