/**
 * Formatting helpers for the token/rate line shown on the reply card.
 */

/** 1234 -> "1.2k", 999 -> "999", 1_500_000 -> "1.5M", 1_004_600_000 -> "1.00B" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  // Past a billion two decimals are needed: at the session's scale a single
  // decimal ("1.0B") would not change for millions of tokens.
  // 999.95M would print as "1000.0M" — promote it to B instead.
  if (abs >= 999_950_000) return `${(n / 1_000_000_000).toFixed(2)}B`
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

/**
 * Cache hit rate: how much of the prompt context was served from the prompt
 * cache rather than re-sent as fresh input tokens.
 *
 *   cache.read  — input tokens read from the cache (a hit)
 *   input       — input tokens that were NOT cached (a miss)
 */
/**
 * A percentage with enough precision to stay meaningful: a warm cache reads
 * 99.986% of the prompt, and rounding that to "100%" hides the fact that
 * the new message was not cached at all.
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0"
  const pct = value * 100
  if (pct >= 99.995) return "100"
  return pct.toFixed(2).replace(/\.?0+$/, "")
}

export function cacheHitRate(tokens: {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}): number {
  const read = tokens.cache?.read ?? 0
  const fresh = tokens.input ?? 0
  const denominator = read + fresh
  return denominator > 0 ? read / denominator : 0
}
