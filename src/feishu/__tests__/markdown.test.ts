import { describe, it, expect } from "vitest"
import { toFeishuMarkdown } from "../markdown.js"

describe("toFeishuMarkdown", () => {
  it("converts a GFM table into a nested list keyed by header", () => {
    const md = [
      "| # | 验收标准 | 状态 |",
      "| --- | --- | --- |",
      "| 1 | 连上 5096 | ⚠️ 部分 |",
      "| 2 | 流式卡片 | ✅ |",
    ].join("\n")
    const out = toFeishuMarkdown(md)
    expect(out).not.toContain("|")
    expect(out).toContain("- **1**")
    expect(out).toContain("- 验收标准：连上 5096")
    expect(out).toContain("- 状态：⚠️ 部分")
    expect(out).toContain("- **2**")
  })

  it("keeps a two-column table readable", () => {
    const md = ["| 键 | 值 |", "| --- | --- |", "| a | 1 |"].join("\n")
    const out = toFeishuMarkdown(md)
    expect(out).toBe("- **a**\n    - 值：1")
  })

  it("turns headings into bold lines", () => {
    expect(toFeishuMarkdown("## 总结")).toBe("**总结**")
    expect(toFeishuMarkdown("### a b c")).toBe("**a b c**")
  })

  it("turns task-list checkboxes into supported glyphs", () => {
    expect(toFeishuMarkdown("- [ ] todo")).toBe("- ☐ todo")
    expect(toFeishuMarkdown("- [x] done")).toBe("- ☑ done")
  })

  it("turns blockquotes into a quote bar", () => {
    expect(toFeishuMarkdown("> quoted")).toBe("▎ quoted")
  })

  it("normalises horizontal rules to ---", () => {
    expect(toFeishuMarkdown("***")).toBe("---")
    expect(toFeishuMarkdown("___")).toBe("---")
  })

  it("normalises 2-space nested list indentation to Feishu's 4 spaces", () => {
    expect(toFeishuMarkdown("- a\n  - b")).toBe("- a\n    - b")
  })

  it("leaves fenced code blocks completely untouched", () => {
    const md = ["```md", "# not a heading", "| a | b |", "```"].join("\n")
    expect(toFeishuMarkdown(md)).toBe(md)
  })

  it("neutralises image syntax Feishu would reject", () => {
    // Feishu parses image syntax even inside inline code and then validates
    // the target as an image_key — one bad key fails the whole card.
    expect(toFeishuMarkdown("用 `![pct](img_key)` 内嵌")).toBe("用 `pct（img_key）` 内嵌")
    expect(toFeishuMarkdown("![截图](https://x.dev/a.png)")).toBe("[截图](https://x.dev/a.png)")
    expect(toFeishuMarkdown("![只有说明]()")).toBe("只有说明")
  })

  it("leaves images inside fenced code blocks alone", () => {
    const md = ["```md", "![pct](img_key)", "```"].join("\n")
    expect(toFeishuMarkdown(md)).toBe(md)
  })

  it("leaves supported syntax and plain prose alone", () => {
    const md = "**bold** *italic* ~~strike~~ [link](https://x.dev)\n\n- item\n1. one"
    expect(toFeishuMarkdown(md)).toBe(md)
  })

  it("returns empty input unchanged", () => {
    expect(toFeishuMarkdown("")).toBe("")
  })
})
