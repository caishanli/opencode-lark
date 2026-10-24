/**
 * The little ring that shows how full the context window is.
 *
 * Feishu cards cannot draw an arc, and Unicode only offers quarter circles
 * (◔◑◕), so the ring is generated as a PNG and uploaded once per percentage.
 * Light grey is free, dark grey is used, starting at twelve o'clock.
 */

import { deflateSync } from "node:zlib"

const LIGHT: [number, number, number, number] = [222, 224, 227, 255] // free
const DARK: [number, number, number, number] = [95, 102, 114, 255] // used

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

/**
 * A donut PNG: `percent` of the ring in dark grey, the rest light grey,
 * transparent background. Drawn with 3x3 supersampling so the edge is smooth.
 */
export function renderRingPng(percent: number, size = 20): Buffer {
  const pct = Math.max(0, Math.min(100, percent))
  const center = (size - 1) / 2
  const outer = size / 2 - 0.5
  const inner = outer * 0.6
  const samples = 3
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)

  const pixel = (x: number, y: number): [number, number, number, number] => {
    const dx = x - center
    const dy = y - center
    const dist = Math.hypot(dx, dy)
    if (dist > outer || dist < inner) return [0, 0, 0, 0]
    // Angle from twelve o'clock, clockwise.
    let angle = Math.atan2(dx, -dy)
    if (angle < 0) angle += Math.PI * 2
    return angle / (Math.PI * 2) <= pct / 100 ? DARK : LIGHT
  }

  for (let y = 0; y < size; y++) {
    const row = y * stride
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const [pr, pg, pb, pa] = pixel(
            x + (sx + 0.5) / samples,
            y + (sy + 0.5) / samples,
          )
          r += pr
          g += pg
          b += pb
          a += pa
        }
      }
      const n = samples * samples
      const at = row + 1 + x * 4
      raw[at] = Math.round(r / n)
      raw[at + 1] = Math.round(g / n)
      raw[at + 2] = Math.round(b / n)
      raw[at + 3] = Math.round(a / n)
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
