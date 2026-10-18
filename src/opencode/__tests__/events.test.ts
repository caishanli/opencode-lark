import { describe, it, expect } from "vitest"
import { eventPayload } from "../events.js"

describe("eventPayload", () => {
  it("prefers data over properties", () => {
    expect(eventPayload({ type: "x", data: { a: 1 }, properties: { a: 2 } })).toEqual({ a: 1 })
  })
  it("falls back to properties", () => {
    expect(eventPayload({ type: "x", properties: { a: 2 } })).toEqual({ a: 2 })
  })
  it("returns null for missing/empty payload", () => {
    expect(eventPayload({ type: "x" })).toBeNull()
    expect(eventPayload(null)).toBeNull()
    expect(eventPayload("str")).toBeNull()
    expect(eventPayload([1, 2])).toBeNull()
  })
  it("returns null when payload is not an object", () => {
    expect(eventPayload({ type: "x", data: 42 })).toBeNull()
    expect(eventPayload({ type: "x", data: [1] })).toBeNull()
  })
})