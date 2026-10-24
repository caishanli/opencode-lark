/**
 * Uploads the context-window ring once per percentage and remembers the
 * Feishu image key. The status line uses it as the markdown `icon`, which
 * renders at a fixed small size (unlike an inline markdown image).
 */

import { renderRingPng } from "../feishu/ring-image.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"

export interface RingIcons {
  /** The image key for this percentage, if it has been uploaded already. */
  get(percent: number): string | undefined
  /** Upload the ring for this percentage (once) and return its key. */
  ensure(percent: number): Promise<string | undefined>
}

export class FeishuRingIcons implements RingIcons {
  private readonly keys = new Map<number, string>()
  private readonly pending = new Map<number, Promise<string | undefined>>()

  constructor(
    private readonly feishuClient: Pick<FeishuApiClient, "uploadImage">,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  get(percent: number): string | undefined {
    return this.keys.get(toPercent(percent))
  }

  ensure(percent: number): Promise<string | undefined> {
    const pct = toPercent(percent)
    const cached = this.keys.get(pct)
    if (cached) return Promise.resolve(cached)
    const inflight = this.pending.get(pct)
    if (inflight) return inflight

    const promise = this.feishuClient
      .uploadImage(renderRingPng(pct), "message")
      .then((key) => {
        if (key) this.keys.set(pct, key)
        return key || undefined
      })
      .catch((err) => {
        this.logger.warn(`ring icon upload failed: ${err}`)
        return undefined
      })
      .finally(() => {
        this.pending.delete(pct)
      })
    this.pending.set(pct, promise)
    return promise
  }
}

function toPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.round(Math.max(0, Math.min(100, percent)))
}
