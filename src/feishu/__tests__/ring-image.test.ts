import { describe, it, expect } from "vitest"
import { renderRingPng } from "../ring-image.js"

function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe("renderRingPng", () => {
  it("produces a valid RGBA PNG of the requested size", () => {
    const png = renderRingPng(37, 20)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(pngSize(png)).toEqual({ width: 20, height: 20 })
    expect(png.includes(Buffer.from("IEND"))).toBe(true)
  })

  it("draws a different ring for different percentages", () => {
    expect(renderRingPng(0).equals(renderRingPng(100))).toBe(false)
    expect(renderRingPng(10).equals(renderRingPng(90))).toBe(false)
  })

  it("clamps out-of-range percentages", () => {
    expect(renderRingPng(-5).equals(renderRingPng(0))).toBe(true)
    expect(renderRingPng(140).equals(renderRingPng(100))).toBe(true)
  })
})
