import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { loadConfig } from "../utils/config.js"

describe("config: opencode v2 fields", () => {
  const saved: Record<string, string | undefined> = {}
  const keys = [
    "FEISHU_APP_ID", "FEISHU_APP_SECRET",
    "OPENCODE_SERVER_URL", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD", "OPENCODE_CWD",
  ]

  beforeEach(() => {
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k] }
    process.env.FEISHU_APP_ID = "cli_test"
    process.env.FEISHU_APP_SECRET = "secret"
  })

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("reads OPENCODE_SERVER_* env vars into config.opencode", async () => {
    process.env.OPENCODE_SERVER_URL = "http://127.0.0.1:5096"
    process.env.OPENCODE_SERVER_PASSWORD = "pw"
    process.env.OPENCODE_SERVER_USERNAME = "opencode"
    process.env.OPENCODE_CWD = "/tmp/proj"
    const cfg = await loadConfig()
    expect(cfg.opencode?.url).toBe("http://127.0.0.1:5096")
    expect(cfg.opencode?.password).toBe("pw")
    expect(cfg.opencode?.username).toBe("opencode")
    expect(cfg.opencode?.cwd).toBe("/tmp/proj")
  })

  it("defaults when env vars are absent", async () => {
    const cfg = await loadConfig()
    expect(cfg.opencode?.url).toBe("http://127.0.0.1:4096")
    expect(cfg.opencode?.username).toBe("opencode")
    expect(cfg.opencode?.password).toBe("")
  })
})
