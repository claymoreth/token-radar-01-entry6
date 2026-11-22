// radar-7 — token-odds model.
//
// Question: for a protocol with no token yet, how likely is its token
// to actually TRADE? The target is 1 when the token trades — a
// positive market cap on a positive TVL — and 0 when DefiLlama records
// no token at all (no CoinGecko id and no symbol). Protocols in
// between — a ticker is recorded but the cap is null, zero or
// negative — are left OUT of training entirely: they are neither a
// traded token nor a tokenless protocol, and forcing them into either
// side would teach the model the wrong question. That three-way split
// lives in lib/model.ts, where the training rows are built; this file
// only ever sees the y it is handed, and fits whatever it is given.
//
// That is a narrower, harder question than "does DefiLlama record a
// ticker?": a recorded ticker can belong to a parent product, a
// sub-product line sharing the parent's ticker, or a token that never
// trades on its own. The traded-token target costs us training rows
// (about 290 instead of 442) and a lower base rate (about 32% instead
// of 55%), but it is far steadier over time: its walk-forward Brier
// beats its own baseline by a wide margin, where the ticker-recorded
// target barely improves on its baseline at all. The dashboard
// evidence says so in plain words, including the trade-off.
//
// The model is a logistic regression written from scratch on the Node
// standard library only: full-batch gradient descent on the design
// columns, a ridge penalty on every weight except the bias, a sigmoid
// with its input clamped so it can never overflow. Numeric features
// are standardised and carry L2=1; family and category enter as
// separate groups of raw 0/1 dummies carrying ridge λ=16 each
// (a single standardised family/category block was measured to wreck
// walk-forward in an earlier round, Brier 0.3011). Nothing is
// hardcoded: every level, mean, scale and weight is fitted at run
// time from the snapshot handed in.
//
// Feature groups are added one at a time, in the order below, and a
// group is kept only when it lowers the Brier score in BOTH held-out
// tests — ten-fold cross-validation and a chronological walk-forward —
// against the groups kept so far. A group that helps one test and
// hurts the other is reported as "tested, not kept", not used.
//
// Odds are clipped to [0.02, 0.98]: a protocol is never priced as
// certainly tokenless (which would collapse its implied value to
// zero) or certainly tokenised.

export interface OddsRow {
  slug: string;
  listedAt: string | null;
  ageYears: number | null;
  lnTvl: number;
  growthRaw: number | null;
  lnChains: number;
  family: string;
  category: string;
  y: number; // 1 = token trades (positive cap on positive TVL), 0 = no token recorded at all
}

export type OddsTermKept = "kept" | "tested, not kept" | "baseline";

export interface OddsTermEvidence {
  name: string;
  brier: number;
  wfBrier: number;
  kept: OddsTermKept;
}

export interface OddsEvidence {
  n: number;
  baseRate: number;
  baselineBrier: number;
  baselineWfBrier: number;
  finalBrier: number;
  finalWfBrier: number;
  walkForwardCorrect: number;
  terms: OddsTermEvidence[];
}

// Feature groups, in the order they are tested. Family and category
// are TWO separate groups, not one combined block: each enters as raw
// 0/1 dummies (no standardisation) with its own ridge penalty λ=16,
// while the numeric groups are standardised and carry L2=1. Order
// follows the experiment: age, ln(TVL) and growth first (the numeric
// base), then family, then category, then chain count. Families seen
// once in training carry no signal and are folded into "other" by the
// level rule below.
export const ODDS_GROUPS = ["age", "lntvl", "growth", "family", "category", "lnch"] as const;
export type OddsGroup = (typeof ODDS_GROUPS)[number];

const GROUP_LABELS: Record<OddsGroup, string> = {
  age: "age (years listed)",
  lntvl: "ln(TVL)",
  growth: "7-day TVL growth",
  family: "family (ridge 16, raw dummies)",
  category: "category (ridge 16, raw dummies)",
  lnch: "chain count (ln)",
};

interface OddsStats {
  meanAge: number;
  meanGrowth: number;
  catLevels: string[];
  famLevels: string[];
  means: number[];
  sds: number[];
}

interface OddsModel {
  groups: OddsGroup[];
  stats: OddsStats;
  weights: number[]; // weights[0] is the bias; the rest follow the design columns
  baseRate: number;
}

function sigmoid(z: number): number {
  const c = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-c));
}

// Raw design columns for one row, before standardisation. The column
// order is fixed: groups in ODDS_GROUPS order; a family group pushes
// one raw 0/1 dummy per family level, a category group one per
// category level. A group not in `groups` contributes nothing.
// Numeric columns are standardised downstream; family/category
// dummies are NOT (see columnInfo) — standardising the one-hots was
// measured to wreck walk-forward in an earlier round.
function rawColumns(row: OddsRow, groups: OddsGroup[], stats: OddsStats): number[] {
  const cols: number[] = [];
  for (const g of groups) {
    if (g === "age") {
      cols.push(row.ageYears ?? stats.meanAge);
    } else if (g === "lntvl") {
      cols.push(row.lnTvl);
    } else if (g === "growth") {
      const v = row.growthRaw ?? stats.meanGrowth;
      cols.push(Math.max(-0.9, Math.min(3, v)));
    } else if (g === "lnch") {
      cols.push(row.lnChains);
    } else if (g === "family") {
      for (const lv of stats.famLevels) cols.push(row.family === lv ? 1 : 0);
    } else if (g === "category") {
      for (const lv of stats.catLevels) cols.push(row.category === lv ? 1 : 0);
    }
  }
  return cols;
}

// Per-column metadata aligned with rawColumns: whether the column is
// a raw 0/1 dummy (family/category) and the ridge penalty it carries.
// Numeric columns are standardised and carry L2=1; family and
// category dummies stay raw and carry λ=16 each.
function columnInfo(groups: OddsGroup[], stats: OddsStats): { raw: boolean[]; penalty: number[] } {
  const raw: boolean[] = [];
  const penalty: number[] = [];
  for (const g of groups) {
    if (g === "family") {
      for (let i = 0; i < stats.famLevels.length; i++) {
        raw.push(true);
        penalty.push(16);
      }
    } else if (g === "category") {
      for (let i = 0; i < stats.catLevels.length; i++) {
        raw.push(true);
        penalty.push(16);
      }
    } else {
      raw.push(false);
      penalty.push(1);
    }
  }
  return { raw, penalty };
}

// Fit-time statistics: imputation means, one-hot levels, and the
// standardisation means/scales. Levels and scales come from the
// training rows only, so a held-out row can never leak into them.
function fitStats(rows: OddsRow[], groups: OddsGroup[]): OddsStats {
  const ages = rows.map((r) => r.ageYears).filter((a): a is number => a !== null);
  const growths = rows.map((r) => r.growthRaw).filter((a): a is number => a !== null);
  const meanAge = ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : 0;
  const meanGrowth = growths.length > 0 ? growths.reduce((a, b) => a + b, 0) / growths.length : 0;
  const famCounts = new Map<string, number>();
  for (const r of rows) famCounts.set(r.family, (famCounts.get(r.family) ?? 0) + 1);
  const famLevels = [...famCounts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([k]) => k)
    .sort();
  const catLevels = [...new Set(rows.map((r) => r.category))].sort();
  const stats: OddsStats = { meanAge, meanGrowth, catLevels, famLevels, means: [], sds: [] };
  const raw = rows.map((r) => rawColumns(r, groups, stats));
  const d = raw.length > 0 ? raw[0].length : 0;
  stats.means = [];
  stats.sds = [];
  for (let j = 0; j < d; j++) {
    const mean = raw.reduce((a, row) => a + row[j], 0) / raw.length;
    const variance = raw.reduce((a, row) => a + (row[j] - mean) * (row[j] - mean), 0) / raw.length;
    stats.means.push(mean);
    stats.sds.push(variance > 1e-12 ? Math.sqrt(variance) : 1);
  }
  // Raw dummy columns are not standardised: mean 0, scale 1, so the
  // design matrix passes the 0/1 values through unchanged.
  const info = columnInfo(groups, stats);
  for (let j = 0; j < d; j++) {
    if (info.raw[j]) {
      stats.means[j] = 0;
      stats.sds[j] = 1;
    }
  }
  return stats;
}

function designMatrix(rows: OddsRow[], groups: OddsGroup[], stats: OddsStats): number[][] {
  return rows.map((r) => {
    const raw = rawColumns(r, groups, stats);
    return raw.map((v, j) => (v - stats.means[j]) / stats.sds[j]);
  });
}

function fitLogistic(x: number[][], y: number[], penalties: number[]): number[] {
  const n = x.length;
  const d = n > 0 ? x[0].length : 0;
  const w = new Array<number>(d + 1).fill(0);
  const lr = 0.15;
  const iters = 1000;
  for (let it = 0; it < iters; it++) {
    const grad = new Array<number>(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let z = w[0];
      for (let j = 0; j < d; j++) z += w[j + 1] * x[i][j];
      const err = sigmoid(z) - y[i];
      grad[0] += err;
      for (let j = 0; j < d; j++) grad[j + 1] += err * x[i][j];
    }
    let biggest = 0;
    for (let j = 0; j <= d; j++) {
      // penalties[j-1] is the ridge penalty of design column j-1:
      // 1 for a standardised numeric column, 16 for a raw
      // family/category dummy. The bias (j=0) is unpenalised.
      const penalty = j === 0 ? 0 : (penalties[j - 1] * w[j]) / n;
      const step = lr * (grad[j] / n + penalty);
      w[j] -= step;
      if (Math.abs(step) > biggest) biggest = Math.abs(step);
    }
    if (biggest < 1e-9) break;
  }
  return w;
}

function fitOdds(rows: OddsRow[], groups: OddsGroup[], baseRate: number): OddsModel {
  const stats = fitStats(rows, groups);
  const x = designMatrix(rows, groups, stats);
  const weights = fitLogistic(x, rows.map((r) => r.y), columnInfo(groups, stats).penalty);
  return { groups, stats, weights, baseRate };
}

export function predictOdds(model: OddsModel, row: OddsRow): number {
  const raw = rawColumns(row, model.groups, model.stats);
  const x = raw.map((v, j) => (v - model.stats.means[j]) / model.stats.sds[j]);
  let z = model.weights[0];
  for (let j = 0; j < x.length; j++) z += model.weights[j + 1] * x[j];
  const p = sigmoid(z);
  return Math.max(0.02, Math.min(0.98, p));
}

function brierScore(predicted: number[], actual: number[]): number {
  let total = 0;
  for (let i = 0; i < actual.length; i++) total += (predicted[i] - actual[i]) ** 2;
  return actual.length > 0 ? total / actual.length : 0;
}

// Chronological expanding-window folds over rows already sorted by
// (listed_at, slug): four near-equal blocks, train on the earlier
// blocks, test on the next one. Every test fold holds at least 20
// rows whenever the dated set holds at least 80.
export function expandingFolds<T>(sortedRows: T[]): { train: T[]; test: T[] }[] {
  const n = sortedRows.length;
  const chunks = 4;
  const base = Math.floor(n / chunks);
  const extra = n - base * chunks;
  const sizes: number[] = [];
  for (let i = 0; i < chunks; i++) sizes.push(base + (i < extra ? 1 : 0));
  const blocks: T[][] = [];
  let at = 0;
  for (const size of sizes) {
    blocks.push(sortedRows.slice(at, at + size));
    at += size;
  }
  const folds: { train: T[]; test: T[] }[] = [];
  for (let k = 0; k < chunks - 1; k++) {
    folds.push({ train: blocks.slice(0, k + 1).flat(), test: blocks[k + 1] });
  }
  return folds;
}

function tenFoldBrier(rows: OddsRow[], groups: OddsGroup[]): number {
  const ordered = [...rows].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const predicted: number[] = new Array<number>(ordered.length).fill(0);
  for (let fold = 0; fold < 10; fold++) {
    const train = ordered.filter((_, i) => i % 10 !== fold);
    const test = ordered.filter((_, i) => i % 10 === fold);
    if (test.length === 0) continue;
    const baseRate = train.reduce((a, r) => a + r.y, 0) / train.length;
    const model = fitOdds(train, groups, baseRate);
    test.forEach((row) => {
      predicted[ordered.indexOf(row)] = predictOdds(model, row);
    });
  }
  return brierScore(predicted, ordered.map((r) => r.y));
}

function walkForwardBrier(
  rows: OddsRow[],
  groups: OddsGroup[],
): { brier: number; correct: number; n: number; predicted: number[]; actual: number[] } {
  const dated = [...rows]
    .filter((r) => r.listedAt !== null)
    .sort((a, b) => {
      if (a.listedAt !== b.listedAt) return a.listedAt! < b.listedAt! ? -1 : 1;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const fold of expandingFolds(dated)) {
    const baseRate = fold.train.reduce((a, r) => a + r.y, 0) / fold.train.length;
    const model = fitOdds(fold.train, groups, baseRate);
    for (const row of fold.test) {
      predicted.push(predictOdds(model, row));
      actual.push(row.y);
    }
  }
  const baseRate = rows.reduce((a, r) => a + r.y, 0) / rows.length;
  const correct =
    actual.length > 0
      ? actual.filter((y, i) => (predicted[i] > baseRate ? 1 : 0) === y).length / actual.length
      : 0;
  return { brier: brierScore(predicted, actual), correct, n: actual.length, predicted, actual };
}

function baselineWalkForwardBrier(rows: OddsRow[]): number {
  const dated = [...rows]
    .filter((r) => r.listedAt !== null)
    .sort((a, b) => {
      if (a.listedAt !== b.listedAt) return a.listedAt! < b.listedAt! ? -1 : 1;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const fold of expandingFolds(dated)) {
    const rate = fold.train.reduce((a, r) => a + r.y, 0) / fold.train.length;
    for (const row of fold.test) {
      predicted.push(rate);
      actual.push(row.y);
    }
  }
  return brierScore(predicted, actual);
}

// Fit the odds model with sequential term selection. Returns the final
// model (fitted on all training rows with the kept groups), the model
// to use for board predictions, and the evidence table.
export function fitOddsWithEvidence(rows: OddsRow[]): { model: OddsModel; evidence: OddsEvidence } {
  const baseRate = rows.reduce((a, r) => a + r.y, 0) / rows.length;
  const baselineBrier = brierScore(
    rows.map(() => baseRate),
    rows.map((r) => r.y),
  );
  const baselineWfBrier = baselineWalkForwardBrier(rows);
  const terms: OddsTermEvidence[] = [
    { name: "intercept-only (base rate)", brier: baselineBrier, wfBrier: baselineWfBrier, kept: "baseline" },
  ];
  let kept: OddsGroup[] = [];
  let bestBrier = baselineBrier;
  let bestWfBrier = baselineWfBrier;
  let finalBrier = baselineBrier;
  let finalWfBrier = baselineWfBrier;
  let finalCorrect = 0;
  for (const group of ODDS_GROUPS) {
    const candidate = [...kept, group];
    const brier = tenFoldBrier(rows, candidate);
    const wf = walkForwardBrier(rows, candidate);
    const helps = brier < bestBrier && wf.brier < bestWfBrier;
    terms.push({
      name: GROUP_LABELS[group],
      brier,
      wfBrier: wf.brier,
      kept: helps ? "kept" : "tested, not kept",
    });
    if (helps) {
      kept = candidate;
      bestBrier = brier;
      bestWfBrier = wf.brier;
      finalBrier = brier;
      finalWfBrier = wf.brier;
      finalCorrect = wf.correct;
    }
  }
  // The walk-forward "called right" share belongs to the final model;
  // recompute it once for the kept set if nothing was ever kept past
  // the baseline (then it is the base-rate call rate, 0 by construction
  // of the > base-rate rule — still reported honestly).
  if (kept.length === 0) {
    finalCorrect = walkForwardBrier(rows, []).correct;
  }
  const model = fitOdds(rows, kept, baseRate);
  const evidence: OddsEvidence = {
    n: rows.length,
    baseRate,
    baselineBrier,
    baselineWfBrier,
    finalBrier,
    finalWfBrier,
    walkForwardCorrect: finalCorrect,
    terms,
  };
  return { model, evidence };
}
