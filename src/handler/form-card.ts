/**
 * The question tool on opencode 2.1+ no longer posts to /api/question: it
 * creates a *form* with one field per question (`q0`, `q1`, ...), each with
 * options and a free-text "other" choice. Feishu cards can render that as a
 * real form — dropdowns, multi-select, an input and a submit button — and the
 * answer goes back through the form reply endpoint.
 */

import type { FormField, FormInfo } from "../opencode/gateway.js"

function text(content: string): Record<string, unknown> {
  return { tag: "plain_text", content }
}

function optionsOf(field: FormField): Record<string, unknown>[] {
  return (field.options ?? []).map((option) => ({
    text: text(option.label),
    value: option.value,
  }))
}

function controlFor(field: FormField): Record<string, unknown> {
  const options = field.options ?? []
  if (field.type === "multiselect" && options.length > 0) {
    return {
      tag: "multi_select_static",
      name: field.key,
      placeholder: text("可多选，提交前可反复调整"),
      options: optionsOf(field),
    }
  }
  if (options.length > 0) {
    return {
      tag: "select_static",
      name: field.key,
      placeholder: text("选择一项"),
      options: optionsOf(field),
    }
  }
  if (field.type === "boolean") {
    return {
      tag: "select_static",
      name: field.key,
      placeholder: text("选择"),
      options: [
        { text: text("是"), value: "true" },
        { text: text("否"), value: "false" },
      ],
    }
  }
  return {
    tag: "input",
    name: field.key,
    placeholder: text(field.type === "string" ? "输入答案" : "输入数字"),
  }
}

export function buildFormCard(form: FormInfo): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []
  const controls: Record<string, unknown>[] = []

  for (const field of form.fields) {
    const heading = field.title?.trim()
    const description = field.description?.trim()
    if (heading || description) {
      elements.push({
        tag: "markdown",
        content: [heading ? `**${heading}**` : "", description ?? ""]
          .filter(Boolean)
          .join("\n"),
      })
    }

    controls.push(controlFor(field))

    if (field.custom) {
      controls.push({
        tag: "input",
        name: `${field.key}__other`,
        placeholder: text(
          field.type === "multiselect"
            ? "其他答案（多个用逗号分隔，可选）"
            : "其他答案（可选）",
        ),
      })
    }
  }

  controls.push({
    tag: "button",
    name: "submit",
    text: text("提交"),
    type: "primary",
    action_type: "form_submit",
    value: { action: "form_submit", sessionId: form.sessionID, formId: form.id },
  })

  elements.push({ tag: "form", name: `form_${form.id}`, elements: controls })

  const title = form.title?.trim()
  return {
    config: { wide_screen_mode: true },
    header: {
      title: text(`❓ ${title && title !== "Questions" ? title : "需要你选择"}`),
      template: "orange",
    },
    elements,
  }
}

export function buildAnsweredFormCard(): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: text("✅ 已回答"),
      template: "green",
    },
    elements: [{ tag: "markdown", content: "问题已在飞书回答，opencode 继续执行。" }],
  }
}

/**
 * Turn the submitted form values into the answer object the server expects.
 * A typed "other" answer wins over the dropdown; on multi-select the typed
 * answer is appended (comma separated).
 */
export function formAnswer(
  form: FormInfo,
  values: Record<string, unknown>,
): Record<string, string | string[]> {
  const answer: Record<string, string | string[]> = {}

  for (const field of form.fields) {
    const raw = values[field.key]
    const other = values[`${field.key}__other`]
    const custom = typeof other === "string" ? other.trim() : ""

    if (field.type === "multiselect") {
      const picked = Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === "string" && v !== "")
        : []
      const typed = custom
        ? custom.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        : []
      const merged = [...picked, ...typed]
      if (merged.length > 0) answer[field.key] = merged
      continue
    }

    if (custom) {
      answer[field.key] = custom
      continue
    }
    if (typeof raw === "boolean") {
      answer[field.key] = String(raw)
      continue
    }
    if (raw === undefined || raw === null) continue
    if (Array.isArray(raw)) {
      const first = raw.find((v) => typeof v === "string" && v !== "")
      if (typeof first === "string") answer[field.key] = first
      continue
    }
    const value = String(raw)
    if (value !== "") answer[field.key] = value
  }

  return answer
}
