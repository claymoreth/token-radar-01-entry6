// radar-7 — intervals from held-out misses, and the seeded dice.
//
// The value model works in logs, so its mistakes are log mistakes: a
// residual of +0.4 means the real cap landed e^0.4 above the guess.
// A row's band is its implied value shifted by the quantiles of the
// model's own out-of-sample residuals — no assumed bell curve, just
// the misses the model actually made when it had never seen the row.
//
// Honesty is then measured the blunt way: of the priced protocols,
// how many real caps fell inside the band that promised to hold half
// of them (P25–P75) or four fifths (P10–P90)? A band that cannot keep
// its promise is shown as a miss, never re-labelled.
//
// Nothing here rolls real dice: the only randomness is a seeded
// generator, so the same snapshot always replays the same numbers.
// The seed is a hash of the snapshot's own date plus its slug list,
// so a different snapshot gets a different stream.

// FNV-1a, 32-bit, over a string: a small deterministic hash used for
// seeding. Offset 0x811c9dc5, prime 0x01000193, Math.imul for the
// multiply so the wrap is exact.
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// mulberry32: a tiny seeded generator with a full 32-bit period per
// seed. Never Math.random anywhere in this entry.
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Quantile of a sorted array by linear interpolation. q in [0, 1].
export function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const pos = q * (sortedValues.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

export interface ResidualQuantiles {
  q10: number;
  q25: number;
  q75: number;
  q90: number;
}

// The four quantiles of held-out log residuals (actual minus
// predicted, in log space), sorted once and read four times.
export function residualQuantiles(residuals: number[]): ResidualQuantiles {
  const sorted = [...residuals].sort((a, b) => a - b);
  return {
    q10: quantile(sorted, 0.1),
    q25: quantile(sorted, 0.25),
    q75: quantile(sorted, 0.75),
    q90: quantile(sorted, 0.9),
  };
}

// One row's interval from its implied value and the model's residual
// quantiles. Bounds are whole dollars, at least $1, and ordered by
// construction (quantiles are ordered, exp is monotone).
export function intervalBounds(
  impliedValueUsd: number,
  q: ResidualQuantiles,
): { p25: number; p75: number; p10: number; p90: number } {
  const p25 = Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q25)));
  const p75 = Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q75)));
  const p10 = Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q10)));
  const p90 = Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q90)));
  return { p25, p75, p10, p90 };
}

// Share of actual values inside [lower, upper], inclusive. The
// honesty check: compare this against the stated share.
export function coverageFraction(actual: number[], lower: number[], upper: number[]): number {
  if (actual.length === 0) return 0;
  let inside = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] >= lower[i] && actual[i] <= upper[i]) inside++;
  }
  return inside / actual.length;
}
