import { describe, it, expect } from "vitest"
import { buildFormCard, buildAnsweredFormCard, formAnswer } from "../form-card.js"
import type { FormInfo } from "../../opencode/gateway.js"

const FORM: FormInfo = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Questions",
  fields: [
    {
      key: "q0",
      type: "string",
      title: "Mode",
      description: "Pick one",
      options: [
        { value: "A", label: "A" },
        { value: "B", label: "B" },
      ],
      custom: true,
    },
    {
      key: "q1",
      type: "multiselect",
      title: "Extras",
      description: "Pick many",
      options: [
        { value: "X", label: "X" },
        { value: "Y", label: "Y" },
      ],
      custom: true,
    },
  ],
}

function controlsOf(card: Record<string, unknown>): Record<string, unknown>[] {
  const form = (card.elements as Record<string, unknown>[]).find((e) => e.tag === "form")
  return (form?.elements as Record<string, unknown>[]) ?? []
}

describe("buildFormCard", () => {
  it("renders one control per field plus a custom input and a submit", () => {
    const card = buildFormCard(FORM)
    const controls = controlsOf(card)

    expect(controls.map((c) => c.tag)).toEqual([
      "select_static",
      "input",
      "multi_select_static",
      "input",
      "button",
    ])
    expect(controls[0]).toMatchObject({ name: "q0" })
    expect(controls[1]).toMatchObject({ name: "q0__other" })
    expect(controls[2]).toMatchObject({ name: "q1" })
    expect(controls[3]).toMatchObject({ name: "q1__other" })
    expect(controls[4]).toMatchObject({
      name: "submit",
      action_type: "form_submit",
      value: { action: "form_submit", sessionId: "ses_1", formId: "frm_1" },
    })
  })

  it("names the form container and every interactive child (Feishu requires it)", () => {
    const card = buildFormCard(FORM)
    const form = (card.elements as Record<string, unknown>[]).find((e) => e.tag === "form")
    expect(form?.name).toBe("form_frm_1")
    for (const control of controlsOf(card)) {
      expect(control.name).toBeTruthy()
    }
  })

  it("shows the question text and options", () => {
    const card = buildFormCard(FORM)
    expect((card.header as any).title.content).toBe("❓ 需要你选择")
    expect((card.elements as any)[0].content).toContain("**Mode**")
    expect((card.elements as any)[0].content).toContain("Pick one")
    expect(controlsOf(card)[0].options).toEqual([
      { text: { tag: "plain_text", content: "A" }, value: "A" },
      { text: { tag: "plain_text", content: "B" }, value: "B" },
    ])
  })

  it("uses the form title when it is not the generic one", () => {
    const card = buildFormCard({ ...FORM, title: "Pick a database" })
    expect((card.header as any).title.content).toBe("❓ Pick a database")
  })

  it("builds an answered card", () => {
    const card = buildAnsweredFormCard()
    expect((card.header as any).title.content).toContain("已回答")
  })
})

describe("formAnswer", () => {
  it("takes the selected value", () => {
    expect(formAnswer(FORM, { q0: "A" })).toEqual({ q0: "A" })
  })

  it("lets a typed answer win over the dropdown", () => {
    expect(formAnswer(FORM, { q0: "A", q0__other: " something else " })).toEqual({
      q0: "something else",
    })
  })

  it("merges multi-select picks with comma-separated custom answers", () => {
    expect(formAnswer(FORM, { q1: ["X"], q1__other: "Y, Z" })).toEqual({
      q1: ["X", "Y", "Z"],
    })
  })

  it("skips fields with nothing chosen", () => {
    expect(formAnswer(FORM, {})).toEqual({})
  })
})
