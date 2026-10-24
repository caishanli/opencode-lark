#!/usr/bin/env bun
/**
 * Send a plain-text message to the chat the bridge last served.
 *
 * Used by scripts/restart-when-idle.sh to announce a restart, so the chat is
 * not left wondering why replies stopped. The chat id is remembered by the
 * bridge in data/notify-chat.json; credentials come from the same env files
 * the bridge uses (~/.config/opencode-lark/.env.*).
 *
 * Exits 0 on "nothing to do" so it can never block a restart.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const BASE = "https://open.feishu.cn/open-apis"
const repo = path.resolve(import.meta.dir, "..")
const text = process.argv.slice(2).join(" ").trim()

if (!text) {
  console.error("usage: notify-feishu.ts <message>")
  process.exit(1)
}

function readChatId(): string | undefined {
  if (process.env.FEISHU_NOTIFY_CHAT) return process.env.FEISHU_NOTIFY_CHAT
  const file = path.join(repo, "data", "notify-chat.json")
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { chatId?: unknown }
    return typeof parsed.chatId === "string" ? parsed.chatId : undefined
  } catch {
    return undefined
  }
}

function readCredentials(): { appId: string; appSecret: string } | undefined {
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    return {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
    }
  }
  const dir = path.join(process.env.HOME ?? "", ".config", "opencode-lark")
  if (!existsSync(dir)) return undefined
  for (const name of readdirSync(dir).filter((f) => f.startsWith(".env."))) {
    const env: Record<string, string> = {}
    for (const line of readFileSync(path.join(dir, name), "utf-8").split("\n")) {
      const i = line.indexOf("=")
      if (i < 0 || line.trim().startsWith("#")) continue
      env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "")
    }
    if (env.FEISHU_APP_ID && env.FEISHU_APP_SECRET) {
      return { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET }
    }
  }
  return undefined
}

const chatId = readChatId()
if (!chatId) {
  console.error("notify-feishu: no chat id (data/notify-chat.json)")
  process.exit(0)
}
const creds = readCredentials()
if (!creds) {
  console.error("notify-feishu: no credentials")
  process.exit(0)
}

try {
  const tokenRes = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  })
  const tokenBody = (await tokenRes.json()) as { tenant_access_token?: string; msg?: string }
  if (!tokenBody.tenant_access_token) {
    console.error(`notify-feishu: token failed: ${tokenBody.msg ?? tokenRes.status}`)
    process.exit(0)
  }
  const res = await fetch(`${BASE}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenBody.tenant_access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  })
  const body = (await res.json()) as { code?: number; msg?: string }
  if (body.code !== 0) {
    console.error(`notify-feishu: send failed: ${body.code} ${body.msg ?? ""}`)
    process.exit(0)
  }
  console.log("notify-feishu: sent")
} catch (err) {
  console.error(`notify-feishu: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(0)
}
