import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { StreamingCardSession } from "./streaming-card.js"
import type { CardKitClient, CardKitSchema } from "../feishu/cardkit-client.js"
import { createMockFeishuClient } from "../__tests__/setup.js"

function createMockCardKitClient(): CardKitClient & {
  createCard: ReturnType<typeof vi.fn>
  updateElement: ReturnType<typeof vi.fn>
  appendElements: ReturnType<typeof vi.fn>
  closeStreaming: ReturnType<typeof vi.fn>
} {
  return {
    createCard: vi.fn().mockResolvedValue("card_123"),
    updateElement: vi.fn().mockResolvedValue(undefined),
    appendElements: vi.fn().mockResolvedValue(undefined),
    closeStreaming: vi.fn().mockResolvedValue(undefined),
  } as any
}

function createStartedSession() {
  const cardkitClient = createMockCardKitClient()
  const feishuClient = createMockFeishuClient()
  ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
    code: 0,
    msg: "ok",
    data: { message_id: "msg_456" },
  })

  const session = new StreamingCardSession({
    cardkitClient: cardkitClient as any,
    feishuClient,
    chatId: "chat_789",
  })

  return { session, cardkitClient, feishuClient }
}

/** All elements appended to the card, in order. */
function appendedElements(cardkitClient: ReturnType<typeof createMockCardKitClient>) {
  return cardkitClient.appendElements.mock.calls.flatMap((c: any) => c[1] as Array<{ element_id: string; content: string }>)
}

/** Every element's final content: appended ones plus the head. */
function allContent(cardkitClient: ReturnType<typeof createMockCardKitClient>) {
  const out = new Map<string, string>()
  for (const el of appendedElements(cardkitClient)) out.set(el.element_id, el.content)
  for (const c of cardkitClient.updateElement.mock.calls) out.set(c[1], c[2])
  return [...out.values()]
}

describe("StreamingCardSession", () => {
  describe("card creation", () => {
    it("creates the card with a head element and sends it once", async () => {
      const { session, cardkitClient, feishuClient } = createStartedSession()
      await session.start()

      const schema = cardkitClient.createCard.mock.calls[0]![0] as CardKitSchema
      expect(schema.body.elements[0]!.element_id).toBe("head")
      expect(schema.body.elements[0]!.content).toContain("Processing")
      expect(feishuClient.sendMessage).toHaveBeenCalledTimes(1)
    })

    it("start() is idempotent", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.start()
      expect(cardkitClient.createCard).toHaveBeenCalledTimes(1)
    })
  })

  describe("text", () => {
    it("appends one element for a run of text and updates it in place", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.setText("Hello")
      await session.setText("Hello world")

      const appended = appendedElements(cardkitClient)
      expect(appended).toHaveLength(1)
      expect(appended[0]!.element_id).toBe("seg1")
      // the element was updated, not re-appended
      const updates = cardkitClient.updateElement.mock.calls.filter((c: any) => c[1] === "seg1")
      expect(updates.at(-1)![2]).toBe("Hello world")
    })

    it("starts a new element when a tool call interrupts the text", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.setText("first part")
      await session.setToolStatus("shell", "completed", "uname -a", "c1")
      await session.setText("first part second part")

      const appended = appendedElements(cardkitClient)
      const ids = appended.map((e) => e.element_id)
      expect(ids).toEqual(["seg1", "seg2", "seg3"]) // text, tool, text
      // the new text element holds only the text after the tool call
      expect(appended[2]!.content).toBe(" second part")
    })
  })

  describe("tool calls", () => {
    it("a running call only touches the head line", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.setToolStatus("shell", "running", "uname -a", "c1")

      expect(appendedElements(cardkitClient)).toHaveLength(0)
      const head = cardkitClient.updateElement.mock.calls.at(-1)!
      expect(head[1]).toBe("head")
      expect(head[2]).toContain("shell")
    })

    it("a finished call appends its own element", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.setToolStatus("shell", "completed", "uname -a", "c1")

      const appended = appendedElements(cardkitClient)
      expect(appended).toHaveLength(1)
      expect(appended[0]!.content).toBe("✅ shell · uname -a")
    })

    it("keeps the preview learned while the call was running", async () => {
      // The completion event carries no input, so the title learned from the
      // running event has to survive into the finished line.
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.setToolStatus("shell", "running", "uname -a", "c1")
      await session.setToolStatus("shell", "completed", undefined, "c1")

      const appended = appendedElements(cardkitClient)
      expect(appended[0]!.content).toBe("✅ shell · uname -a")
    })

    it("keeps two calls to the same tool on separate lines", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.setToolStatus("shell", "completed", "uname -a", "c1")
      await session.setToolStatus("shell", "completed", "node -v", "c2")

      const appended = appendedElements(cardkitClient)
      expect(appended.map((e) => e.content)).toEqual([
        "✅ shell · uname -a",
        "✅ shell · node -v",
      ])
    })

    it("collapses consecutive identical calls into (×N)", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.setToolStatus("shell", "completed", "uname -a", "c1")
      await session.setToolStatus("shell", "completed", "uname -a", "c2")
      await session.setToolStatus("shell", "completed", "uname -a", "c3")

      const appended = appendedElements(cardkitClient)
      expect(appended).toHaveLength(1) // one line, updated in place
      expect(allContent(cardkitClient)).toContain("✅ shell · uname -a (×3)")
    })

    it("the head line shows the live per-tool counts", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.setToolStatus("shell", "completed", "uname -a", "c1")
      await session.setToolStatus("shell", "completed", "node -v", "c2")
      await session.setToolStatus("edit", "completed", "src/index.ts", "c3")

      const head = cardkitClient.updateElement.mock.calls.filter((c: any) => c[1] === "head").at(-1)!
      expect(head[2]).toContain("shell ×2")
      expect(head[2]).toContain("edit ×1")
    })
  })

  describe("ordering", () => {
    it("keeps the chronological order of tools and text", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.setToolStatus("shell", "completed", "uname -a", "c1")
      await session.setText("now the answer")
      await session.setToolStatus("shell", "completed", "node -v", "c2")

      const contents = allContent(cardkitClient)
      const tool1 = contents.findIndex((c) => c.includes("uname -a") && c.startsWith("✅"))
      const text = contents.findIndex((c) => c.includes("now the answer"))
      const tool2 = contents.findIndex((c) => c.includes("node -v") && c.startsWith("✅"))
      expect(tool1).toBeGreaterThanOrEqual(0)
      expect(text).toBeGreaterThan(tool1)
      expect(tool2).toBeGreaterThan(text)
    })
  })

  describe("close", () => {
    it("finalises the text and closes the card", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.setText("partial")
      await session.close("the final answer")

      const last = cardkitClient.updateElement.mock.calls.filter((c: any) => c[1] === "seg1").at(-1)!
      expect(last[2]).toBe("the final answer")
      expect(cardkitClient.closeStreaming).toHaveBeenCalledOnce()
    })

    it("close() is idempotent", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.close()
      await session.close()
      expect(cardkitClient.closeStreaming).toHaveBeenCalledOnce()
    })
  })
})
