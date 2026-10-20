#!/usr/bin/env bun
/**
 * Post-turn watchdog: waits for the current turn to end and checks that its
 * card was closed properly. If the card is still listed as open (or still
 * says "running"), it closes it as interrupted so the chat never keeps a
 * stuck card.
 *
 * Usage: bun run scripts/card-watchdog.ts [waitSeconds]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createFeishuApiClient } from "../src/feishu/api-client.js"

const envDir = join(homedir(), ".config", "opencode-lark")
const envName = readdirSync(envDir).find((f) => f.startsWith(".env."))!
for (const line of readFileSync(join(envDir, envName), "utf-8").split("\n")) {
  const eq = line.indexOf("=")
  if (eq < 1) continue
  const key = line.slice(0, eq).trim()
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue
  const value = line.slice(eq + 1).trim().replace(/^["']/, "").replace(/["']$/, "")
  if (process.env[key] === undefined) process.env[key] = value
}

const waitSeconds = Number(process.argv[2] ?? 60)
const stateFile = join(process.cwd(), "data", "open-card.json")
const client = createFeishuApiClient({
  appId: process.env["FEISHU_APP_ID"]!,
  appSecret: process.env["FEISHU_APP_SECRET"]!,
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
await sleep(waitSeconds * 1000)

if (!existsSync(stateFile)) {
  console.log(`[watchdog] no open card — the turn closed it properly`)
  process.exit(0)
}

const open = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, string>
for (const [chatId, messageId] of Object.entries(open)) {
  console.log(`[watchdog] card ${messageId} is still open — closing it`)
  const card = JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: {
      elements: [
        { tag: "markdown", content: "⚠️ 已中断（这一轮的卡片没有正常收尾）" },
      ],
    },
  })
  const res = await client.updateMessage(messageId, card)
  console.log(`[watchdog] update ${res.code} ${res.msg}`)
}
