// radar-7 — lib/model.ts
//
// The value model, the board builder, and the odds training rows.
//
// The board answers one question: if a protocol with no token
// issued one tomorrow, what would it be worth?
//
//   implied value = TVL × fitted multiple × token odds
//
// The fitted multiple comes from the snapshot's own priced
// protocols: the target is ln(mcap / TVL), fitted by a small
// staged model (a flat median, then one-variable least squares,
// then shrunk group means) whose terms are added one at a time and
// kept only when they lower the held-out miss in BOTH out-of-sample
// tests — leave-one-out and a chronological walk-forward. Only the
// size curve ln(TVL) survives: final LOO miss ≈ 3.40,
// walk-forward ≈ 2.89, against a flat baseline of 5.07 / 5.29. A
// shuffled-growth control term is tested and never kept, whatever
// it scores; family and category were tested and did not survive
// either.
//
// The odds come from lib/odds.ts (a logistic regression on whether
// a token TRADES, not merely whether a ticker is recorded), and the
// intervals from lib/range.ts (quantiles of the value model's own
// held-out log residuals). A 200-refit bootstrap measures how much
// each row's implied value and rank wobble when the priced set is
// resampled — with the parent discount applied inside the refits,
// so the rank ranges describe the discounted board.
//
// Determinism is a first-class requirement here, not a nicety: the
// same snapshot must yield the same bytes. So the seed is a hash of
// the snapshot date and slugs, the growth shuffle and the bootstrap
// use two separate PRNG streams with exact call counts, every sum
// walks its array in index order, and every sort names its
// tie-break (or relies on JavaScript's stable sort keeping the
// input order). Raw doubles flow through unrounded until a step
// explicitly rounds them.

import { fitOddsWithEvidence, predictOdds } from "./odds.ts";
import type { OddsRow } from "./odds.ts";
import {
  coverageFraction,
  fnv1a,
  intervalBounds,
  mulberry32,
  quantile,
  residualQuantiles,
} from "./range.ts";
import type { ResidualQuantiles } from "./range.ts";
import { PARENT_PRODUCTS, parentScale } from "./parent.ts";

// ------------------------------------------------------------------ shapes

/** One protocol, with exactly the ten fields the snapshot carries. */
export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** A snapshot: the sealed input the whole board is computed from. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** The three fitted factors behind one row's multiple. */
export interface Factors {
  multiple: number;
  size: number;
  category: number;
}

/** One step of a farm plan (filled in by lib/farm.ts, not here). */
export interface FarmPlanStep {
  n: number;
  title: string;
  text: string;
  cost: string;
  time: string;
}

/** One nearest priced peer (filled in by lib/farm.ts, not here). */
export interface PeerRow {
  name: string;
  category: string;
  tvl: number;
  mcap: number;
  ratio: number;
  heldOut: number;
}

/**
 * One board row. The field order here is the JSON key order of
 * board.json — JSON.stringify preserves insertion order, so the
 * object literal in buildBoardModel must list the fields in this
 * same order. `parentFactor` / `parentName` are optional because
 * main.ts appends them after `peers` for parent rows only; this
 * file never sets them.
 */
export interface BoardRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvlUsd: number;
  change7d: number | null;
  ageDays: number | null;
  watchlist: boolean;
  rank: number;
  impliedValueUsd: number;
  valueIfLaunches: number;
  tokenOdds: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  bootstrapLow: number;
  bootstrapHigh: number;
  bootstrapRankLow: number;
  bootstrapRankHigh: number;
  factors: Factors;
  verdict: "FARM" | "MARGINAL" | "SKIP";
  netFees: number;
  netPerHour: number;
  dropUsd: number;
  feesUsd: number;
  handsOnHours: number;
  depositUsd: number;
  dropShare: number;
  horizonWeeks: number;
  farmSteps: string[];
  farmPlan: FarmPlanStep[];
  exitRule: string;
  peers: PeerRow[];
  parentFactor?: number;
  parentName?: string;
}

/** One value-model term's out-of-sample evidence. */
export interface ValueTermEvidence {
  name: string;
  loo: number;
  wf: number;
  kept: "kept" | "tested, not kept" | "baseline" | "must not help";
}

/** One odds term's evidence — the same shape lib/odds.ts uses. */
export interface OddsTermEvidence {
  name: string;
  brier: number;
  wfBrier: number;
  kept: "kept" | "tested, not kept" | "baseline";
}

/** The evidence block that ships inside board.json. */
export interface Evidence {
  value: {
    n: number;
    baselineLoo: number;
    baselineWf: number;
    finalLoo: number;
    finalWf: number;
    terms: ValueTermEvidence[];
  };
  odds: {
    n: number;
    baseRate: number;
    baselineBrier: number;
    baselineWfBrier: number;
    finalBrier: number;
    finalWfBrier: number;
    walkForwardCorrect: number;
    terms: OddsTermEvidence[];
  };
  range: {
    rows: { label: string; stated: number; loo: number; wf: number }[];
    note: string;
  };
}

/** The whole board, before main.ts appends floor/accounting/integrity. */
export interface Board {
  model: string;
  as_of: string;
  rows: BoardRow[];
  multiples: { category: string; multiple: number; n: number }[];
  globalMultiple: number;
  liveCount: number;
  evidence: Evidence;
}

// ------------------------------------------------------------------ helpers

/**
 * Median of an array: a sorted copy's middle element for odd
 * lengths, the mean of the two middle elements for even lengths,
 * 0 for an empty array. The copy keeps the caller's array intact.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Whole days between a listing date and the snapshot date, or null
 * when there is no listing date or either date will not parse.
 * Both dates are read as midnight UTC, the difference is floored
 * to whole days, and a listing after the snapshot counts as 0
 * days, never negative.
 */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = new Date(listedAt + "T00:00:00Z").getTime();
  const end = new Date(asOf + "T00:00:00Z").getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86400000));
}

/**
 * The "family" of a protocol: the first whitespace-separated word
 * of its trimmed name, lowercased — so "Aave V2" and "Aave V3" are
 * one family while "Aavegotchi" is another. When the name is empty
 * after trimming, the slug stands in as the family word.
 */
export function familyOf(name: string, slug: string): string {
  const trimmed = name.trim();
  const word = trimmed === "" ? slug : trimmed.split(/\s+/)[0]!;
  return word.toLowerCase();
}

// ------------------------------------------------------------------ exclusions

/**
 * Categories that keep a protocol off the board and out of the
 * odds training set: exchanges, bridges, and staking products
 * are not pre-token protocols waiting to launch.
 */
const EXCLUDED_CATEGORIES = new Set([
  "CEX",
  "Liquid Staking",
  "Bridge",
  "Canonical Bridge",
  "Liquid Restaking",
  "Restaked BTC",
]);

/**
 * A name ending in a version marker: a whitespace character, then
 * `V` + digits (with optional `.digits`), `v` + digits (with
 * optional `.digits`), or digits + `.` + digits, at the very end.
 * "Aave V3" and "Uniswap v4" match; "V2 Finance" does not, because
 * the marker must end the name.
 */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word `wrapped`, `staked` or `staking`, any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names starting with one of these are an exchange's own product. */
const EXCHANGE_PREFIXES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

/**
 * True when a protocol's name marks it as a versioned variant, a
 * wrapped/staked product, or an exchange product — the name-based
 * half of the exclusion rule.
 */
function isExcludedName(p: Protocol): boolean {
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(prefix)) return true;
  }
  return false;
}

/** True when neither a gecko id nor a symbol is recorded. */
function isNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/**
 * Board candidates: no token recorded, a category that is not
 * excluded (or no category at all), and a name that is not
 * excluded. Everything else is either already tokenised or a
 * product type the board does not rank.
 */
function isBoardCandidate(p: Protocol): boolean {
  return (
    isNoToken(p) &&
    (p.category === null || !EXCLUDED_CATEGORIES.has(p.category)) &&
    !isExcludedName(p)
  );
}

/**
 * Odds-training exclusions: an excluded category or an excluded
 * name drops the protocol from training. Note there is NO
 * isNoToken check here — the odds set drops the same
 * non-candidates as the board, but its target definition differs
 * (see the training-row step in buildBoardModel), so the two
 * filters are deliberately not the same function.
 */
function isOddsExcluded(p: Protocol): boolean {
  return (
    (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) ||
    isExcludedName(p)
  );
}

// ------------------------------------------------------------------ value model

/** One row of the value model's training (or prediction) data. */
interface ModelRow {
  slug: string;
  listedAt: string | null;
  ageYears: number | null;
  lnTvl: number;
  growthRaw: number | null;
  growthShuffled: number | null;
  lnChains: number;
  family: string;
  category: string;
  y: number | null;
}

/** The five one-variable features the staged model can use. */
type FeatureKey =
  | "lnTvl"
  | "growth"
  | "growthShuffled"
  | "age"
  | "lnChains";

/** One stage of the value model, before it is fitted. */
type Stage =
  | { kind: "const"; name: string }
  | { kind: "ols"; key: FeatureKey; name: string }
  | { kind: "group"; key: "family" | "category"; lambda: number; name: string };

/** Imputation means for the value model (growth and age). */
interface FitStats {
  meanGrowth: number;
  meanAge: number;
}

/** Mean of the non-null growth values (0 when none are present). */
function fitStatsOf(train: ModelRow[]): FitStats {
  let growthTotal = 0;
  let growthCount = 0;
  let ageTotal = 0;
  let ageCount = 0;
  for (const row of train) {
    if (row.growthRaw !== null) {
      growthTotal += row.growthRaw;
      growthCount += 1;
    }
    if (row.ageYears !== null) {
      ageTotal += row.ageYears;
      ageCount += 1;
    }
  }
  return {
    meanGrowth: growthCount > 0 ? growthTotal / growthCount : 0,
    meanAge: ageCount > 0 ? ageTotal / ageCount : 0,
  };
}

/**
 * One feature's value for one row. Growth (real or shuffled) is
 * clamped to [-0.9, 3]; age and growth fall back to the fitted
 * means when the row has no value; ln(TVL) and ln(chains) are used
 * as supplied.
 */
function featureValue(row: ModelRow, key: FeatureKey, stats: FitStats): number {
  if (key === "lnTvl") return row.lnTvl;
  if (key === "growth") {
    const growth = row.growthRaw ?? stats.meanGrowth;
    return Math.max(-0.9, Math.min(3, growth));
  }
  if (key === "growthShuffled") {
    const growth = row.growthShuffled ?? stats.meanGrowth;
    return Math.max(-0.9, Math.min(3, growth));
  }
  if (key === "age") return row.ageYears ?? stats.meanAge;
  return row.lnChains;
}

/** One fitted stage: its definition plus its fitted parameters. */
interface FittedStage {
  stage: Stage;
  intercept: number;
  slope: number;
  effects: Map<string, number>;
}

/** A fitted value model: its stages in order, plus its statistics. */
interface ValueModel {
  stages: FittedStage[];
  stats: FitStats;
}

/** The group key of a row: its family, or its category. */
function groupKeyOf(row: ModelRow, key: "family" | "category"): string {
  return key === "family" ? row.family : row.category;
}

/**
 * Fit the staged value model on a training set.
 *
 * Stages are fitted IN ORDER, each on the residuals of the ones
 * before it, so a later stage only ever explains what the earlier
 * stages left unexplained:
 *  - const: the flat median of the residuals, subtracted from all
 *    of them;
 *  - ols: one-variable least squares of the residuals on the
 *    feature (slope = sxy / sxx, intercept = mean residual −
 *    slope × mean feature; a zero-variance feature gets slope 0);
 *  - group: per-group shrunk means — each group's effect is the
 *    sum of its residuals over (count + lambda), so lambda
 *    pseudo-observations of zero pull small groups toward no
 *    effect, and the effect is subtracted from that group's rows.
 */
function fitValueModel(train: ModelRow[], stages: Stage[]): ValueModel {
  const stats = fitStatsOf(train);
  const fitted: FittedStage[] = [];
  let residuals: number[] = train.map((row) => row.y!);
  for (const stage of stages) {
    if (stage.kind === "const") {
      const a = median(residuals);
      fitted.push({ stage, intercept: a, slope: 0, effects: new Map() });
      residuals = residuals.map((r) => r - a);
    } else if (stage.kind === "ols") {
      const xs = train.map((row) => featureValue(row, stage.key, stats));
      let meanX = 0;
      for (const x of xs) meanX += x;
      meanX = xs.length > 0 ? meanX / xs.length : 0;
      let meanR = 0;
      for (const r of residuals) meanR += r;
      meanR = residuals.length > 0 ? meanR / residuals.length : 0;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < xs.length; i++) {
        const dx = xs[i]! - meanX;
        sxx += dx * dx;
        sxy += dx * (residuals[i]! - meanR);
      }
      const slope = sxx > 0 ? sxy / sxx : 0;
      const intercept = meanR - slope * meanX;
      fitted.push({ stage, intercept, slope, effects: new Map() });
      residuals = residuals.map(
        (r, i) => r - (intercept + slope * xs[i]!),
      );
    } else {
      const sums = new Map<string, number>();
      const counts = new Map<string, number>();
      for (let i = 0; i < train.length; i++) {
        const key = groupKeyOf(train[i]!, stage.key);
        sums.set(key, (sums.get(key) ?? 0) + residuals[i]!);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const effects = new Map<string, number>();
      for (const [key, sum] of sums) {
        const count = counts.get(key)!;
        effects.set(key, sum / (count + stage.lambda));
      }
      fitted.push({ stage, intercept: 0, slope: 0, effects });
      residuals = residuals.map(
        (r, i) => r - (effects.get(groupKeyOf(train[i]!, stage.key)) ?? 0),
      );
    }
  }
  return { stages: fitted, stats };
}

/**
 * Predict one row's log-ratio, split into its parts.
 *
 * `total` is the full prediction; `sizePart` accumulates the
 * ln(TVL) stage's contribution (the only ols stage whose effect is
 * reported separately — it is the size curve); `categoryPart`
 * accumulates the group stages' contributions. The const stage
 * contributes to the total only. A group the model has never seen
 * contributes 0.
 */
function predictValue(
  model: ValueModel,
  row: ModelRow,
): { total: number; sizePart: number; categoryPart: number } {
  let total = 0;
  let sizePart = 0;
  let categoryPart = 0;
  for (const fitted of model.stages) {
    let add = 0;
    if (fitted.stage.kind === "const") {
      add = fitted.intercept;
    } else if (fitted.stage.kind === "ols") {
      add =
        fitted.intercept +
        fitted.slope * featureValue(row, fitted.stage.key, model.stats);
      if (fitted.stage.key === "lnTvl") sizePart += add;
    } else {
      add = fitted.effects.get(groupKeyOf(row, fitted.stage.key)) ?? 0;
      categoryPart += add;
    }
    total += add;
  }
  return { total, sizePart, categoryPart };
}

/**
 * The held-out "miss" of a set of predictions: e raised to the
 * median absolute error in log space. A miss of 3.40 means the
 * typical held-out prediction is off by a factor of 3.40.
 */
function missFactor(predicted: number[], actual: number[]): number {
  const errors: number[] = [];
  for (let i = 0; i < predicted.length; i++) {
    errors.push(Math.abs(predicted[i]! - actual[i]!));
  }
  return Math.exp(median(errors));
}

/**
 * Leave-one-out predictions: for each row in turn, fit on all the
 * other rows and predict the held-out one. The returned array is
 * in the input rows' order.
 */
function looPredictions(rows: ModelRow[], stages: Stage[]): number[] {
  const predictions: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, index) => index !== i);
    const model = fitValueModel(train, stages);
    predictions.push(predictValue(model, rows[i]!).total);
  }
  return predictions;
}

/**
 * Walk-forward predictions over the dated rows.
 *
 * The dated rows are sorted by (listedAt, then slug) and cut into
 * 4 near-equal blocks — base = floor(n / 4), the first
 * `n - base * 4` blocks getting one extra row — and for k = 0, 1, 2
 * the model is fitted on blocks 0..k and predicts every row of
 * block k+1. The predictions and actuals accumulate in block
 * order. Like the odds walk-forward, the test set is always
 * strictly later than its training set.
 */
function wfPredictions(
  dated: ModelRow[],
  stages: Stage[],
): { predicted: number[]; actual: number[] } {
  const sorted = [...dated].sort((a, b) => {
    if (a.listedAt! !== b.listedAt!) {
      return a.listedAt! < b.listedAt! ? -1 : 1;
    }
    return a.slug < b.slug ? -1 : 1;
  });
  const n = sorted.length;
  const base = Math.floor(n / 4);
  const extra = n - base * 4;
  const blocks: ModelRow[][] = [];
  let start = 0;
  for (let b = 0; b < 4; b++) {
    const size = base + (b < extra ? 1 : 0);
    blocks.push(sorted.slice(start, start + size));
    start += size;
  }
  const predicted: number[] = [];
  const actual: number[] = [];
  for (let k = 0; k < 3; k++) {
    const train = blocks.slice(0, k + 1).flat();
    const model = fitValueModel(train, stages);
    for (const row of blocks[k + 1]!) {
      predicted.push(predictValue(model, row).total);
      actual.push(row.y!);
    }
  }
  return { predicted, actual };
}

// ------------------------------------------------------------------ LOO ratio lookup

/**
 * The leave-one-out ratio prediction per priced slug, set by the
 * latest buildBoardModel run. The predictor below closes over a
 * snapshot copy of this map, so a later run cannot change what an
 * earlier predictor returns.
 */
let looRatioBySlug = new Map<string, number>();

/**
 * A predictor for the farm stage's peer heldOut figures: given a
 * priced peer, the leave-one-out model's prediction over the
 * peer's actual cap/TVL ratio — 1.00 means the model priced the
 * peer exactly. A peer with no usable actual ratio, or one the
 * model never saw, returns 1 (no information, no claim).
 */
export function looRatioPredictor(): (peer: Protocol) => number {
  const snapshotMap = new Map(looRatioBySlug);
  return (peer: Protocol): number => {
    const actual =
      peer.mcap_usd !== null && peer.tvl_usd > 0
        ? peer.mcap_usd / peer.tvl_usd
        : 0;
    const predicted = snapshotMap.get(peer.slug);
    if (actual <= 0 || predicted === undefined) return 1;
    return predicted / actual;
  };
}

// ------------------------------------------------------------------ board

/**
 * Build the whole board from a snapshot. The pipeline, step by
 * step: seed; priced protocols and category multiples; value-model
 * rows with a seeded growth shuffle; sequential term selection
 * (with the never-kept control); final fit and residuals;
 * LOO-ratio lookup; interval honesty; odds training rows and fit;
 * board drafts; 200-refit bootstrap; rank and $1 tie-nudges; rows;
 * evidence.
 *
 * The farm placeholders in the rows (verdict MARGINAL, zeroed
 * numbers, six placeholder step strings, empty plan/exit/peers)
 * are filled in later by lib/farm.ts — main.ts always runs it
 * before writing, so they never reach the board.
 */
export function buildBoardModel(snapshot: Snapshot): Board {
  // -- Step 1: seed. A hash of the snapshot date and the slugs in
  //    snapshot order. The shuffle and the bootstrap derive two
  //    separate streams from this one seed.
  const seed = fnv1a(
    snapshot.as_of + "|" + snapshot.protocols.map((p) => p.slug).join(","),
  );

  // -- Step 2: priced protocols. A protocol is priced when its
  //    market cap is present, its TVL is positive, and the ratio
  //    is positive — a recorded cap of zero or less has no log
  //    ratio and is left out. Ratios are collected in snapshot
  //    order, grouped by category (null becomes "Uncategorized").
  const allRatios: number[] = [];
  const ratiosByCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!(ratio > 0)) continue;
    allRatios.push(ratio);
    const key = p.category ?? "Uncategorized";
    const bucket = ratiosByCategory.get(key);
    if (bucket !== undefined) bucket.push(ratio);
    else ratiosByCategory.set(key, [ratio]);
  }
  const globalMultiple = median(allRatios);

  // -- Step 3: category multiples. Categories are ordered by count
  //    descending, then name ascending. A category with at least 3
  //    priced protocols gets its own median ratio, clamped to
  //    [0.05, 1]; a thinner category falls back to the global
  //    multiple rather than trusting a median of one or two.
  const multiples: { category: string; multiple: number; n: number }[] = [];
  const categoryEntries = [...ratiosByCategory.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[0] < b[0] ? -1 : 1;
  });
  for (const [category, ratios] of categoryEntries) {
    const n = ratios.length;
    const multiple =
      n >= 3
        ? Math.min(1, Math.max(0.05, median(ratios)))
        : globalMultiple;
    multiples.push({ category, multiple, n });
  }

  // -- Step 4: value-model rows. The priced protocols, sorted by
  //    slug, with a seeded Fisher–Yates shuffle applied to the
  //    growth values only: each row's growthShuffled is another
  //    row's actual 7-day change, which is what makes the shuffled
  //    control term a genuine control — it has the same
  //    distribution as real growth, but no relationship to the
  //    row it is attached to.
  const orderedPriced = [...snapshot.protocols]
    .filter((p) => {
      if (p.mcap_usd === null || p.tvl_usd <= 0) return false;
      return p.mcap_usd / p.tvl_usd > 0;
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const shuffleRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const perm: number[] = orderedPriced.map((_, i) => i);
  for (let i = perm.length - 1; i >= 1; i--) {
    const j = Math.floor(shuffleRng() * (i + 1));
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }

  function makeModelRow(p: Protocol, shuffledGrowth: number | null): ModelRow {
    const days = ageDays(snapshot.as_of, p.listed_at);
    return {
      slug: p.slug,
      listedAt: p.listed_at,
      ageYears: days === null ? null : days / 365.25,
      lnTvl: Math.log(p.tvl_usd / 1e8),
      growthRaw: p.change_7d,
      growthShuffled: shuffledGrowth,
      lnChains: Math.log(Math.max(1, p.chains.length)),
      family: familyOf(p.name, p.slug),
      category: p.category ?? "Uncategorized",
      y:
        p.mcap_usd !== null && p.tvl_usd > 0
          ? Math.log(p.mcap_usd / p.tvl_usd)
          : null,
    };
  }

  const valueRows: ModelRow[] = orderedPriced.map((p, i) =>
    makeModelRow(p, orderedPriced[perm[i]!]!.change_7d),
  );
  const datedRows = valueRows.filter((row) => row.listedAt !== null);
  const actuals: number[] = valueRows.map((row) => row.y!);

  // -- Step 5: sequential term selection. Stages are tried in the
  //    fixed order below and kept only when the candidate lowers
  //    the held-out miss on BOTH tests (LOO and walk-forward).
  //    The control is tested last and NEVER added, whatever it
  //    scores — if shuffled growth helped, the growth signal
  //    would be suspect, not real.
  const constStage: Stage = { kind: "const", name: "flat median multiple" };
  const sizeStage: Stage = {
    kind: "ols",
    key: "lnTvl",
    name: "size curve ln(TVL)",
  };
  const familyStage: Stage = {
    kind: "group",
    key: "family",
    lambda: 8,
    name: "family effect (ridge)",
  };
  const categoryStage: Stage = {
    kind: "group",
    key: "category",
    lambda: 64,
    name: "category effect (ridge 64)",
  };
  const growthStage: Stage = {
    kind: "ols",
    key: "growth",
    name: "7-day TVL growth",
  };
  const ageStage: Stage = {
    kind: "ols",
    key: "age",
    name: "age (years listed)",
  };
  const chainsStage: Stage = {
    kind: "ols",
    key: "lnChains",
    name: "chain count (ln)",
  };
  const controlStage: Stage = {
    kind: "ols",
    key: "growthShuffled",
    name: "CONTROL shuffled growth",
  };

  function evaluate(stages: Stage[]): { loo: number; wf: number } {
    const looPreds = looPredictions(valueRows, stages);
    const wf = wfPredictions(datedRows, stages);
    return {
      loo: missFactor(looPreds, actuals),
      wf: missFactor(wf.predicted, wf.actual),
    };
  }

  const valueTerms: ValueTermEvidence[] = [];
  let keptStages: Stage[] = [constStage];
  let current = evaluate(keptStages);
  const baseline = { ...current };
  valueTerms.push({
    name: "flat median multiple",
    loo: current.loo,
    wf: current.wf,
    kept: "baseline",
  });
  for (const stage of [
    sizeStage,
    familyStage,
    categoryStage,
    growthStage,
    ageStage,
    chainsStage,
  ]) {
    const candidate = [...keptStages, stage];
    const score = evaluate(candidate);
    const helps = score.loo < current.loo && score.wf < current.wf;
    valueTerms.push({
      name: stage.name,
      loo: score.loo,
      wf: score.wf,
      kept: helps ? "kept" : "tested, not kept",
    });
    if (helps) {
      keptStages = candidate;
      current = score;
    }
  }
  const controlScore = evaluate([...keptStages, controlStage]);
  valueTerms.push({
    name: "CONTROL shuffled growth",
    loo: controlScore.loo,
    wf: controlScore.wf,
    kept: "must not help",
  });
  // Expected on the kit snapshot: only the size curve is kept;
  // final LOO ≈ 3.40, walk-forward ≈ 2.89 (baseline 5.07 / 5.29).

  // -- Step 6: final fit and residuals. The LOO predictions and
  //    the walk-forward predictions are recomputed once, on the
  //    kept stages, and their residuals (actual minus predicted,
  //    in log space) are summarised as quantiles — the raw material
  //    of every interval on the board.
  const finalValueModel = fitValueModel(valueRows, keptStages);
  const finalLooPreds = looPredictions(valueRows, keptStages);
  const looResiduals = actuals.map((y, i) => y - finalLooPreds[i]!);
  const finalWf = wfPredictions(datedRows, keptStages);
  const wfResiduals = finalWf.actual.map(
    (y, i) => y - finalWf.predicted[i]!,
  );
  const looQuantiles: ResidualQuantiles = residualQuantiles(looResiduals);
  const wfQuantiles: ResidualQuantiles = residualQuantiles(wfResiduals);

  // -- Step 7: LOO ratio lookup. The module-level map is (re)set
  //    to the exponentiated LOO prediction per priced slug, so the
  //    farm stage can price each peer against the model that never
  //    saw that peer.
  looRatioBySlug = new Map(
    valueRows.map(
      (row, i) => [row.slug, Math.exp(finalLooPreds[i]!)] as [string, number],
    ),
  );

  // -- Step 8: interval honesty (coverage). All in ratio space —
  //    the exponentiated log values — using coverageFraction: the
  //    share of priced protocols whose real cap fell inside the
  //    interval the model's own held-out residuals imply. The LOO
  //    bands are checked over all priced rows; the walk-forward
  //    bands over the dated rows with a walk-forward prediction.
  const looActualRatios = valueRows.map((row) => Math.exp(row.y!));
  const looPredRatios = finalLooPreds.map((pred) => Math.exp(pred));
  const looCover50 = coverageFraction(
    looActualRatios,
    looPredRatios.map((pred) => pred * Math.exp(looQuantiles.q25)),
    looPredRatios.map((pred) => pred * Math.exp(looQuantiles.q75)),
  );
  const looCover80 = coverageFraction(
    looActualRatios,
    looPredRatios.map((pred) => pred * Math.exp(looQuantiles.q10)),
    looPredRatios.map((pred) => pred * Math.exp(looQuantiles.q90)),
  );
  const wfActualRatios = finalWf.actual.map((y) => Math.exp(y));
  const wfPredRatios = finalWf.predicted.map((pred) => Math.exp(pred));
  const wfCover50 = coverageFraction(
    wfActualRatios,
    wfPredRatios.map((pred) => pred * Math.exp(wfQuantiles.q25)),
    wfPredRatios.map((pred) => pred * Math.exp(wfQuantiles.q75)),
  );
  const wfCover80 = coverageFraction(
    wfActualRatios,
    wfPredRatios.map((pred) => pred * Math.exp(wfQuantiles.q10)),
    wfPredRatios.map((pred) => pred * Math.exp(wfQuantiles.q90)),
  );
  // Expected: P25–P75 covers 50% (LOO) and 49% (walk-forward)
  // against a stated 50%; P10–P90 covers 80% and 79% against a
  // stated 80%.

  // -- Step 9: odds training rows. For each protocol in snapshot
  //    order: skip the odds-excluded; a row is priced when its
  //    token trades (positive cap on positive TVL) and tokenless
  //    when nothing is recorded; the middle class — a ticker
  //    recorded but no usable cap — is skipped, out of training.
  const oddsRows: OddsRow[] = [];
  for (const p of snapshot.protocols) {
    if (isOddsExcluded(p)) continue;
    const isPriced =
      p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
    const isNoTokenRow = p.gecko_id === null && p.symbol === null;
    if (!isPriced && !isNoTokenRow) continue;
    const age = ageDays(snapshot.as_of, p.listed_at);
    oddsRows.push({
      slug: p.slug,
      listedAt: p.listed_at,
      ageYears: age === null ? null : age / 365.25,
      lnTvl: Math.log(p.tvl_usd / 1e8),
      growthRaw: p.change_7d,
      lnChains: Math.log(Math.max(1, p.chains.length)),
      family: familyOf(p.name, p.slug),
      category: p.category ?? "Uncategorized",
      y: isPriced ? 1 : 0,
    });
  }
  const { model: oddsModel, evidence: oddsEvidence } =
    fitOddsWithEvidence(oddsRows);

  // -- Step 10: board drafts. One draft per board candidate, with
  //    its fitted multiple, its odds, its launch value and its
  //    implied value. The board feature row is built with a null
  //    shuffled growth (the shuffle was only for training the
  //    control); the odds feature row is the same fields with y 0.
  const watchlist = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter(isBoardCandidate);
  interface Draft {
    protocol: Protocol;
    implied: number;
    valueIfLaunches: number;
    odds: number;
    fittedMultiple: number;
    sizeFactor: number;
    categoryFactor: number;
    boardFeature: ModelRow;
    bootLow: number;
    bootHigh: number;
    bootRankLow: number;
    bootRankHigh: number;
  }
  const drafts: Draft[] = [];
  for (const protocol of candidates) {
    const boardFeature = makeModelRow(protocol, null);
    const oddsFeature: OddsRow = {
      slug: boardFeature.slug,
      listedAt: boardFeature.listedAt,
      ageYears: boardFeature.ageYears,
      lnTvl: boardFeature.lnTvl,
      growthRaw: boardFeature.growthRaw,
      lnChains: boardFeature.lnChains,
      family: boardFeature.family,
      category: boardFeature.category,
      y: 0,
    };
    const pred = predictValue(finalValueModel, boardFeature);
    const fittedMultiple = Math.exp(pred.total);
    const odds = predictOdds(oddsModel, oddsFeature);
    const valueIfLaunches = Math.max(
      1,
      Math.round(protocol.tvl_usd * fittedMultiple),
    );
    const implied = Math.max(
      1,
      Math.round(protocol.tvl_usd * fittedMultiple * odds),
    );
    drafts.push({
      protocol,
      implied,
      valueIfLaunches,
      odds,
      fittedMultiple,
      sizeFactor: Math.exp(pred.sizePart),
      categoryFactor: Math.exp(pred.categoryPart),
      boardFeature,
      bootLow: 0,
      bootHigh: 0,
      bootRankLow: 0,
      bootRankHigh: 0,
    });
  }

  // -- Step 11: bootstrap (200 refits). Each refit resamples the
  //    priced rows WITH replacement (the bootstrap stream is called
  //    exactly once per resample element, in order), refits the
  //    kept stages, and re-prices every draft — with the odds held
  //    FIXED, because the bootstrap measures the multiple's wobble,
  //    not the odds'. For the rank range, parent lines are
  //    discounted first, with the same factor main.ts applies, so
  //    the range is measured on the discounted board the reader
  //    sees. After all refits, each draft's P5–P95 implied-value
  //    and rank bounds are attached BEFORE the ranking sort below
  //    reorders the drafts.
  const bootRng = mulberry32(seed);
  const bootCount = 200;
  const bootImplied: number[][] = drafts.map(() => []);
  const bootRanks: number[][] = drafts.map(() => []);
  for (let b = 0; b < bootCount; b++) {
    const resample: ModelRow[] = [];
    for (let i = 0; i < valueRows.length; i++) {
      const picked = valueRows[Math.floor(bootRng() * valueRows.length)]!;
      resample.push(picked);
    }
    const bootModel = fitValueModel(resample, keptStages);
    const bootValues = drafts.map((draft) =>
      Math.max(
        1,
        Math.round(
          draft.protocol.tvl_usd *
            Math.exp(predictValue(bootModel, draft.boardFeature).total) *
            draft.odds,
        ),
      ),
    );
    for (let i = 0; i < drafts.length; i++) {
      bootImplied[i]!.push(bootValues[i]!);
    }
    const rankedValues = bootValues.map((value, i) =>
      drafts[i]!.protocol.slug in PARENT_PRODUCTS
        ? parentScale(value)
        : value,
    );
    const order = drafts
      .map((_, i) => i)
      .sort((a, b) => {
        if (rankedValues[b]! !== rankedValues[a]!) {
          return rankedValues[b]! - rankedValues[a]!;
        }
        const tvlA = drafts[a]!.protocol.tvl_usd;
        const tvlB = drafts[b]!.protocol.tvl_usd;
        if (tvlB !== tvlA) return tvlB - tvlA;
        const slugA = drafts[a]!.protocol.slug;
        const slugB = drafts[b]!.protocol.slug;
        return slugA < slugB ? -1 : 1;
      });
    order.forEach((draftIndex, place) => {
      bootRanks[draftIndex]!.push(place + 1);
    });
  }
  for (let i = 0; i < drafts.length; i++) {
    const sortedImplied = [...bootImplied[i]!].sort((a, b) => a - b);
    const sortedRanks = [...bootRanks[i]!].sort((a, b) => a - b);
    drafts[i]!.bootLow = quantile(sortedImplied, 0.05);
    drafts[i]!.bootHigh = quantile(sortedImplied, 0.95);
    drafts[i]!.bootRankLow = Math.round(quantile(sortedRanks, 0.05));
    drafts[i]!.bootRankHigh = Math.round(quantile(sortedRanks, 0.95));
  }

  // -- Step 12: rank and nudge. Sort by implied value descending,
  //    then TVL descending, then slug ascending; then walk down
  //    the list nudging any tie (or inversion) down by $1, so the
  //    implied values are strictly decreasing and no two rows share
  //    a value.
  drafts.sort((a, b) => {
    if (b.implied !== a.implied) return b.implied - a.implied;
    if (b.protocol.tvl_usd !== a.protocol.tvl_usd) {
      return b.protocol.tvl_usd - a.protocol.tvl_usd;
    }
    return a.protocol.slug < b.protocol.slug ? -1 : 1;
  });
  for (let i = 1; i < drafts.length; i++) {
    if (drafts[i]!.implied >= drafts[i - 1]!.implied) {
      drafts[i]!.implied = drafts[i - 1]!.implied - 1;
    }
  }

  // -- Step 13: rows. The field order below is the JSON key order
  //    (section 7a / 10 of the spec). The intervals come from the
  //    LOO quantiles; the bootstrap bounds are clamped to include
  //    the row's own implied value, so a row never sits outside
  //    its own range. The farm fields are placeholders — verdict
  //    MARGINAL, zeroed numbers, six placeholder step strings, an
  //    empty plan, an empty exit rule, no peers — filled in by
  //    lib/farm.ts before anything is written.
  const placeholderSteps: string[] = [];
  for (let n = 1; n <= 6; n++) {
    placeholderSteps.push(
      `Placeholder langkah farm ${n} dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.`,
    );
  }
  const rows: BoardRow[] = drafts.map((draft, i) => {
    const protocol = draft.protocol;
    const bounds = intervalBounds(draft.implied, looQuantiles);
    return {
      slug: protocol.slug,
      name: protocol.name,
      category: protocol.category ?? "Uncategorized",
      chains: protocol.chains,
      tvlUsd: protocol.tvl_usd,
      change7d: protocol.change_7d,
      ageDays: ageDays(snapshot.as_of, protocol.listed_at),
      watchlist: watchlist.has(protocol.slug),
      rank: i + 1,
      impliedValueUsd: draft.implied,
      valueIfLaunches: draft.valueIfLaunches,
      tokenOdds: draft.odds,
      p25: bounds.p25,
      p75: bounds.p75,
      p10: bounds.p10,
      p90: bounds.p90,
      bootstrapLow: Math.max(
        1,
        Math.round(Math.min(draft.bootLow, draft.implied)),
      ),
      bootstrapHigh: Math.max(
        1,
        Math.round(Math.max(draft.bootHigh, draft.implied)),
      ),
      bootstrapRankLow: draft.bootRankLow,
      bootstrapRankHigh: draft.bootRankHigh,
      factors: {
        multiple: draft.fittedMultiple,
        size: draft.sizeFactor,
        category: draft.categoryFactor,
      },
      verdict: "MARGINAL",
      netFees: 0,
      netPerHour: 0,
      dropUsd: 0,
      feesUsd: 0,
      handsOnHours: 0,
      depositUsd: 0,
      dropShare: 0,
      horizonWeeks: 0,
      farmSteps: [...placeholderSteps],
      farmPlan: [],
      exitRule: "",
      peers: [],
    };
  });

  // -- Step 14: evidence and return. The range note states, in
  //    plain language, what the intervals are and how their
  //    coverage was measured — including the en-dashes in
  //    "P25–P75" and "P10–P90".
  const evidence: Evidence = {
    value: {
      n: valueRows.length,
      baselineLoo: baseline.loo,
      baselineWf: baseline.wf,
      finalLoo: current.loo,
      finalWf: current.wf,
      terms: valueTerms,
    },
    odds: oddsEvidence,
    range: {
      rows: [
        { label: "P25–P75", stated: 0.5, loo: looCover50, wf: wfCover50 },
        { label: "P10–P90", stated: 0.8, loo: looCover80, wf: wfCover80 },
      ],
      note: "Intervals are the implied value shifted by the quantiles of the value model's own held-out log residuals (LOO residuals for the board bounds). Coverage is the share of priced protocols whose real cap fell inside the interval: LOO over all priced rows, walk-forward over the dated rows with a walk-forward prediction.",
    },
  };
  return {
    model: "radar-7",
    as_of: snapshot.as_of,
    rows,
    multiples,
    globalMultiple,
    liveCount: valueRows.length,
    evidence,
  };
}
