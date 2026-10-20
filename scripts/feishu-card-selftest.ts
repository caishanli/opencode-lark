#!/usr/bin/env bun
/**
 * End-to-end self test of the Feishu card path.
 *
 * It runs the REAL streaming bridge and the REAL session observer against the
 * REAL Feishu API, driven by synthetic opencode events, and then checks:
 *
 *   1. exactly ONE interactive message lands in the chat (the observer must
 *      not post a second, static copy of the same answer);
 *   2. the card's final content carries the status line with tok/s;
 *   3. every API call was accepted.
 *
 * The test card is deleted again afterwards, so the chat stays clean.
 *
 * Usage: bun run scripts/feishu-card-selftest.ts [chatId]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createFeishuApiClient } from "../src/feishu/api-client.js"
import { EventProcessor } from "../src/streaming/event-processor.js"
import { createStreamingBridge } from "../src/handler/streaming-integration.js"
import { createSessionObserver } from "../src/streaming/session-observer.js"
import { ExpiringSet } from "../src/utils/expiring-set.js"
import { addListener, removeListener } from "../src/utils/event-listeners.js"
import type { EventListenerMap } from "../src/utils/event-listeners.js"
import { createLogger } from "../src/utils/logger.js"

// ── credentials ────────────────────────────────────────────────────────────
const envDir = join(homedir(), ".config", "opencode-lark")
if (!existsSync(envDir)) {
  console.error("No credentials found in ~/.config/opencode-lark")
  process.exit(1)
}
const envName = readdirSync(envDir).find((f) => f.startsWith(".env."))
if (!envName) {
  console.error("No .env.<appId> found in ~/.config/opencode-lark")
  process.exit(1)
}
const envFile = readFileSync(join(envDir, envName), "utf-8")
for (const line of envFile.split("\n")) {
  const eq = line.indexOf("=")
  if (eq < 1) continue
  const key = line.slice(0, eq).trim()
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue
  const value = line.slice(eq + 1).trim().replace(/^["']/, "").replace(/["']$/, "")
  if (process.env[key] === undefined) process.env[key] = value
}

const chatId = process.argv[2] ?? "oc_7f52026073a76846a3d007932826598e"
const appId = process.env["FEISHU_APP_ID"]!
const appSecret = process.env["FEISHU_APP_SECRET"]!

const real = createFeishuApiClient({ appId, appSecret })
const logger = createLogger("selftest")

// Wrap the client so the test can see every payload that goes out.
let lastContent = ""
let apiErrors: string[] = []
// Only the message ids this script creates may ever be deleted again.
const createdByTest = new Set<string>()
const feishuClient = {
  ...real,
  async sendMessage(chat: string, body: Record<string, unknown>) {
    const res = await real.sendMessage(chat, body)
    if (res.code !== 0) apiErrors.push(`sendMessage: ${res.code} ${res.msg}`)
    if (typeof body["content"] === "string") lastContent = body["content"]
    const id = (res.data as Record<string, unknown> | undefined)?.["message_id"]
    if (typeof id === "string") createdByTest.add(id)
    return res
  },
  async updateMessage(messageId: string, content: string) {
    const res = await real.updateMessage(messageId, content)
    if (res.code !== 0) apiErrors.push(`updateMessage: ${res.code} ${res.msg}`)
    lastContent = content
    return res
  },
}

const ownedSessions = new Set<string>(["ses-selftest"])
const eventProcessor = new EventProcessor({ ownedSessions, logger })
const eventListeners: EventListenerMap = new Map()
const seenInteractiveIds = new ExpiringSet<string>(60_000, 60_000)

// ── wire the bridge and the observer exactly like src/index.ts does ────────
const observer = createSessionObserver({
  feishuClient,
  eventProcessor,
  addListener: (sessionId, fn) => addListener(eventListeners, sessionId, fn),
  removeListener: (sessionId, fn) => removeListener(eventListeners, sessionId, fn),
  logger,
  seenInteractiveIds,
})

const bridge = createStreamingBridge({
  feishuClient,
  subAgentTracker: { onSubtaskDiscovered: async () => ({}) } as never,
  logger,
  seenInteractiveIds,
  observer,
})

observer.observe("ses-selftest", chatId)

const run = bridge.handleMessage(
  chatId,
  "ses-selftest",
  eventListeners,
  eventProcessor,
  async () => JSON.stringify({ parts: [{ type: "text", text: "mock" }] }),
  () => {},
  "om_selftest_fake",
  null,
)

await waitFor(() => eventListeners.size > 0)
// The observer registers first, the bridge second — the bridge's listener is
// the last one.
await waitFor(() => eventListeners.get("ses-selftest")!.size >= 2)
const listeners = [...eventListeners.get("ses-selftest")!]
const listener = listeners[listeners.length - 1]!

// A multi-step turn, exactly like opencode runs one:
//   step 1: text → tool call → usage
//   step 2: more text → usage
//   end:    session.execution.succeeded
// every delta of a step shares one assistant message id — all of them count
for (const chunk of ["第一段", "正文，", "分成三次推送。"]) {
  listener({
    type: "session.text.delta",
    data: { sessionID: "ses-selftest", assistantMessageID: "msg-selftest-1", delta: chunk },
  })
}
listener({
  type: "session.tool.input.started",
  data: { sessionID: "ses-selftest", id: "call_selftest_1", name: "shell" },
})
listener({
  type: "session.tool.called",
  data: { sessionID: "ses-selftest", id: "call_selftest_1", name: "shell" },
})
listener({
  type: "session.tool.success",
  data: { sessionID: "ses-selftest", id: "call_selftest_1", name: "shell" },
})
listener({
  type: "session.usage.updated",
  data: {
    sessionID: "ses-selftest",
    tokens: { input: 1200, output: 400, reasoning: 0, cache: { read: 5000, write: 0 } },
  },
})
listener({
  type: "session.text.delta",
  data: { sessionID: "ses-selftest", assistantMessageID: "msg-selftest-2", delta: "第二段正文" },
})
listener({
  type: "session.usage.updated",
  data: {
    sessionID: "ses-selftest",
    tokens: { input: 1400, output: 900, reasoning: 0, cache: { read: 5200, write: 0 } },
  },
})
listener({ type: "session.execution.succeeded", data: { sessionID: "ses-selftest" } })
await Promise.race([
  run,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("the bridge did not settle the turn")), 20_000),
  ),
])

await new Promise((r) => setTimeout(r, 1500))
// Only what this run created counts — never a diff against the whole chat.
const fresh = (await listInteractive(chatId)).filter((m) => createdByTest.has(m.message_id))

console.log("\n=== 自测结果 ===")
console.log(`新增消息数: ${fresh.length} (期望 1)`)
for (const m of fresh) {
  const updated = m.update_time !== m.create_time
  console.log(`  ${m.message_id}  ${updated ? "流式卡(被更新过)" : "静态卡(一次性)"}`)
}
console.log(`API 报错: ${apiErrors.length === 0 ? "无" : apiErrors.join(" | ")}`)

// The whole turn must be in the card — not only the first step.
const hasStep1 = lastContent.includes("第一段正文，分成三次推送。")
const hasStep2 = lastContent.includes("第二段正文")
console.log(`第一段在卡里: ${hasStep1 ? "✅" : "❌"}`)
console.log(`第二段在卡里: ${hasStep2 ? "✅" : "❌"}`)

const statusLine = lastContent.includes("tok/s")
const hasDuration = lastContent.includes("耗时")
const hasContext = lastContent.includes("上下文")
console.log(`状态行含 tok/s: ${statusLine ? "✅" : "❌"}`)
console.log(`状态行含总耗时: ${hasDuration ? "✅" : "❌"}`)
console.log(`状态行含上下文: ${hasContext ? "✅" : "❌"}`)
if (statusLine) {
  const m = /"content":"([^"]*tok\/s[^"]*)"/.exec(lastContent)
  console.log(`  → ${m?.[1] ?? "(未取到)"}`)
}

let failed = false
if (fresh.length !== 1) {
  console.error("\n❌ 失败：期望恰好 1 张卡（观察者又发了一张重复的静态卡）")
  failed = true
} else if (!statusLine) {
  console.error("\n❌ 失败：卡片内容里没有 tok/s")
  failed = true
} else if (!hasDuration || !hasContext) {
  console.error("\n❌ 失败：状态行缺少总耗时或上下文")
  failed = true
} else if (!hasStep1 || !hasStep2) {
  console.error("\n❌ 失败：卡片内容缺少多步轮次里的正文")
  failed = true
} else if (apiErrors.length > 0) {
  console.error("\n❌ 失败：飞书 API 报错")
  failed = true
} else {
  console.log("\n✅ 通过：只有 1 张卡，末尾带 tok/s，飞书 API 全部接受")
}

// clean up: delete ONLY the cards this run created
for (const m of fresh) await deleteMessage(m.message_id)
console.log(`已清理 ${fresh.length} 张测试卡`)
process.exit(failed ? 1 : 0)

// ── helpers ────────────────────────────────────────────────────────────────
async function listInteractive(chat: string): Promise<
  { message_id: string; create_time: string; update_time: string }[]
> {
  const res = await real.listMessages(chat, 50)
  const items = (res.data?.["items"] ?? []) as unknown as {
    message_id: string
    msg_type: string
    create_time: string
    update_time: string
  }[]
  return items
    .filter((i) => i.msg_type === "interactive")
    .map((i) => ({
      message_id: i.message_id,
      create_time: i.create_time,
      update_time: i.update_time ?? i.create_time,
    }))
}

async function deleteMessage(messageId: string): Promise<void> {
  if (!createdByTest.has(messageId)) {
    throw new Error(`refusing to delete a message this test did not create: ${messageId}`)
  }
  const res = await real.deleteMessage(messageId)
  if (res.code !== 0) console.error(`  删除 ${messageId} 失败: ${res.code} ${res.msg}`)
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}
