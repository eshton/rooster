/**
 * Reciprocal Rank Fusion (RRF) — combine several independently-ranked result
 * lists (e.g. keyword/FTS and vector/semantic) into one ranking without needing
 * their scores to be comparable. Each list contributes `1 / (k + rank)` to an
 * item's fused score, so an item near the top of several lists outranks one that
 * is #1 in a single list. `k` (default 60, the standard constant) damps the
 * influence of very high ranks. Items are matched across lists by `key`.
 */
export interface Ranked {
  /** Stable identity used to match the same item across lists. */
  key: string
}

export interface FusedResult<T extends Ranked> {
  key: string
  score: number
  /** The first-seen item carrying this key (all lists share the same shape). */
  item: T
}

export function reciprocalRankFusion<T extends Ranked>(
  lists: T[][],
  opts: { k?: number } = {},
): FusedResult<T>[] {
  const k = opts.k ?? 60
  const fused = new Map<string, FusedResult<T>>()
  for (const list of lists) {
    list.forEach((item, i) => {
      const contribution = 1 / (k + (i + 1))
      const existing = fused.get(item.key)
      if (existing) existing.score += contribution
      else fused.set(item.key, { key: item.key, score: contribution, item })
    })
  }
  return [...fused.values()].sort((a, b) => b.score - a.score)
}
