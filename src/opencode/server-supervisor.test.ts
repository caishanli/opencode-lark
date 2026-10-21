import { describe, it, expect, vi, beforeEach } from "vitest"
import { rmSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
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
    stateFile?: string
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
    stateFile: overrides.stateFile,
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
    // the binary is resolved to a full path (the service PATH has no opencode)
    expect(spawned[0].command.endsWith("opencode")).toBe(true)
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

  it("finds the binary in a directory that is not on the PATH", async () => {
    // The bridge runs as a systemd service: ~/.opencode/bin is not on its
    // PATH, but that is where opencode lives.
    const binary = join(homedir(), ".opencode", "bin", "opencode")
    if (!existsSync(binary)) return // nothing to test against here
    const { supervisor, spawned } = makeSupervisor()
    await supervisor.ensureRunning()
    expect(spawned[0].command).toBe(binary)
  })

  it("says where it looked when the binary is missing", async () => {
    const { logger } = makeSupervisor()
    const downGateway = createMockGateway()
    ;(downGateway.ping as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection refused"),
    )
    const broken = createServerSupervisor({
      command: "definitely-not-a-real-binary-xyz",
      args: [],
      pidFile: PID_FILE,
      idleTimeoutMs: 1000,
      opencode: downGateway,
      logger,
    })
    expect(await broken.ensureRunning()).toBe(false)
    const messages = [
      ...(logger.warn as any).mock.calls.map((c: any[]) => String(c[0])),
      ...(logger.error as any).mock.calls.map((c: any[]) => String(c[0])),
    ]
    expect(messages.join(" ")).toContain("definitely-not-a-real-binary-xyz")
  })

  it("remembers the idle timeout", async () => {
    const stateFile = "/tmp/opencode/supervisor-state-test.json"
    rmSync(stateFile, { force: true })
    const { supervisor: sup } = makeSupervisor({ stateFile })
    expect(sup.idleTimeoutMinutes()).toBe(30)
    expect(sup.isIdleWatchEnabled()).toBe(true)

    sup.setIdleTimeoutMinutes(15)
    expect(sup.idleTimeoutMinutes()).toBe(15)
    expect(JSON.parse(readFileSync(stateFile, "utf-8")).idleTimeoutMinutes).toBe(15)

    // a new process reads it back
    const next = makeSupervisor({ stateFile }).supervisor
    expect(next.idleTimeoutMinutes()).toBe(15)
  })

  it("remembers that the server should never be stopped", async () => {
    const stateFile = "/tmp/opencode/supervisor-state-test3.json"
    rmSync(stateFile, { force: true })
    const { supervisor: sup } = makeSupervisor({ stateFile })
    sup.setIdleTimeoutMinutes(0)
    expect(sup.isIdleWatchEnabled()).toBe(false)
    expect(JSON.parse(readFileSync(stateFile, "utf-8")).idleTimeoutMinutes).toBe(0)

    const next = makeSupervisor({ stateFile }).supervisor
    expect(next.isIdleWatchEnabled()).toBe(false)
  })

  it("does not start the idle watch when the server should never be stopped", async () => {
    const stateFile = "/tmp/opencode/supervisor-state-test2.json"
    rmSync(stateFile, { force: true })
    writeFileSync(stateFile, JSON.stringify({ idleTimeoutMinutes: 0 }))
    const { supervisor: sup } = makeSupervisor({
      stateFile,
      idleTimeoutMs: 100,
      checkIntervalMs: 20,
    })
    await sup.ensureRunning()
    sup.startIdleWatch()
    await new Promise((r) => setTimeout(r, 300))
    // the watch never ran, so the server was not stopped
    expect(sup.isStoppedOnPurpose()).toBe(false)
    expect(existsSync(PID_FILE)).toBe(true)
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
