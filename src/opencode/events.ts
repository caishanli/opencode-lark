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