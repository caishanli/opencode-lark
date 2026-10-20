#!/usr/bin/env bun
/**
 * Health check of the Feishu chat: how many cards did the last turns post?
 *
 * The streaming bridge updates its card in place, so a card that was updated
 * has update_time > create_time. A card that was created and never updated is
 * a static one-shot card — that is the duplicate the session observer used to
 * post (same answer, no status line, so no tok/s).
 *
 * Usage: bun run scripts/check-chat-cards.ts [chatId] [sinceMinutes]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createFeishuApiClient } from "../src/feishu/api-client.js"

const envDir = join(homedir(), ".config", "opencode-lark")
const envName = readdirSync(envDir).find((f) => f.startsWith(".env."))
if (!envName) {
  console.error("No .env.<appId> found in ~/.config/opencode-lark")
  process.exit(1)
}
for (const line of readFileSync(join(envDir, envName), "utf-8").split("\n")) {
  const eq = line.indexOf("=")
  if (eq < 1) continue
  const key = line.slice(0, eq).trim()
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue
  const value = line.slice(eq + 1).trim().replace(/^["']/, "").replace(/["']$/, "")
  if (process.env[key] === undefined) process.env[key] = value
}

const chatId = process.argv[2] ?? "oc_7f52026073a76846a3d007932826598e"
const sinceMinutes = Number(process.argv[3] ?? 120)

const client = createFeishuApiClient({
  appId: process.env["FEISHU_APP_ID"]!,
  appSecret: process.env["FEISHU_APP_SECRET"]!,
})

const res = await client.listMessages(chatId, 50)
const items = (res.data?.["items"] ?? []) as unknown as {
  message_id: string
  msg_type: string
  create_time: string
  update_time: string
  updated?: boolean
  deleted?: boolean
}[]

// The card the bridge is currently filling in is not a duplicate — it is
// simply not updated yet. It is remembered in <dataDir>/open-card.json.
const openCardFile = join(process.cwd(), "data", "open-card.json")
let openCardId = ""
if (existsSync(openCardFile)) {
  try {
    openCardId = (JSON.parse(readFileSync(openCardFile, "utf-8")) as { messageId?: string })
      .messageId ?? ""
  } catch {
    openCardId = ""
  }
}

const since = (Date.now() - sinceMinutes * 60_000).toString()
const cards = items
  .filter(
    (i) =>
      i.msg_type === "interactive" &&
      i.create_time >= since &&
      // A deleted message keeps an update_time (the delete time) — it is gone
      // from the chat, so it must not count as a card.
      !i.deleted &&
      i.message_id !== openCardId,
  )
  .sort((a, b) => Number(a.create_time) - Number(b.create_time))

const fmt = (ms: string) => new Date(Number(ms)).toLocaleTimeString("zh-CN", { hour12: false })

console.log(`最近 ${sinceMinutes} 分钟内的卡片：`)
let statics = 0
for (const c of cards) {
  const updated = c.updated === true || c.update_time !== c.create_time
  if (!updated) statics += 1
  console.log(
    `  ${fmt(c.create_time)}  ${updated ? "流式卡(就地更新)" : "⚠️ 静态卡(一次性 = 重复)"}  ${c.message_id}`,
  )
}
if (openCardId) console.log(`(当前打开的卡 ${openCardId} 不计入)`)
console.log(`\n流式卡 ${cards.length - statics} 张，静态重复卡 ${statics} 张`)
if (statics > 0) {
  console.error("❌ 存在重复的静态卡")
  process.exit(1)
}
console.log("✅ 没有重复卡")
