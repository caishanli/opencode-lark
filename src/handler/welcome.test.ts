import { describe, it, expect, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWelcomeStore } from "./welcome.js"

describe("createWelcomeStore", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function makeFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "welcome-test-"))
    dirs.push(dir)
    return join(dir, "nested", "welcome.json")
  }

  it("greets a chat once", () => {
    const file = makeFile()
    const store = createWelcomeStore(file, "cli_a")

    expect(store.shouldWelcome("oc_1")).toBe(true)
    expect(store.shouldWelcome("oc_1")).toBe(false)
    expect(store.shouldWelcome("oc_2")).toBe(true)

    // still remembered after a restart
    const again = createWelcomeStore(file, "cli_a")
    expect(again.shouldWelcome("oc_1")).toBe(false)
    expect(again.shouldWelcome("oc_3")).toBe(true)
  })

  it("greets every chat again after the Feishu app changed", () => {
    const file = makeFile()
    const before = createWelcomeStore(file, "cli_a")
    before.shouldWelcome("oc_1")

    const after = createWelcomeStore(file, "cli_b")
    expect(after.shouldWelcome("oc_1")).toBe(true)
  })

  it("survives a broken file", () => {
    const file = makeFile()
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "{not json")
    const store = createWelcomeStore(file, "cli_a")
    expect(store.shouldWelcome("oc_1")).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf-8")).appId).toBe("cli_a")
  })
})
