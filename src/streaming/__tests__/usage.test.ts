import { describe, it, expect } from "vitest"
import { cacheHitRate, formatRate, formatTokens, totalTokens } from "../usage.js"

describe("usage helpers", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1234)).toBe("1.2k")
    expect(formatTokens(1_500_000)).toBe("1.5M")
    expect(formatTokens(0)).toBe("0")
  })

  it("formats rates compactly", () => {
    expect(formatRate(42.34)).toBe("42.3")
    expect(formatRate(1234)).toBe("1.2k")
    expect(formatRate(0)).toBe("0.0")
  })

  it("sums all token buckets", () => {
    expect(
      totalTokens({ input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 1 } }),
    ).toBe(176)
  })

  it("computes the cache hit rate from cached vs fresh input tokens", () => {
    expect(cacheHitRate({ input: 100, cache: { read: 300 } })).toBe(0.75)
    expect(cacheHitRate({ input: 4754, cache: { read: 6144 } })).toBeCloseTo(0.564, 3)
    expect(cacheHitRate({ input: 100, cache: { read: 0 } })).toBe(0)
    expect(cacheHitRate({})).toBe(0)
  })
})
