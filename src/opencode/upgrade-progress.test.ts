import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseTarballName,
  startUpgradeProgress,
  type UpgradeProgressSample,
} from "./upgrade-progress.js"
import { waitFor } from "../__tests__/setup.js"

describe("parseTarballName", () => {
  it("splits the target and the version", () => {
    expect(parseTarballName("cli-linux-x64-2.1.4.tgz")).toEqual({
      target: "linux-x64",
      version: "2.1.4",
    })
    expect(parseTarballName("cli-darwin-arm64-0.0.0-beta-17236.tgz")).toEqual({
      target: "darwin-arm64",
      version: "0.0.0-beta-17236",
    })
    expect(parseTarballName("junk.tgz")).toBeUndefined()
  })
})

describe("startUpgradeProgress", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function makeTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "upgrade-progress-test-"))
    dirs.push(dir)
    return dir
  }

  it("reports the downloaded share of the tarball", async () => {
    const dir = makeTmp()
    const install = join(dir, "opencode_install_4242")
    mkdirSync(install)
    writeFileSync(join(install, "cli-linux-x64-2.1.4.tgz"), Buffer.alloc(50_000_000))

    const samples: UpgradeProgressSample[] = []
    const stop = startUpgradeProgress({
      startedAt: Date.now() - 1_000,
      tmpDir: dir,
      intervalMs: 10,
      fetchTotal: async () => 100_000_000,
      onUpdate: (sample) => samples.push(sample),
    })

    await waitFor(() => expect(samples.some((s) => s.percent === 50)).toBe(true))
    stop()

    const sample = samples.find((s) => s.percent === 50)!
    expect(sample.bytes).toBe(50_000_000)
    expect(sample.total).toBe(100_000_000)
    expect(sample.version).toBe("2.1.4")
    expect(sample.phase).toBe("downloading")
  })

  it("switches to installing once the tarball is gone", async () => {
    const dir = makeTmp()
    const install = join(dir, "opencode_install_4243")
    mkdirSync(install)
    const tarball = join(install, "cli-linux-x64-2.1.4.tgz")
    writeFileSync(tarball, Buffer.alloc(1_000))

    const samples: UpgradeProgressSample[] = []
    const stop = startUpgradeProgress({
      startedAt: Date.now() - 1_000,
      tmpDir: dir,
      intervalMs: 10,
      fetchTotal: async () => 1_000,
      onUpdate: (sample) => samples.push(sample),
    })

    await waitFor(() => expect(samples.some((s) => s.phase === "downloading")).toBe(true))
    rmSync(install, { recursive: true, force: true })
    await waitFor(() => expect(samples.some((s) => s.phase === "installing")).toBe(true))
    stop()
  })

  it("ignores install directories from an earlier run", async () => {
    const dir = makeTmp()
    const old = join(dir, "opencode_install_1111")
    mkdirSync(old)
    writeFileSync(join(old, "cli-linux-x64-2.1.3.tgz"), Buffer.alloc(10))
    // Pretend the old run finished long before this upgrade started.
    const { utimesSync } = await import("node:fs")
    const before = new Date(Date.now() - 10 * 60_000)
    utimesSync(old, before, before)

    const samples: UpgradeProgressSample[] = []
    const stop = startUpgradeProgress({
      startedAt: Date.now(),
      tmpDir: dir,
      intervalMs: 10,
      fetchTotal: async () => 10,
      onUpdate: (sample) => samples.push(sample),
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    stop()
    expect(samples).toHaveLength(0)
  })
})
