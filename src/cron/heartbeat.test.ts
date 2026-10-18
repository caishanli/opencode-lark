import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { HeartbeatService } from "../cron/heartbeat.js"
import type { HeartbeatOptions } from "../cron/heartbeat.js"
import { createMockLogger, createMockFeishuClient } from "../__tests__/setup.js"
import { createMockGateway } from "../__tests__/setup.js"

const advanceTimers = async (ms: number) => {
  if (typeof vi.advanceTimersByTimeAsync === "function") {
    await vi.advanceTimersByTimeAsync(ms)
  } else {
    vi.advanceTimersByTime(ms)
    await new Promise(r => setImmediate(r))
  }
}

function makeGateway(overrides: { ping?: () => Promise<void> } = {}) {
  return { ping: vi.fn(overrides.ping ?? (async () => {})) } as any
}

function makeOptions(overrides: Partial<HeartbeatOptions> = {}): HeartbeatOptions {
  return {
    intervalMs: 1000,
    opencode: makeGateway(),
    logger: createMockLogger(),
    ...overrides,
  }
}

describe("HeartbeatService", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("start() begins interval with configured intervalMs", () => {
    const options = makeOptions()
    const service = new HeartbeatService(options)

    service.start()

    expect(options.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Heartbeat service started (interval: 1000ms)"),
    )

    service.stop()
    expect(options.logger.info).toHaveBeenCalledWith("Heartbeat service stopped")
  })

  it("start() is idempotent", () => {
    const options = makeOptions()
    const service = new HeartbeatService(options)

    service.start()
    service.start()

    const startCalls = (options.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("started"))
    expect(startCalls).toHaveLength(1)

    service.stop()
  })

  it("stop() is idempotent", () => {
    const options = makeOptions()
    const service = new HeartbeatService(options)

    service.start()
    service.stop()
    service.stop()

    const stopCalls = (options.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("stopped"))
    expect(stopCalls).toHaveLength(1)
  })

  it("tick() logs success on healthy server", async () => {
    const opencode = makeGateway()
    const options = makeOptions({ intervalMs: 100, opencode })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await advanceTimers(10)

    expect(opencode.ping).toHaveBeenCalled()
    expect(options.logger.info).toHaveBeenCalledWith("Server healthy")

    service.stop()
  })

  it("tick() logs error when ping rejects", async () => {
    const opencode = makeGateway({ ping: async () => { throw new Error("boom") } })
    const options = makeOptions({ intervalMs: 100, opencode })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await advanceTimers(10)

    expect(options.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Server health check failed: boom"),
    )

    service.stop()
  })

  it("tick() sends alert on failure with statusChatId", async () => {
    const opencode = makeGateway({ ping: async () => { throw new Error("down") } })
    const feishuClient = createMockFeishuClient()
    const options = makeOptions({
      intervalMs: 100,
      opencode,
      feishuClient,
      statusChatId: "chat-123",
    })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await advanceTimers(10)

    expect(feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-123",
      expect.objectContaining({ msg_type: "text" }),
    )

    service.stop()
  })

  it("tick() handles network error", async () => {
    const opencode = makeGateway({ ping: async () => { throw new Error("Network timeout") } })
    const options = makeOptions({ intervalMs: 100, opencode })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await advanceTimers(10)

    expect(options.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Server health check failed: Network timeout"),
    )

    service.stop()
  })

  it("getStats() returns successCount and failCount", async () => {
    const ping = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("fail"))
    const opencode = { ping } as any
    const options = makeOptions({ intervalMs: 100, opencode })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await advanceTimers(10)

    let stats = service.getStats()
    expect(stats.successCount).toBe(1)
    expect(stats.failCount).toBe(0)

    vi.advanceTimersByTime(100)
    await advanceTimers(10)

    stats = service.getStats()
    expect(stats.successCount).toBe(1)
    expect(stats.failCount).toBe(1)

    service.stop()
  })
})
