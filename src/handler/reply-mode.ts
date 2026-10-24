/**
 * Per-chat reply detail, set by /回复.
 *
 * `standard` is the card as it has always been: text, tool panels, status
 * line. `concise` keeps only the assistant text — the card is meant to be
 * readable on a phone without scrolling past every tool call.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type ReplyMode = "standard" | "concise"

export class ReplyModeStore {
  private readonly modes = new Map<string, ReplyMode>()

  constructor(private readonly file?: string) {
    this.load()
  }

  get(chatId: string): ReplyMode {
    return this.modes.get(chatId) ?? "standard"
  }

  set(chatId: string, mode: ReplyMode): void {
    this.modes.set(chatId, mode)
    this.save()
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as unknown
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
      for (const [chatId, mode] of Object.entries(raw)) {
        if (mode === "standard" || mode === "concise") this.modes.set(chatId, mode)
      }
    } catch {
      // a broken settings file is not worth failing over
    }
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.modes), null, 2))
    } catch {
      // the setting still applies for this process
    }
  }
}
