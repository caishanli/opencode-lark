/**
 * Convert agent Markdown into the subset Feishu message cards can actually render.
 *
 * Feishu's card Markdown component supports: line breaks, *italic*, **bold**,
 * ~~strikethrough~~, links, <at>, colours, images, `---`, emoji, text tags,
 * ordered/unordered lists and fenced code blocks.
 *
 * It does NOT support GFM tables, `#` headings, task-list checkboxes or `>`
 * blockquotes — those render as literal punctuation. This module rewrites them
 * into supported equivalents and leaves everything else (including fenced code
 * blocks) untouched.
 */

const FENCE_RE = /^\s*(```|~~~)/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/
const QUOTE_RE = /^>\s?(.*)$/
const RULE_RE = /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const IMAGE_RE = /!\[([^\]]*)\]\(([^)]*)\)/g

/**
 * Feishu treats every `![alt](target)` as an image and validates the target
 * as an image_key; one bad key makes it reject the whole card (230099). Agent
 * text never carries Feishu image keys — the context ring is built by the
 * bridge and does not pass through here — so render images as links (http) or
 * plain text instead. Fenced code is safe: Feishu does not parse images there.
 */
function neutralizeImages(line: string): string {
  return line.replace(IMAGE_RE, (_match, alt: string, raw: string) => {
    const target = raw.trim().split(/\s+/)[0] ?? ""
    const label = alt.trim() || "图片"
    if (!target) return label
    if (/^https?:\/\//i.test(target)) return `[${label}](${target})`
    return `${label}（${target}）`
  })
}

function neutralizeImagesOutsideFences(markdown: string): string {
  let inFence = false
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence
        return line
      }
      return inFence ? line : neutralizeImages(line)
    })
    .join("\n")
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|")) s = s.slice(0, -1)
  return s.split("|").map((c) => c.trim())
}

function isTableHeader(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length) return false
  if (!lines[i]!.includes("|")) return false
  const delim = lines[i + 1]!
  if (!delim.includes("-")) return false
  if (!TABLE_DELIM_RE.test(delim)) return false
  // Delimiter must have a cell per header column (rough shape check).
  return splitRow(delim).length >= 1 && splitRow(lines[i]!).length >= 1
}

/** Render a GFM table as a Feishu-friendly nested list (4 spaces = one level). */
function convertTable(header: string[], rows: string[][]): string[] {
  const out: string[] = []
  for (const row of rows) {
    const cells = [...row]
    const first = cells.shift() ?? ""
    const label = first || header[0] || ""
    out.push(label ? `- **${label}**` : "-")
    cells.forEach((value, idx) => {
      if (!value) return
      const key = header[idx + 1] ?? `列${idx + 2}`
      out.push(`    - ${key}：${value}`)
    })
  }
  return out
}

export function toFeishuMarkdown(text: string): string {
  if (!text) return text
  const lines = text.split("\n")
  const out: string[] = []
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (FENCE_RE.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }

    // GFM table -> nested list
    if (isTableHeader(lines, i)) {
      const header = splitRow(line)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== "") {
        rows.push(splitRow(lines[j]!))
        j++
      }
      out.push(...convertTable(header, rows))
      i = j - 1
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      out.push(`**${heading[2]!.trim()}**`)
      continue
    }

    const task = line.match(TASK_RE)
    if (task) {
      const box = task[2]!.toLowerCase() === "x" ? "☑" : "☐"
      out.push(`${task[1]}- ${box} ${task[3]!}`)
      continue
    }

    const quote = line.match(QUOTE_RE)
    if (quote) {
      out.push(quote[1] ? `▎ ${quote[1]}` : "▎")
      continue
    }

    if (RULE_RE.test(line)) {
      out.push("---")
      continue
    }

    // Normalise nested-list indentation: Feishu needs 4 spaces per level.
    const listItem = line.match(/^(\s+)([-*+]\s+.*)$/)
    if (listItem) {
      const spaces = listItem[1]!.length
      const level = Math.max(1, Math.round(spaces / 2))
      out.push("    ".repeat(level) + listItem[2]!)
      continue
    }

    out.push(line)
  }

  return neutralizeImagesOutsideFences(out.join("\n"))
}
