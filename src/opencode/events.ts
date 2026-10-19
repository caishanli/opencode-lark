/**
 * opencode SSE payload helper.
 *
 * v2's /api/event carries the payload under `data`; the v1 (and part of the
 * SDK's own types) use `properties`. Read both so old fixtures and the live
 * server both work.
 */
export function eventPayload(event: unknown): Record<string, unknown> | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null
  const e = event as Record<string, unknown>
  const d = e.data
  if (d && typeof d === "object" && !Array.isArray(d)) {
    return d as Record<string, unknown>
  }
  const p = e.properties
  if (p && typeof p === "object" && !Array.isArray(p)) {
    return p as Record<string, unknown>
  }
  return null
}
/**
 * The id of the assistant message an event belongs to.
 *
 * v1 carried it as `messageID` (on the part or on the event); v2 renamed it
 * to `assistantMessageID`. Both are accepted so the "this reply was started
 * from Feishu" ownership check keeps working.
 */
export function eventMessageId(event: unknown): string | undefined {
  const props = eventPayload(event)
  if (!props) return undefined
  const part = props.part
  if (part && typeof part === "object") {
    const rec = part as Record<string, unknown>
    for (const key of ["messageID", "assistantMessageID"]) {
      if (typeof rec[key] === "string") return rec[key] as string
    }
  }
  for (const key of ["messageID", "assistantMessageID"]) {
    if (typeof props[key] === "string") return props[key] as string
  }
  return undefined
}
