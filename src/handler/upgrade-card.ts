/**
 * Cards for an opencode upgrade: live download progress, then a button asking
 * whether to restart the service so the new version takes effect.
 */

import type { UpgradeProgressSample } from "../opencode/upgrade-progress.js"

function text(content: string): Record<string, unknown> {
  return { tag: "plain_text", content }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`
}

/** `▓▓▓▓░░░░ 52%` — a bar wide enough to read on a phone. */
export function progressBar(percent: number, width = 12): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * width)
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}

export function formatUpgradeProgress(
  sample: UpgradeProgressSample,
  elapsedMs: number,
): string {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000))
  if (sample.phase === "installing") {
    return `⬆️ opencode 正在安装${sample.version ? ` ${sample.version}` : ""}… · ${seconds}s`
  }
  const bar =
    sample.percent !== undefined ? `${progressBar(sample.percent)} ${sample.percent}% · ` : ""
  const size = sample.total
    ? `${megabytes(sample.bytes)} / ${megabytes(sample.total)}`
    : megabytes(sample.bytes)
  return (
    `⬆️ opencode 正在下载${sample.version ? ` ${sample.version}` : ""}…\n` +
    `${bar}${size} · ${seconds}s`
  )
}

export function buildUpgradeProgressCard(notice: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: { title: text("⬆️ 更新 opencode"), template: "blue" },
    elements: [{ tag: "markdown", content: notice }],
  }
}

export function buildUpgradeRestartCard(
  version: string,
  elapsedMs: number,
): Record<string, unknown> {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000))
  return {
    config: { wide_screen_mode: true },
    header: { title: text("✅ opencode 已更新"), template: "green" },
    elements: [
      {
        tag: "markdown",
        content:
          `**已更新到 ${version}**（用时 ${seconds}s）。\n` +
          "旧服务已停止，新版本要重启服务后才生效。",
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: text("🔄 立即重启"),
            type: "primary",
            value: { action: "opencode_restart", choice: "now", version },
          },
          {
            tag: "button",
            text: text("⏳ 稍后"),
            value: { action: "opencode_restart", choice: "later", version },
          },
        ],
      },
    ],
  }
}

export type UpgradeRestartOutcome = "now" | "later" | "failed"

export function buildUpgradeRestartResultCard(
  outcome: UpgradeRestartOutcome,
  version: string,
): Record<string, unknown> {
  const header =
    outcome === "now" ? "🔄 opencode 服务已重启"
      : outcome === "later" ? "⏳ 稍后重启"
      : "❌ 服务没有启动"
  const body =
    outcome === "now"
      ? `已切换到新版本 ${version}，可以继续对话了。`
      : outcome === "later"
        ? `已更新到 ${version}。下一条消息时会自动启动新版本。`
        : `已更新到 ${version}，但服务没有启动。下一条消息时还会再试。`
  return {
    config: { wide_screen_mode: true },
    header: { title: text(header), template: outcome === "failed" ? "red" : "green" },
    elements: [{ tag: "markdown", content: body }],
  }
}

export function buildUpgradeNoopCard(version: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: { title: text("✅ opencode 已是最新版本"), template: "green" },
    elements: [{ tag: "markdown", content: `当前版本 ${version}，无需更新。` }],
  }
}

export function buildUpgradeFailedCard(message: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: { title: text("❌ 更新失败"), template: "red" },
    elements: [{ tag: "markdown", content: message }],
  }
}
