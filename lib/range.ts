// radar-7 — lib/range.ts
//
// Small deterministic helpers shared by the value model and the odds
// model: a 32-bit FNV-1a seed hash, a mulberry32 seeded PRNG, linear
// interpolation quantiles, residual-quantile summaries, interval bounds
// built from those quantiles, and interval coverage.
//
// Nothing here keeps state between calls. Every function is pure: the
// caller supplies the data and the seed, and the result depends on
// nothing else. That matters because the board must reproduce
// byte-for-byte, so even the order in which numbers are added up is
// part of the contract — sums always walk their array from index 0
// upward, and sorts are JavaScript's stable sort with no extra
// tie-break invented on top. A second, quieter rule: no function here
// rounds a result the spec does not ask it to round; raw doubles flow
// through untouched until a caller explicitly rounds them.

/** The four residual quantiles the board's intervals are built from. */
export interface ResidualQuantiles {
  q10: number;
  q25: number;
  q75: number;
  q90: number;
}

/**
 * 32-bit FNV-1a hash of a string, returned as an unsigned number.
 *
 * Walks the string's UTF-16 code units (char codes), XOR-ing each one
 * into the running hash and then multiplying by the FNV prime with
 * 32-bit integer multiplication. The starting offset basis is the
 * standard 0x811c9dc5.
 *
 * This is deliberately a different function from the hex-string fnv1a
 * in lib/integrity.ts: that one hashes UTF-8 bytes and returns hex,
 * this one hashes UTF-16 code units and returns a number. They must
 * not be merged — the seed in lib/model.ts depends on this exact
 * variant.
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = hash ^ text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32: a tiny, fast, seedable PRNG returning values in [0, 1).
 *
 * The state starts as the seed taken unsigned, and each call advances
 * it by the golden-ratio constant 0x6d2b79f5, then scrambles it through
 * a few xor/multiply steps before scaling the top 32 bits down into
 * the unit interval. The entry uses exactly two instances of this
 * generator (a shuffle stream and a bootstrap stream); no other
 * randomness exists anywhere in the program, and Math.random is
 * never used.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Linear-interpolation quantile of a pre-sorted ascending array.
 *
 * `q` is in [0, 1]. The position `q * (length - 1)` usually falls
 * between two elements, and the result interpolates linearly between
 * them; when it lands exactly on an element, that element is the
 * answer. An empty array has no quantile, so it yields 0, and a
 * single-element array yields that element whatever `q` is.
 */
export function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const pos = q * (sortedValues.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo]!;
  const lower = sortedValues[lo]!;
  const upper = sortedValues[hi]!;
  return lower + (upper - lower) * (pos - lo);
}

/**
 * The four quantiles of a set of (log) residuals.
 *
 * Copies the residuals so the caller's array is untouched, sorts the
 * copy ascending, then reads the 10th, 25th, 75th and 90th
 * percentiles with the linear-interpolation rule above. These four
 * numbers are what shift an implied value into its P25–P75 and
 * P10–P90 bands.
 */
export function residualQuantiles(residuals: number[]): ResidualQuantiles {
  const sorted = [...residuals].sort((a, b) => a - b);
  return {
    q10: quantile(sorted, 0.1),
    q25: quantile(sorted, 0.25),
    q75: quantile(sorted, 0.75),
    q90: quantile(sorted, 0.9),
  };
}

/**
 * Interval bounds around an implied value, from residual quantiles.
 *
 * Each bound multiplies the implied value by e raised to the matching
 * quantile (a log-residual shifted back into ratio space), rounds to
 * the nearest whole dollar, and floors the result at $1 so no bound
 * can ever be zero or negative. The returned object is keyed
 * p25, p75, p10, p90 in that order.
 */
export function intervalBounds(
  impliedValueUsd: number,
  q: ResidualQuantiles,
): { p25: number; p75: number; p10: number; p90: number } {
  return {
    p25: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q25))),
    p75: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q75))),
    p10: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q10))),
    p90: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q90))),
  };
}

/**
 * The share of actual values that fall inside their paired interval.
 *
 * Positions are counted one by one, in order, with both ends
 * inclusive: `actual[i] >= lower[i] && actual[i] <= upper[i]`. An
 * empty input covers nothing, so it returns 0 rather than dividing
 * by zero. Used to check, honestly, whether the board's stated
 * 50% and 80% bands really caught that share of priced protocols
 * out of sample.
 */
export function coverageFraction(
  actual: number[],
  lower: number[],
  upper: number[],
): number {
  if (actual.length === 0) return 0;
  let inside = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i]! >= lower[i]! && actual[i]! <= upper[i]!) inside += 1;
  }
  return inside / actual.length;
}
