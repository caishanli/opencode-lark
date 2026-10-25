/**
 * Which chats have already been greeted with the command menu.
 *
 * The menu is sent once per chat and per Feishu app: when the bridge is moved
 * to another app (another bot), every chat is new to that bot and should be
 * greeted again. A new app therefore drops the remembered chats.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface WelcomeStore {
  /** True the first time this chat is seen for the current app. */
  shouldWelcome(chatId: string): boolean
}

const MAX_CHATS = 1000

export function createWelcomeStore(file: string, appId: string): WelcomeStore {
  let chats: string[] = []

  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
        appId?: unknown
        chats?: unknown
      }
      if (parsed.appId === appId && Array.isArray(parsed.chats)) {
        chats = parsed.chats.filter((id): id is string => typeof id === "string")
      }
    }
  } catch {
    // A broken file only means everyone is greeted once more.
  }

  const save = (): void => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ appId, chats }))
    } catch {
      // Greeting twice is harmless; failing the message is not.
    }
  }

  return {
    shouldWelcome(chatId: string): boolean {
      if (!chatId || chats.includes(chatId)) return false
      chats.push(chatId)
      if (chats.length > MAX_CHATS) chats = chats.slice(-MAX_CHATS)
      save()
      return true
    },
  }
}
