import { describe, it, expect } from "vitest"
import {
  buildUpgradeRestartCard,
  buildUpgradeRestartResultCard,
  formatUpgradeProgress,
  progressBar,
} from "./upgrade-card.js"

describe("progressBar", () => {
  it("fills the share that is done", () => {
    expect(progressBar(0, 10)).toBe("░░░░░░░░░░")
    expect(progressBar(50, 10)).toBe("█████░░░░░")
    expect(progressBar(100, 10)).toBe("██████████")
  })
})

describe("formatUpgradeProgress", () => {
  it("shows the bar, the percentage and the transferred size", () => {
    const text = formatUpgradeProgress(
      {
        bytes: 50_000_000,
        total: 100_000_000,
        percent: 50,
        version: "2.1.4",
        phase: "downloading",
      },
      13_000,
    )
    expect(text).toContain("2.1.4")
    expect(text).toContain("50%")
    expect(text).toContain("50.0MB / 100.0MB")
    expect(text).toContain("13s")
    expect(text).toContain("█")
  })

  it("shows the transfer speed", () => {
    const text = formatUpgradeProgress(
      {
        bytes: 50_000_000,
        total: 100_000_000,
        percent: 50,
        bytesPerSecond: 5_900_000,
        phase: "downloading",
      },
      13_000,
    )
    expect(text).toContain("5.9MB/s")
  })

  it("falls back to the transferred size without a total", () => {
    const text = formatUpgradeProgress(
      { bytes: 12_000_000, phase: "downloading" },
      3_000,
    )
    expect(text).toContain("12.0MB")
    expect(text).not.toContain("%")
  })

  it("says it is installing once the download is over", () => {
    const text = formatUpgradeProgress(
      { bytes: 0, version: "2.1.4", phase: "installing" },
      70_000,
    )
    expect(text).toContain("正在安装")
    expect(text).toContain("2.1.4")
  })
})

describe("buildUpgradeRestartCard", () => {
  it("offers restart now or later", () => {
    const card = buildUpgradeRestartCard("2.1.4", 71_000)
    const actions = (card.elements as any[])
      .filter((el) => el.tag === "action")
      .flatMap((el) => el.actions)
    expect(actions.map((a) => a.value)).toEqual([
      { action: "opencode_restart", choice: "now", version: "2.1.4" },
      { action: "opencode_restart", choice: "later", version: "2.1.4" },
    ])
    expect(JSON.stringify(card)).toContain("2.1.4")
  })
})

describe("buildUpgradeRestartResultCard", () => {
  it("tells what happened to the service", () => {
    expect(JSON.stringify(buildUpgradeRestartResultCard("now", "2.1.4"))).toContain("可以继续对话")
    expect(JSON.stringify(buildUpgradeRestartResultCard("later", "2.1.4"))).toContain("下一条消息")
    expect(JSON.stringify(buildUpgradeRestartResultCard("failed", "2.1.4"))).toContain("没有启动")
  })
})
