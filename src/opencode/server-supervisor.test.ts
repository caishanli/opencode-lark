import { describe, it, expect, vi, beforeEach } from "vitest"
import { rmSync, readFileSync, existsSync } from "node:fs"
import { createServerSupervisor } from "./server-supervisor.js"
import { createMockGateway, createMockLogger } from "../__tests__/setup.js"

const PID_FILE = "/tmp/opencode/supervisor-test.pid"
/** A pid that does not exist — the tests must never signal a real process. */
const FAKE_PID = 999_999

function makeSupervisor(
  overrides: {
    up?: boolean
    active?: Record<string, { type: string }>
    idleTimeoutMs?: number
    checkIntervalMs?: number
  } = {},
) {
  const gateway = createMockGateway()
  const spawned: Array<{ command: string; args: string[] }> = []
  const logger = createMockLogger()

  let up = overrides.up ?? false
  ;(gateway.ping as ReturnType<typeof vi.fn>).mockImplementation(async () => {
    if (!up) throw new Error("connection refused")
  })
  ;(gateway.activeStatuses as ReturnType<typeof vi.fn>).mockImplementation(async () =>
    overrides.active ?? {},
  )

  const supervisor = createServerSupervisor({
    command: "opencode",
    args: ["serve", "--port", "5096"],
    pidFile: PID_FILE,
    idleTimeoutMs: overrides.idleTimeoutMs ?? 30 * 60_000,
    checkIntervalMs: overrides.checkIntervalMs ?? 50,
    opencode: gateway,
    logger,
    spawnProcess: (command, args) => {
      spawned.push({ command, args })
      up = true
      return { pid: FAKE_PID, unref: () => {} }
    },
  })

  return { supervisor, gateway, spawned, logger, isUp: () => up, setUp: (v: boolean) => (up = v) }
}

describe("server supervisor", () => {
  beforeEach(() => {
    rmSync(PID_FILE, { force: true })
  })

  it("does nothing when the server already answers", async () => {
    const { supervisor, spawned } = makeSupervisor({ up: true })

    expect(await supervisor.ensureRunning()).toBe(true)
    expect(spawned).toHaveLength(0)
  })

  it("starts the server when it is down and remembers its pid", async () => {
    const { supervisor, spawned } = makeSupervisor()

    expect(await supervisor.ensureRunning()).toBe(true)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toBe("opencode")
    expect(Number(readFileSync(PID_FILE, "utf-8"))).toBe(FAKE_PID)
  })

  it("starts the server only once for a burst of requests", async () => {
    const { supervisor, spawned } = makeSupervisor()

    await Promise.all([supervisor.ensureRunning(), supervisor.ensureRunning()])
    expect(spawned).toHaveLength(1)
  })

  it("stops the server when it has been idle for too long", async () => {
    const { supervisor, spawned } = makeSupervisor({
      idleTimeoutMs: 100,
      checkIntervalMs: 20,
    })

    await supervisor.ensureRunning()
    expect(spawned).toHaveLength(1)
    expect(existsSync(PID_FILE)).toBe(true)

    // The idle watch stops it after the timeout.
    supervisor.startIdleWatch()
    await new Promise((r) => setTimeout(r, 400))
    supervisor.stopIdleWatch()
    expect(supervisor.isStoppedOnPurpose()).toBe(true)
    // the pid file is gone — the server is not around any more
    expect(existsSync(PID_FILE)).toBe(false)
  })

  it("keeps the server while a session is running", async () => {
    const { supervisor } = makeSupervisor({
      idleTimeoutMs: 100,
      checkIntervalMs: 20,
      active: { "ses-1": { type: "running" } },
    })

    await supervisor.ensureRunning()
    supervisor.startIdleWatch()
    await new Promise((r) => setTimeout(r, 400))
    supervisor.stopIdleWatch()
    expect(supervisor.isStoppedOnPurpose()).toBe(false)
    expect(existsSync(PID_FILE)).toBe(true)
  })

  it("remembers that the server was stopped on purpose", async () => {
    const { supervisor } = makeSupervisor()
    expect(supervisor.isStoppedOnPurpose()).toBe(false)
    await supervisor.stop()
    expect(supervisor.isStoppedOnPurpose()).toBe(true)
  })

  it("waits for the server to be up", async () => {
    const { supervisor } = makeSupervisor()
    let up = false
    void supervisor.whenRunning().then(() => {
      up = true
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(up).toBe(false)
    await supervisor.ensureRunning()
    await new Promise((r) => setTimeout(r, 50))
    expect(up).toBe(true)
  })
})
