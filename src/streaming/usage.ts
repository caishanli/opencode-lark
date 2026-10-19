/**
 * Formatting helpers for the token/rate line shown on the reply card.
 */

/** 1234 -> "1.2k", 999 -> "999", 1_500_000 -> "1.5M" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/** 1234.5 -> "1.2k", 42.3 -> "42.3" */
export function formatRate(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  if (abs >= 100) return String(Math.round(n))
  return n.toFixed(1)
}

/** Total tokens of a usage report, counting cached reads (they are real context). */
export function totalTokens(tokens: {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}): number {
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  )
}
