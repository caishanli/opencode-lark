import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Database } from "bun:sqlite"
import { createSessionManager } from "./session-manager.js"
import type { SessionManager } from "./session-manager.js"
import { createMockGateway } from "../__tests__/setup.js"

const DEFAULT_AGENT = "claude"
const CWD = "/test/project"

function createTestDb(): Database {
  return new Database(":memory:")
}

describe("session-manager", () => {
  let db: Database
  let sm: SessionManager
  let savedOpencodeCwd: string | undefined

  beforeEach(() => {
    db = createTestDb()
    savedOpencodeCwd = process.env.OPENCODE_CWD
    process.env.OPENCODE_CWD = CWD
  })

  afterEach(() => {
    db.close()
    if (savedOpencodeCwd === undefined) delete process.env.OPENCODE_CWD
    else process.env.OPENCODE_CWD = savedOpencodeCwd
  })

  describe("getOrCreate", () => {
    it("discovers existing TUI session and returns its ID", async () => {
      const tuiSessionId = "ses-tui-abc"
      const listSessions = vi.fn().mockResolvedValue([
        {
          id: tuiSessionId,
          title: "TUI Session",
          location: { directory: CWD },
          time: { created: 1000, updated: 2000 },
        },
      ])
      const getSession = vi.fn().mockResolvedValue({ id: tuiSessionId })
      const gateway = createMockGateway({ listSessions, getSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-1")

      expect(result).toBe(tuiSessionId)

      // Discovery must query the configured working directory
      expect(listSessions).toHaveBeenCalledWith({ directory: CWD })
      // Validation must check the discovered session
      expect(getSession).toHaveBeenCalledWith(tuiSessionId)
      // Should not create a new session when one is discovered
      expect(gateway.createSession).not.toHaveBeenCalled()

      // Verify is_bound = 1 for discovered session
      const mapping = sm.getSession("chat-1")
      expect(mapping).not.toBeNull()
      expect(mapping!.is_bound).toBe(1)
      expect(mapping!.session_id).toBe(tuiSessionId)
    })

    it("falls back to createSession when no sessions exist", async () => {
      const createdSessionId = "ses-new-123"
      const listSessions = vi.fn().mockResolvedValue([])
      const createSession = vi.fn().mockResolvedValue({ id: createdSessionId })
      const gateway = createMockGateway({ listSessions, createSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-2")

      expect(result).toBe(createdSessionId)
      expect(listSessions).toHaveBeenCalledWith({ directory: CWD })
      expect(createSession).toHaveBeenCalledWith({
        title: "Feishu chat chat-2",
        directory: CWD,
      })

      // Verify is_bound = 0 for created session
      const mapping = sm.getSession("chat-2")
      expect(mapping).not.toBeNull()
      expect(mapping!.is_bound).toBe(0)
    })

    it("reuses cached session without any API call", async () => {
      const tuiSessionId = "ses-cached-xyz"
      const listSessions = vi.fn().mockResolvedValue([
        {
          id: tuiSessionId,
          title: "TUI",
          location: { directory: CWD },
          time: { created: 1, updated: 2 },
        },
      ])
      const getSession = vi.fn().mockResolvedValue({ id: tuiSessionId })
      const gateway = createMockGateway({ listSessions, getSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })

      // First call — triggers discovery
      await sm.getOrCreate("chat-3")
      const callsAfterFirst =
        listSessions.mock.calls.length + getSession.mock.calls.length
      expect(callsAfterFirst).toBeGreaterThan(0)

      // Second call — should use DB cache, no new gateway calls
      const result = await sm.getOrCreate("chat-3")
      expect(result).toBe(tuiSessionId)
      expect(listSessions.mock.calls.length + getSession.mock.calls.length).toBe(
        callsAfterFirst,
      )
      expect(gateway.createSession).not.toHaveBeenCalled()
    })

    it("sets is_bound=1 for discovered sessions, is_bound=0 for created", async () => {
      const listSessions = vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "ses-discovered",
            title: "TUI",
            location: { directory: CWD },
            time: { created: 1, updated: 2 },
          },
        ])
        .mockResolvedValueOnce([])
      const getSession = vi.fn().mockResolvedValue({ id: "ses-discovered" })
      const createSession = vi.fn().mockResolvedValue({ id: "ses-created" })
      const gateway = createMockGateway({
        listSessions,
        getSession,
        createSession,
      })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })

      // Run where a live session is discovered
      await sm.getOrCreate("chat-discovered")
      const discovered = sm.getSession("chat-discovered")
      expect(discovered!.is_bound).toBe(1)
      expect(discovered!.session_id).toBe("ses-discovered")

      // Run where nothing is discovered → session gets created
      await sm.getOrCreate("chat-created")
      const created = sm.getSession("chat-created")
      expect(created!.is_bound).toBe(0)
      expect(created!.session_id).toBe("ses-created")
    })

    it("falls back to createSession silently when listSessions fails", async () => {
      const createdId = "ses-fallback-456"
      const listSessions = vi.fn().mockRejectedValue(new Error("Internal Server Error"))
      const createSession = vi.fn().mockResolvedValue({ id: createdId })
      const gateway = createMockGateway({ listSessions, createSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-fail")

      // Should not throw, should fall back to createSession
      expect(result).toBe(createdId)
      expect(createSession).toHaveBeenCalledWith({
        title: "Feishu chat chat-fail",
        directory: CWD,
      })

      const mapping = sm.getSession("chat-fail")
      expect(mapping!.is_bound).toBe(0)
    })

    it("falls back to createSession when listSessions throws network error", async () => {
      const createdId = "ses-net-err"
      const listSessions = vi.fn().mockRejectedValue(new Error("Network error"))
      const createSession = vi.fn().mockResolvedValue({ id: createdId })
      const gateway = createMockGateway({ listSessions, createSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-neterr")

      expect(result).toBe(createdId)
      expect(createSession).toHaveBeenCalledTimes(1)
      expect(sm.getSession("chat-neterr")!.is_bound).toBe(0)
    })
  })

  describe("cleanup", () => {
    it("does not break with is_bound column", () => {
      sm = createSessionManager({ opencode: createMockGateway(), db, defaultAgent: DEFAULT_AGENT })
      // Just verify cleanup still works
      const result = sm.cleanup(0)
      expect(result).toBe(0)
    })
  })

  describe("migration", () => {
    it("adds is_bound column to existing table without errors", () => {
      // Pre-create the old schema
      db.exec(`
        CREATE TABLE IF NOT EXISTS feishu_sessions (
          feishu_key  TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          agent       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          last_active INTEGER NOT NULL
        )
      `)

      // Should not throw — ALTER TABLE in try/catch
      sm = createSessionManager({ opencode: createMockGateway(), db, defaultAgent: DEFAULT_AGENT })
      expect(sm).toBeDefined()
    })

    it("handles already-migrated table gracefully", () => {
      // Create table with is_bound already present
      db.exec(`
        CREATE TABLE IF NOT EXISTS feishu_sessions (
          feishu_key  TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          agent       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          last_active INTEGER NOT NULL,
          is_bound    INTEGER DEFAULT 0
        )
      `)

      // Second createSessionManager should not throw even though column exists
      sm = createSessionManager({ opencode: createMockGateway(), db, defaultAgent: DEFAULT_AGENT })
      expect(sm).toBeDefined()
    })
  })

  describe("discoverTuiSession validation", () => {
    it("skips discovered session that returns 404 from server", async () => {
      const createdSessionId = "ses-created-after-stale"
      const listSessions = vi.fn().mockResolvedValue([
        {
          id: "ses-stale",
          title: "Old TUI",
          location: { directory: CWD },
          time: { created: 1, updated: 2 },
        },
      ])
      // getSession returns null → the session 404s on the server
      const getSession = vi.fn().mockResolvedValue(null)
      const createSession = vi.fn().mockResolvedValue({ id: createdSessionId })
      const gateway = createMockGateway({
        listSessions,
        getSession,
        createSession,
      })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-stale-discover")

      // Should have fallen through to createSession
      expect(result).toBe(createdSessionId)
      expect(sm.getSession("chat-stale-discover")!.is_bound).toBe(0)
    })

    it("accepts discovered session that returns 200 from server", async () => {
      const tuiSessionId = "ses-valid-tui"
      const listSessions = vi.fn().mockResolvedValue([
        {
          id: tuiSessionId,
          title: "Valid TUI",
          location: { directory: CWD },
          time: { created: 1, updated: 2 },
        },
      ])
      const getSession = vi.fn().mockResolvedValue({ id: tuiSessionId })
      const gateway = createMockGateway({ listSessions, getSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-valid-discover")

      expect(result).toBe(tuiSessionId)
      expect(sm.getSession("chat-valid-discover")!.is_bound).toBe(1)
    })
  })

    it("accepts discovered session when getSession throws (conservative — non-404)", async () => {
      const tuiSessionId = "ses-500-tui"
      const listSessions = vi.fn().mockResolvedValue([
        {
          id: tuiSessionId,
          title: "TUI",
          location: { directory: CWD },
          time: { created: 1, updated: 2 },
        },
      ])
      // A 500 (or any non-404) surfaces as a thrown error from the gateway
      const getSession = vi.fn().mockRejectedValue(new Error("Internal Server Error"))
      const gateway = createMockGateway({ listSessions, getSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-500-discover")

      // Non-404 errors should be treated conservatively as "exists" — session accepted, not skipped
      expect(result).toBe(tuiSessionId)
      expect(sm.getSession("chat-500-discover")!.is_bound).toBe(1)
    })

  describe("validateAndCleanupStale", () => {
    it("removes mappings whose sessions return 404", async () => {
      const getSession = vi.fn(async (sessionID: string) => {
        if (sessionID === "ses-alive") return { id: "ses-alive" }
        return null // 404 → does not exist
      })
      const gateway = createMockGateway({ getSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })

      // Manually insert mappings
      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-alive", "ses-alive", "claude", now, now, 1)
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-dead", "ses-dead", "claude", now, now, 1)

      const cleaned = await sm.validateAndCleanupStale()

      expect(cleaned).toBe(1)
      expect(sm.getSession("key-alive")).not.toBeNull()
      expect(sm.getSession("key-dead")).toBeNull()
    })

    it("preserves all mappings when all sessions are valid", async () => {
      const getSession = vi.fn().mockResolvedValue({ id: "ses-1" })
      const gateway = createMockGateway({ getSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })

      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-1", "ses-1", "claude", now, now, 1)

      const cleaned = await sm.validateAndCleanupStale()
      expect(cleaned).toBe(0)
      expect(sm.getSession("key-1")).not.toBeNull()
      expect(getSession).toHaveBeenCalledWith("ses-1")
    })

    it("returns 0 when no mappings exist", async () => {
      const getSession = vi.fn()
      const gateway = createMockGateway({ getSession })
      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })
      const cleaned = await sm.validateAndCleanupStale()
      expect(cleaned).toBe(0)
      expect(getSession).not.toHaveBeenCalled()
    })

    it("skips mappings when server is unreachable (network error)", async () => {
      const getSession = vi.fn().mockRejectedValue(new Error("Network error"))
      const gateway = createMockGateway({ getSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })

      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-1", "ses-1", "claude", now, now, 1)

      const cleaned = await sm.validateAndCleanupStale()
      // Network errors should NOT cause cleanup — mapping preserved
      expect(cleaned).toBe(0)
      expect(sm.getSession("key-1")).not.toBeNull()
    })

    it("preserves mappings when server returns 500 (not treated as missing)", async () => {
      const getSession = vi.fn(async (sessionID: string) => {
        if (sessionID === "ses-500") throw new Error("Internal Server Error")
        return { id: sessionID }
      })
      const gateway = createMockGateway({ getSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })

      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-500", "ses-500", "claude", now, now, 1)
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-ok", "ses-ok", "claude", now, now, 1)

      const cleaned = await sm.validateAndCleanupStale()

      // 500 should NOT be treated as "not exists" — mapping preserved
      expect(cleaned).toBe(0)
      expect(sm.getSession("key-500")).not.toBeNull()
      expect(sm.getSession("key-ok")).not.toBeNull()
    })

    it("preserves mappings when server returns 429 (rate limited)", async () => {
      const getSession = vi.fn().mockRejectedValue(new Error("Too Many Requests"))
      const gateway = createMockGateway({ getSession })

      sm = createSessionManager({ opencode: gateway, db, defaultAgent: DEFAULT_AGENT })

      const now = Date.now()
      db.prepare(
        "INSERT INTO feishu_sessions (feishu_key, session_id, agent, created_at, last_active, is_bound) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("key-rl", "ses-rl", "claude", now, now, 1)

      const cleaned = await sm.validateAndCleanupStale()

      expect(cleaned).toBe(0)
      expect(sm.getSession("key-rl")).not.toBeNull()
    })
  })
})
