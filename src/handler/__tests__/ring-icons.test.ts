import { describe, it, expect, vi } from "vitest"
import { FeishuRingIcons } from "../ring-icons.js"

describe("FeishuRingIcons", () => {
  it("uploads each percentage once and caches the key", async () => {
    const uploadImage = vi.fn().mockResolvedValue("img_key_42")
    const icons = new FeishuRingIcons(
      { uploadImage } as any,
      { warn: vi.fn() },
    )

    expect(icons.get(42)).toBeUndefined()
    const [a, b] = await Promise.all([icons.ensure(42), icons.ensure(42)])
    expect(a).toBe("img_key_42")
    expect(b).toBe("img_key_42")
    expect(uploadImage).toHaveBeenCalledTimes(1)
    expect(icons.get(42)).toBe("img_key_42")
  })

  it("rounds and clamps the percentage", async () => {
    const uploadImage = vi.fn().mockResolvedValue("img_key_0")
    const icons = new FeishuRingIcons({ uploadImage } as any, { warn: vi.fn() })

    await icons.ensure(-3)
    expect(icons.get(0)).toBe("img_key_0")
    expect(icons.ensure(140)).resolves.toBe("img_key_0")
  })

  it("reports an upload failure instead of throwing", async () => {
    const warn = vi.fn()
    const icons = new FeishuRingIcons(
      { uploadImage: vi.fn().mockRejectedValue(new Error("boom")) } as any,
      { warn },
    )

    expect(await icons.ensure(42)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ring icon upload failed"))
  })
})
