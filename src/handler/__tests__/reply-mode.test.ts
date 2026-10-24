import { describe, it, expect } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReplyModeStore } from "../reply-mode.js"

describe("ReplyModeStore", () => {
  it("defaults to standard and survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "reply-mode-"))
    const file = join(dir, "reply-mode.json")
    try {
      const store = new ReplyModeStore(file)
      expect(store.get("chat-1")).toBe("standard")

      store.set("chat-1", "concise")

      const reloaded = new ReplyModeStore(file)
      expect(reloaded.get("chat-1")).toBe("concise")
      expect(reloaded.get("chat-2")).toBe("standard")
      expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ "chat-1": "concise" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
