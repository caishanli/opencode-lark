import { describe, it, expect } from "vitest"
import { cacheHitRate, formatPercent, formatRate, formatTokens, totalTokens } from "./usage.js"

describe("formatTokens", () => {
  it("scales to k, M and B", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1500)).toBe("1.5k")
    expect(formatTokens(219_200)).toBe("219.2k")
    expect(formatTokens(1_400_000)).toBe("1.4M")
    expect(formatTokens(999_900_000)).toBe("999.9M")
    // Past a billion the session total reads as B, not 1004.6M.
    expect(formatTokens(1_004_600_000)).toBe("1.0B")
    expect(formatTokens(2_345_000_000)).toBe("2.3B")
  })
})

describe("formatRate", () => {
  it("scales to k", () => {
    expect(formatRate(92)).toBe("92.0")
    expect(formatRate(4000)).toBe("4.0k")
  })
})

describe("cacheHitRate", () => {
  it("is the share of the prompt that was served from the cache", () => {
    // A cold session: the system prompt is cached, the rest is not.
    expect(cacheHitRate({ input: 5598, cache: { read: 1723 } })).toBeCloseTo(0.2354, 3)
    // A warm session: only the new message was not cached.
    expect(cacheHitRate({ input: 30, cache: { read: 221_798 } })).toBeCloseTo(0.99986, 4)
    expect(cacheHitRate({ input: 10 })).toBe(0)
  })
})

describe("formatPercent", () => {
  it("keeps the precision that a warm cache needs", () => {
    // 221798 of 221828 tokens came from the cache — rounding that to "100%"
    // would hide that the new message was not cached at all.
    expect(formatPercent(221798 / 221828)).toBe("99.99")
    expect(formatPercent(1723 / 7321)).toBe("23.54")
    expect(formatPercent(1)).toBe("100")
    expect(formatPercent(0)).toBe("0")
    expect(formatPercent(0.5)).toBe("50")
  })
})

describe("totalTokens", () => {
  it("sums the parts", () => {
    expect(totalTokens({ input: 10, output: 20, reasoning: 5 })).toBe(35)
  })
})
