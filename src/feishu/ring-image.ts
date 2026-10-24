/**
 * The context-window ring, rendered the way ZCode draws it in its web UI.
 *
 * ZCode's `ContextIcon` is a 24×24 SVG: radius 10, stroke 4, the track at 25%
 * opacity, the used arc at 70%, round caps, starting at twelve o'clock and
 * running clockwise. A Feishu card cannot inline SVG, but a markdown
 * component's `icon` is rendered small — so the same ring is generated as a
 * PNG and uploaded once per percentage.
 */

import { deflateSync } from "node:zlib"

/** currentColor in the status line: the muted grey of the card text. */
const COLOR: [number, number, number] = [95, 102, 114]
/** Same colour, 25% for the track and 70% for the used arc (ZCode values). */
const TRACK_ALPHA = 64
const ARC_ALPHA = 179
/** ZCode's 4px stroke on a 24px box. */
const STROKE_RATIO = 4 / 24

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] ?? 0
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/** A transparent PNG: a grey ring with `percent` of it drawn darker. */
export function renderRingPng(percent: number, size = 20): Buffer {
  const pct = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  const center = (size - 1) / 2
  const outer = size / 2
  const stroke = size * STROKE_RATIO
  const radius = outer - stroke / 2
  const inner = radius - stroke / 2
  const capRadius = stroke / 2
  const endAngle = (pct / 100) * Math.PI * 2
  const endX = radius * Math.sin(endAngle)
  const endY = -radius * Math.cos(endAngle)
  const samples = 4
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)

  const alphaAt = (x: number, y: number): number => {
    const dx = x - center
    const dy = y - center
    const dist = Math.hypot(dx, dy)

    if (pct > 0) {
      // Round caps extend a little beyond the band, like strokeLinecap="round".
      const nearCap =
        Math.hypot(dx, dy + radius) <= capRadius ||
        Math.hypot(dx - endX, dy - endY) <= capRadius
      let angle = Math.atan2(dx, -dy)
      if (angle < 0) angle += Math.PI * 2
      if ((dist >= inner && dist <= outer && angle <= endAngle) || nearCap) {
        return ARC_ALPHA
      }
    }

    return dist >= inner && dist <= outer ? TRACK_ALPHA : 0
  }

  for (let y = 0; y < size; y++) {
    const row = y * stride
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      let alpha = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          alpha += alphaAt(
            x + (sx + 0.5) / samples,
            y + (sy + 0.5) / samples,
          )
        }
      }
      const at = row + 1 + x * 4
      raw[at] = COLOR[0]
      raw[at + 1] = COLOR[1]
      raw[at + 2] = COLOR[2]
      raw[at + 3] = Math.round(alpha / (samples * samples))
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
