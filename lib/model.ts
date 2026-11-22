// radar-7 — value model, board builder, and the odds training rows.
//
// The board answers one question: if a protocol with no token issued
// one tomorrow, what would it be worth? The answer is fitted from the
// snapshot's own priced protocols, never from a hardcoded name or
// number:
//
//   implied value = TVL x fitted multiple x token odds
//
// The fitted multiple comes from a log-ratio model: the target is
// ln(mcap / TVL) over the priced protocols (a positive market cap on
// a positive TVL; a recorded cap of zero or less has no log and is
// left out, not averaged in). Terms are added one at a time, in the
// order below, and a term is kept only when it lowers the held-out
// miss in BOTH tests — leave-one-out and a chronological
// walk-forward — against the terms kept so far. A term that helps
// one test and hurts the other is reported as "tested, not kept".
//
//   miss = median absolute log error, shown as a factor: a miss of
//   3.4 means the typical prediction is off by a factor of 3.4.
//
// The token odds come from ./odds.ts (logistic regression, same
// keep-only-if-both-tests-improve rule). The interval comes from
// ./range.ts (quantiles of the value model's own held-out log
// residuals). The farm verdict, farm steps, farm plan, exit rule and
// peers are filled in by later stages; this file leaves them as
// valid placeholders so the row contract already holds.
//
// The bootstrap also records a RANK range per row: each of the 200
// refits re-ranks the whole board, so a row's rank across refits
// shows how stable its place is — a value range alone cannot show
// that. The rank range is P5–P95 of the refit ranks, not a
// min–max, so one wild refit cannot stretch it.
//
// Deterministic: the same snapshot always yields the same bytes.
// The only randomness is a seeded PRNG (see ./range.ts) used for the
// shuffled-growth control term and the bootstrap.

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Factors {
  multiple: number;
  size: number;
  category: number;
}

export interface FarmPlanStep {
  n: number;
  title: string;
  text: string;
  cost: number;
  time: number;
}

export interface PeerRow {
  name: string;
  category: string;
  tvl: number;
  mcap: number;
  ratio: number;
  // Genuinely held out: the value model's leave-one-out prediction
  // for this peer, divided by the peer's actual cap/TVL ratio.
  // 1.00 means the model priced the peer exactly; 2.00 means it
  // predicted twice the real cap. (An earlier round stored the
  // peer's own ratio here under this name — a placeholder, not a
  // held-out number — and this build replaces it with the real one.)
  heldOut: number;
}

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
  verdict: string;
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
  // Parent-product discount, set by main.ts after the board is built
  // (see applyParentDiscount): 0.48 when the row's slug is exactly one
  // of the 20 parent-product lines in main.ts PARENT_PRODUCTS (ported
  // verbatim from the v4 entry), with the v4 description of the line.
  // Absent when the row is a standalone launch.
  parentFactor?: number;
  parentName?: string;
}

export interface ValueTermEvidence {
  name: string;
  loo: number;
  wf: number;
  kept: "kept" | "tested, not kept" | "baseline" | "must not help";
}

export interface OddsTermEvidence {
  name: string;
  brier: number;
  wfBrier: number;
  kept: "kept" | "tested, not kept" | "baseline";
}

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

export interface Board {
  model: "radar-7";
  as_of: string;
  rows: BoardRow[];
  multiples: { category: string; multiple: number; n: number }[];
  globalMultiple: number;
  liveCount: number;
  evidence: Evidence;
}

// ------------------------------------------------------------------ utils

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(listedAt + "T00:00:00Z");
  const end = Date.parse(asOf + "T00:00:00Z");
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86400000));
}

// A protocol's family is the first word of its name: "Aave V2" and
// "Aave V3" are one family, "Aavegotchi" is another. It is read off
// the snapshot, never from a list.
function familyOf(name: string, slug: string): string {
  const first = name.trim().split(/\s+/)[0];
  return (first !== "" ? first : slug).toLowerCase();
}

// ------------------------------------------------------------------ exclusions

// Categories whose protocols are not standalone launch candidates: a
// centralised exchange, a bridge, or a staked / wrapped / restaked
// form of a token that already trades has no token of its own left
// to launch.
const EXCLUDED_CATEGORIES = new Set([
  "CEX",
  "Liquid Staking",
  "Bridge",
  "Canonical Bridge",
  "Liquid Restaking",
  "Restaked BTC",
]);

const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];

function isExcludedName(p: Protocol): boolean {
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(prefix)) return true;
  }
  return false;
}

// A protocol records no token when both the CoinGecko id and the
// symbol are null; anything else already has a token of some kind.
function isNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

function isBoardCandidate(p: Protocol): boolean {
  if (!isNoToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (isExcludedName(p)) return false;
  return true;
}

// The odds training set drops the same non-candidates as the board.
// The target is the traded-token question: a positive is a token
// that trades (positive market cap on a positive TVL), a negative is
// a protocol with no token recorded at all, and the middle class —
// a ticker recorded but no usable cap (null, zero, or the one
// negative cap in the snapshot) — is dropped from training, not
// forced into either side. The exclusion filter is the same one the
// board uses; only the definition of the target changed.
function isOddsExcluded(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  return isExcludedName(p);
}

// ------------------------------------------------------------------ value model

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
  y: number | null; // ln(mcap/TVL); null for board rows (no cap to fit)
}

type FeatureKey = "lnTvl" | "growth" | "growthShuffled" | "age" | "lnChains";

type Stage =
  | { kind: "const"; name: string }
  | { kind: "ols"; key: FeatureKey; name: string }
  | { kind: "group"; key: "family" | "category"; lambda: number; name: string };

interface FitStats {
  meanGrowth: number;
  meanAge: number;
}

function fitStatsOf(train: ModelRow[]): FitStats {
  const growths = train.map((r) => r.growthRaw).filter((v): v is number => v !== null);
  const ages = train.map((r) => r.ageYears).filter((v): v is number => v !== null);
  return {
    meanGrowth: growths.length > 0 ? growths.reduce((a, b) => a + b, 0) / growths.length : 0,
    meanAge: ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : 0,
  };
}

function featureValue(row: ModelRow, key: FeatureKey, stats: FitStats): number {
  if (key === "lnTvl") return row.lnTvl;
  if (key === "growth") return Math.max(-0.9, Math.min(3, row.growthRaw ?? stats.meanGrowth));
  if (key === "growthShuffled") {
    return Math.max(-0.9, Math.min(3, row.growthShuffled ?? stats.meanGrowth));
  }
  if (key === "age") return row.ageYears ?? stats.meanAge;
  return row.lnChains;
}

interface FittedStage {
  stage: Stage;
  intercept: number;
  slope: number;
  effects: Map<string, number>;
}

interface ValueModel {
  stages: FittedStage[];
  stats: FitStats;
}

// Stages are fitted in order, each on the residuals of the ones
// before it: a constant (the median log ratio), then one-variable
// least-squares fits, then shrunk group means. A group mean is the
// sum of its residuals over (count + lambda): lambda
// pseudo-observations of zero pull small groups toward no effect.
function fitValueModel(train: ModelRow[], stages: Stage[]): ValueModel {
  const stats = fitStatsOf(train);
  const fitted: FittedStage[] = [];
  let residuals = train.map((r) => r.y as number);
  for (const stage of stages) {
    if (stage.kind === "const") {
      const a = median(residuals);
      fitted.push({ stage, intercept: a, slope: 0, effects: new Map() });
      residuals = residuals.map((r) => r - a);
    } else if (stage.kind === "ols") {
      const xs = train.map((r) => featureValue(r, stage.key, stats));
      const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
      const meanR = residuals.reduce((a, b) => a + b, 0) / residuals.length;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < xs.length; i++) {
        sxx += (xs[i] - meanX) ** 2;
        sxy += (xs[i] - meanX) * (residuals[i] - meanR);
      }
      const slope = sxx > 0 ? sxy / sxx : 0;
      const intercept = meanR - slope * meanX;
      fitted.push({ stage, intercept, slope, effects: new Map() });
      residuals = residuals.map((r, i) => r - (intercept + slope * xs[i]));
    } else {
      const sums = new Map<string, number>();
      const counts = new Map<string, number>();
      train.forEach((row, i) => {
        const key = stage.key === "family" ? row.family : row.category;
        sums.set(key, (sums.get(key) ?? 0) + residuals[i]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      });
      const effects = new Map<string, number>();
      for (const [key, sum] of sums) {
        effects.set(key, sum / ((counts.get(key) ?? 0) + stage.lambda));
      }
      fitted.push({ stage, intercept: 0, slope: 0, effects });
      residuals = train.map((row, i) => {
        const key = stage.key === "family" ? row.family : row.category;
        return residuals[i] - (effects.get(key) ?? 0);
      });
    }
  }
  return { stages: fitted, stats };
}

interface ValuePrediction {
  total: number; // predicted ln(mcap/TVL)
  sizePart: number; // log contribution of the size curve (0 if not fitted)
  categoryPart: number; // log contribution of family + category (0 if not fitted)
}

function predictValue(model: ValueModel, row: ModelRow): ValuePrediction {
  let total = 0;
  let sizePart = 0;
  let categoryPart = 0;
  for (const fitted of model.stages) {
    const stage = fitted.stage;
    let add = 0;
    if (stage.kind === "const") {
      add = fitted.intercept;
    } else if (stage.kind === "ols") {
      add = fitted.intercept + fitted.slope * featureValue(row, stage.key, model.stats);
      if (stage.key === "lnTvl") sizePart += add;
    } else {
      const key = stage.key === "family" ? row.family : row.category;
      add = fitted.effects.get(key) ?? 0;
      categoryPart += add;
    }
    total += add;
  }
  return { total, sizePart, categoryPart };
}

// Median absolute log error as a factor: exp(median |pred - actual|).
function missFactor(predicted: number[], actual: number[]): number {
  const errs = predicted.map((p, i) => Math.abs(p - actual[i]));
  return Math.exp(median(errs));
}

function looPredictions(rows: ModelRow[], stages: Stage[]): number[] {
  const out: number[] = new Array<number>(rows.length).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, j) => j !== i);
    const model = fitValueModel(train, stages);
    out[i] = predictValue(model, rows[i]).total;
  }
  return out;
}

// Chronological walk-forward over the dated rows: four near-equal
// blocks by listing date, train on the earlier blocks, test on the
// next one. Every test fold holds at least 20 rows whenever the
// dated set holds at least 80.
function wfPredictions(
  dated: ModelRow[],
  stages: Stage[],
): { predicted: number[]; actual: number[] } {
  const sorted = [...dated].sort((a, b) => {
    if (a.listedAt !== b.listedAt) return a.listedAt! < b.listedAt! ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const n = sorted.length;
  const chunks = 4;
  const base = Math.floor(n / chunks);
  const extra = n - base * chunks;
  const blocks: ModelRow[][] = [];
  let at = 0;
  for (let i = 0; i < chunks; i++) {
    const size = base + (i < extra ? 1 : 0);
    blocks.push(sorted.slice(at, at + size));
    at += size;
  }
  const predicted: number[] = [];
  const actual: number[] = [];
  for (let k = 0; k < chunks - 1; k++) {
    const train = blocks.slice(0, k + 1).flat();
    const model = fitValueModel(train, stages);
    for (const row of blocks[k + 1]) {
      predicted.push(predictValue(model, row).total);
      actual.push(row.y as number);
    }
  }
  return { predicted, actual };
}

// ------------------------------------------------------------------ board

// The farm stage leaves these in place until it runs; main.ts always
// runs addFarm before writing, so they never reach the board.
const FARM_PLACEHOLDERS: string[] = [
  "Placeholder langkah farm 1 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
  "Placeholder langkah farm 2 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
  "Placeholder langkah farm 3 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
  "Placeholder langkah farm 4 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
  "Placeholder langkah farm 5 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
  "Placeholder langkah farm 6 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
];

// Leave-one-out predicted cap/TVL ratio per priced slug, set by the
// latest buildBoardModel call. main.ts hands it to the farm stage so
// each peer's heldOut is a genuinely held-out number (predicted
// ratio over actual ratio), not the peer's own ratio restated.
let looRatioBySlug = new Map<string, number>();

export function looRatioPredictor(): (peer: Protocol) => number {
  const snapshot = looRatioBySlug;
  return (peer: Protocol): number => {
    const actual = peer.mcap_usd !== null && peer.tvl_usd > 0 ? peer.mcap_usd / peer.tvl_usd : 0;
    const predicted = snapshot.get(peer.slug);
    if (actual <= 0 || predicted === undefined) return 1;
    return predicted / actual;
  };
}

export function buildBoardModel(snapshot: Snapshot): Board {
  const seed = fnv1a(snapshot.as_of + "|" + snapshot.protocols.map((p) => p.slug).join(","));

  // --- priced protocols: a positive cap on a positive TVL. A recorded
  // cap of zero or less has no log ratio and is left out, not averaged.
  const priced: Protocol[] = [];
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!(ratio > 0)) continue;
    priced.push(p);
    allRatios.push(ratio);
    const key = p.category ?? "Uncategorized";
    const list = ratiosByCategory.get(key);
    if (list) list.push(ratio);
    else ratiosByCategory.set(key, [ratio]);
  }
  const globalMultiple = median(allRatios);

  const multiples: { category: string; multiple: number; n: number }[] = [];
  for (const [category, ratios] of [...ratiosByCategory.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
  )) {
    multiples.push({
      category,
      multiple:
        ratios.length >= 3 ? Math.min(1, Math.max(0.05, median(ratios))) : globalMultiple,
      n: ratios.length,
    });
  }

  // --- value-model rows, in slug order so the shuffle is stable.
  const orderedPriced = [...priced].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const shuffleRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const perm = orderedPriced.map((_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(shuffleRng() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const toModelRow = (p: Protocol, shuffledGrowth: number | null): ModelRow => ({
    slug: p.slug,
    listedAt: p.listed_at,
    ageYears:
      ageDays(snapshot.as_of, p.listed_at) === null
        ? null
        : (ageDays(snapshot.as_of, p.listed_at) as number) / 365.25,
    lnTvl: Math.log(p.tvl_usd / 1e8),
    growthRaw: p.change_7d,
    growthShuffled: shuffledGrowth,
    lnChains: Math.log(Math.max(1, p.chains.length)),
    family: familyOf(p.name, p.slug),
    category: p.category ?? "Uncategorized",
    y: p.mcap_usd !== null && p.tvl_usd > 0 ? Math.log(p.mcap_usd / p.tvl_usd) : null,
  });
  const valueRows: ModelRow[] = orderedPriced.map((p, i) =>
    toModelRow(p, orderedPriced[perm[i]].change_7d),
  );
  const datedRows = valueRows.filter((r) => r.listedAt !== null);
  const actuals = valueRows.map((r) => r.y as number);

  // --- sequential term selection for the value model.
  const constStage: Stage = { kind: "const", name: "flat median multiple" };
  const sizeStage: Stage = { kind: "ols", key: "lnTvl", name: "size curve ln(TVL)" };
  const familyStage: Stage = { kind: "group", key: "family", lambda: 8, name: "family effect (ridge)" };
  const categoryStage: Stage = {
    kind: "group",
    key: "category",
    lambda: 64,
    name: "category effect (ridge 64)",
  };
  const growthStage: Stage = { kind: "ols", key: "growth", name: "7-day TVL growth" };
  const ageStage: Stage = { kind: "ols", key: "age", name: "age (years listed)" };
  const chainsStage: Stage = { kind: "ols", key: "lnChains", name: "chain count (ln)" };
  const controlStage: Stage = {
    kind: "ols",
    key: "growthShuffled",
    name: "CONTROL shuffled growth",
  };

  const evaluate = (stages: Stage[]): { loo: number; wf: number } => {
    const looPreds = looPredictions(valueRows, stages);
    const wf = wfPredictions(datedRows, stages);
    return { loo: missFactor(looPreds, actuals), wf: missFactor(wf.predicted, wf.actual) };
  };

  const valueTerms: ValueTermEvidence[] = [];
  let keptStages: Stage[] = [constStage];
  let current = evaluate(keptStages);
  const baseline = { ...current };
  valueTerms.push({ name: constStage.name, loo: current.loo, wf: current.wf, kept: "baseline" });
  for (const stage of [sizeStage, familyStage, categoryStage, growthStage, ageStage, chainsStage]) {
    const candidate = [...keptStages, stage];
    const score = evaluate(candidate);
    const helps = score.loo < current.loo && score.wf < current.wf;
    valueTerms.push({ name: stage.name, loo: score.loo, wf: score.wf, kept: helps ? "kept" : "tested, not kept" });
    if (helps) {
      keptStages = candidate;
      current = score;
    }
  }
  // Control: growth taken from another protocol's row. It must not
  // help; it is never added to the model whatever it scores.
  const controlScore = evaluate([...keptStages, controlStage]);
  valueTerms.push({
    name: controlStage.name,
    loo: controlScore.loo,
    wf: controlScore.wf,
    kept: "must not help",
  });

  const finalValueModel = fitValueModel(valueRows, keptStages);
  const finalLooPreds = looPredictions(valueRows, keptStages);
  const looResiduals = actuals.map((y, i) => y - finalLooPreds[i]);
  const finalWf = wfPredictions(datedRows, keptStages);
  const wfResiduals = finalWf.actual.map((y, i) => y - finalWf.predicted[i]);
  const looQuantiles: ResidualQuantiles = residualQuantiles(looResiduals);
  const wfQuantiles: ResidualQuantiles = residualQuantiles(wfResiduals);

  // Remember the LOO predicted ratio of every priced protocol, so the
  // peer table can show a genuinely held-out model/actual figure.
  looRatioBySlug = new Map(
    valueRows.map((row, i) => [row.slug, Math.exp(finalLooPreds[i])] as [string, number]),
  );

  // --- honesty: what share of real caps landed inside the interval
  // that promised to hold them? Computed directly in ratio space: a
  // priced protocol's real mcap/TVL ratio against the interval around
  // its predicted ratio. LOO uses all priced rows; walk-forward uses
  // the dated rows that have a walk-forward prediction.
  const looActualRatios = valueRows.map((r) => Math.exp(r.y as number));
  const looPredRatios = finalLooPreds.map((p) => Math.exp(p));
  const looCover50 = coverageFraction(
    looActualRatios,
    looPredRatios.map((p) => p * Math.exp(looQuantiles.q25)),
    looPredRatios.map((p) => p * Math.exp(looQuantiles.q75)),
  );
  const looCover80 = coverageFraction(
    looActualRatios,
    looPredRatios.map((p) => p * Math.exp(looQuantiles.q10)),
    looPredRatios.map((p) => p * Math.exp(looQuantiles.q90)),
  );
  const wfActualRatios = finalWf.actual.map((y) => Math.exp(y));
  const wfPredRatios = finalWf.predicted.map((p) => Math.exp(p));
  const wfCover50 = coverageFraction(
    wfActualRatios,
    wfPredRatios.map((p) => p * Math.exp(wfQuantiles.q25)),
    wfPredRatios.map((p) => p * Math.exp(wfQuantiles.q75)),
  );
  const wfCover80 = coverageFraction(
    wfActualRatios,
    wfPredRatios.map((p) => p * Math.exp(wfQuantiles.q10)),
    wfPredRatios.map((p) => p * Math.exp(wfQuantiles.q90)),
  );

  // --- odds model: positive = the token TRADES (positive market cap
  // on a positive TVL); negative = no token recorded at all
  // (gecko_id and symbol both null). The middle class — a ticker is
  // recorded but the cap is null, zero, or negative (one protocol in
  // this snapshot, autofinance at −1) — is dropped from training:
  // it is neither a traded token nor a tokenless protocol, and
  // forcing it into either side would answer the wrong question.
  // The exclusion filter is unchanged; only the target changed.
  const oddsRows: OddsRow[] = [];
  for (const p of snapshot.protocols) {
    if (isOddsExcluded(p)) continue;
    const isPriced = p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
    const isNoTokenRow = p.gecko_id === null && p.symbol === null;
    if (!isPriced && !isNoTokenRow) continue; // "neither": recorded but not priced — out of training
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
  const { model: oddsModel, evidence: oddsEvidence } = fitOddsWithEvidence(oddsRows);

  // --- board rows.
  const watchlist = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter(isBoardCandidate);
  const boardFeature = (p: Protocol): ModelRow => toModelRow(p, null);
  const oddsFeature = (p: Protocol): OddsRow => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    return {
      slug: p.slug,
      listedAt: p.listed_at,
      ageYears: age === null ? null : age / 365.25,
      lnTvl: Math.log(p.tvl_usd / 1e8),
      growthRaw: p.change_7d,
      lnChains: Math.log(Math.max(1, p.chains.length)),
      family: familyOf(p.name, p.slug),
      category: p.category ?? "Uncategorized",
      y: 0,
    };
  };

  interface DraftRow {
    protocol: Protocol;
    implied: number;
    valueIfLaunches: number;
    odds: number;
    fittedMultiple: number;
    sizeFactor: number;
    categoryFactor: number;
  }
  const drafts: DraftRow[] = candidates.map((p) => {
    const pred = predictValue(finalValueModel, boardFeature(p));
    const fittedMultiple = Math.exp(pred.total);
    const odds = predictOdds(oddsModel, oddsFeature(p));
    const valueIfLaunches = Math.max(1, Math.round(p.tvl_usd * fittedMultiple));
    const implied = Math.max(1, Math.round(p.tvl_usd * fittedMultiple * odds));
    return {
      protocol: p,
      implied,
      valueIfLaunches,
      odds,
      fittedMultiple,
      sizeFactor: Math.exp(pred.sizePart),
      categoryFactor: Math.exp(pred.categoryPart),
    };
  });

  // --- bootstrap: refit the value model on 200 resamples of the
  // priced rows (seeded) and read the P5–P95 of each board row's
  // implied value. Odds are held fixed: the bootstrap measures the
  // multiple's sampling wobble, not the odds model's. Each refit
  // also re-ranks the whole board, so the P5–P95 of each row's rank
  // across refits is recorded alongside — a rank range, not a value
  // range, and a separate fact from it.
  const bootRng = mulberry32(seed);
  const bootCount = 200;
  const bootImplied: number[][] = drafts.map(() => []);
  const bootRanks: number[][] = drafts.map(() => []);
  for (let b = 0; b < bootCount; b++) {
    const resample: ModelRow[] = [];
    for (let i = 0; i < valueRows.length; i++) {
      resample.push(valueRows[Math.floor(bootRng() * valueRows.length)]);
    }
    const bootModel = fitValueModel(resample, keptStages);
    const bootValues = drafts.map((draft) => {
      const mult = Math.exp(predictValue(bootModel, boardFeature(draft.protocol)).total);
      return Math.max(1, Math.round(draft.protocol.tvl_usd * mult * draft.odds));
    });
    bootValues.forEach((v, i) => bootImplied[i].push(v));
    // Rank this refit's board the way the reader's board is ranked:
    // parent lines are discounted first (same factor as main.ts),
    // then implied down, TVL down, slug up. Ranking the raw
    // pre-discount values would flatter every parent line's range.
    const rankedValues = bootValues.map((v, i) =>
      drafts[i].protocol.slug in PARENT_PRODUCTS ? parentScale(v) : v,
    );
    const order = rankedValues
      .map((v, i) => i)
      .sort((a, b) => {
        if (rankedValues[b] !== rankedValues[a]) return rankedValues[b] - rankedValues[a];
        if (drafts[b].protocol.tvl_usd !== drafts[a].protocol.tvl_usd) {
          return drafts[b].protocol.tvl_usd - drafts[a].protocol.tvl_usd;
        }
        return drafts[a].protocol.slug < drafts[b].protocol.slug ? -1 : 1;
      });
    order.forEach((draftIndex, place) => {
      bootRanks[draftIndex].push(place + 1);
    });
  }
  const bootBounds = bootImplied.map((values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { low: quantile(sorted, 0.05), high: quantile(sorted, 0.95) };
  });
  const bootRankBounds = bootRanks.map((ranks) => {
    const sorted = [...ranks].sort((a, b) => a - b);
    return {
      low: Math.round(quantile(sorted, 0.05)),
      high: Math.round(quantile(sorted, 0.95)),
    };
  });
  // Attach the bootstrap bounds to their draft now: the ranking sort
  // below reorders the drafts, and an index taken after the sort
  // would point at the wrong row.
  drafts.forEach((draft, i) => {
    (draft as DraftRow & { bootLow: number; bootHigh: number; bootRankLow: number; bootRankHigh: number }).bootLow = bootBounds[i].low;
    (draft as DraftRow & { bootLow: number; bootHigh: number; bootRankLow: number; bootRankHigh: number }).bootHigh = bootBounds[i].high;
    (draft as DraftRow & { bootLow: number; bootHigh: number; bootRankLow: number; bootRankHigh: number }).bootRankLow = bootRankBounds[i].low;
    (draft as DraftRow & { bootLow: number; bootHigh: number; bootRankLow: number; bootRankHigh: number }).bootRankHigh = bootRankBounds[i].high;
  });

  // --- rank, strictly decreasing implied values (ties nudged down
  // by $1), then intervals from the LOO residual quantiles.
  drafts.sort((a, b) => {
    if (b.implied !== a.implied) return b.implied - a.implied;
    if (b.protocol.tvl_usd !== a.protocol.tvl_usd) return b.protocol.tvl_usd - a.protocol.tvl_usd;
    return a.protocol.slug < b.protocol.slug ? -1 : 1;
  });
  for (let i = 1; i < drafts.length; i++) {
    if (drafts[i].implied >= drafts[i - 1].implied) {
      drafts[i].implied = drafts[i - 1].implied - 1;
    }
  }
  const rows: BoardRow[] = drafts.map((draft, i) => {
    const p = draft.protocol;
    const age = ageDays(snapshot.as_of, p.listed_at);
    const bounds = intervalBounds(draft.implied, looQuantiles);
    const boot = draft as DraftRow & { bootLow: number; bootHigh: number; bootRankLow: number; bootRankHigh: number };
    const bootstrapLow = Math.max(1, Math.round(Math.min(boot.bootLow, draft.implied)));
    const bootstrapHigh = Math.max(1, Math.round(Math.max(boot.bootHigh, draft.implied)));
    return {
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Uncategorized",
      chains: p.chains,
      tvlUsd: p.tvl_usd,
      change7d: p.change_7d,
      ageDays: age,
      watchlist: watchlist.has(p.slug),
      rank: i + 1,
      impliedValueUsd: draft.implied,
      valueIfLaunches: draft.valueIfLaunches,
      tokenOdds: draft.odds,
      p25: bounds.p25,
      p75: bounds.p75,
      p10: bounds.p10,
      p90: bounds.p90,
      bootstrapLow,
      bootstrapHigh,
      bootstrapRankLow: boot.bootRankLow,
      bootstrapRankHigh: boot.bootRankHigh,
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
      farmSteps: [...FARM_PLACEHOLDERS],
      farmPlan: [],
      exitRule: "",
      peers: [],
    };
  });

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
      note:
        "Intervals are the implied value shifted by the quantiles of the value model's own held-out log residuals (LOO residuals for the board bounds). Coverage is the share of priced protocols whose real cap fell inside the interval: LOO over all priced rows, walk-forward over the dated rows with a walk-forward prediction.",
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
