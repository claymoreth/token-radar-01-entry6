// radar-7 — lib/odds.ts
//
// Token-odds logistic regression: for a protocol with no token yet,
// how likely is its token to actually TRADE?
//
// The target is deliberately narrow. `y = 1` when the token trades —
// a positive market cap on a positive TVL — and `y = 0` when no token
// is recorded at all (both `gecko_id` and `symbol` are null). The
// middle class, a ticker recorded but no usable cap, is left OUT of
// training entirely: this file only ever sees the `y` it is handed,
// and the three-way split that produces those rows lives in
// lib/model.ts. On the kit snapshot that leaves n = 290 training
// rows, 92 trading against 198 tokenless, a base rate of about 31.7%.
//
// The regression itself is written from scratch on the standard
// library: full-batch gradient descent, a ridge penalty on every
// weight except the bias, and a sigmoid whose input is clamped so it
// can never overflow. Nothing is hardcoded — every level, mean,
// scale and weight is fitted at run time from the rows passed in.
//
// Term selection is sequential and strict. Groups are tried in a
// fixed order (age, ln(TVL), growth, family, category, chain count)
// and a group is kept only when it lowers the Brier score on BOTH
// out-of-sample tests at once: ten-fold cross-validation and a
// chronological walk-forward. A group that helps one test and hurts
// the other is not kept. The baseline is the intercept-only model,
// which always predicts the base rate.
//
// Two details that are easy to get wrong and expensive when they
// are: family and category enter as raw 0/1 dummy columns with a
// ridge penalty of 16 each — they are NOT standardised, unlike the
// numeric columns — and the two Brier tests use different row
// orders (ten-fold sorts by slug, walk-forward sorts by listing
// date), so neither may borrow the other's ordering. A third:
// `fitStats` builds the raw matrix with the imputation means before
// it computes column means, so a column's mean is the mean of the
// imputed values, not of the observed ones alone.

/** One training (or prediction) row for the odds model. */
export interface OddsRow {
  slug: string;
  listedAt: string | null;
  ageYears: number | null;
  lnTvl: number;
  growthRaw: number | null;
  lnChains: number;
  family: string;
  category: string;
  y: number;
}

/** Whether a tested term made it into the model. */
export type OddsTermKept = "kept" | "tested, not kept" | "baseline";

/** One term's out-of-sample evidence, for the evidence block. */
export interface OddsTermEvidence {
  name: string;
  brier: number;
  wfBrier: number;
  kept: OddsTermKept;
}

/** The whole odds evidence block that ships inside board.json. */
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

/**
 * The six feature groups, in the order sequential selection tries
 * them. The order is part of the model: trying them in a different
 * order could keep a different set.
 */
export const ODDS_GROUPS = [
  "age",
  "lntvl",
  "growth",
  "family",
  "category",
  "lnch",
] as const;

/** One of the six feature groups. */
export type OddsGroup = (typeof ODDS_GROUPS)[number];

/** Human labels for the groups, exactly as the evidence block shows them. */
const GROUP_LABELS: Record<OddsGroup, string> = {
  age: "age (years listed)",
  lntvl: "ln(TVL)",
  growth: "7-day TVL growth",
  family: "family (ridge 16, raw dummies)",
  category: "category (ridge 16, raw dummies)",
  lnch: "chain count (ln)",
};

/** Fit-time statistics: imputation means, dummy levels, and scales. */
interface OddsStats {
  meanAge: number;
  meanGrowth: number;
  catLevels: string[];
  famLevels: string[];
  means: number[];
  sds: number[];
}

/** A fitted odds model: its groups, its statistics, its weights. */
export interface OddsModel {
  groups: OddsGroup[];
  stats: OddsStats;
  weights: number[];
  baseRate: number;
}

/**
 * Sigmoid with its input clamped to [-30, 30] first, so exp can
 * never overflow: at z = 30 the result is already 0.9999999999999,
 * and anything beyond that is indistinguishable from 1 in a double.
 */
export function sigmoid(z: number): number {
  const clamped = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-clamped));
}

/** Mean of an array, in index order; empty arrays give 0. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * The raw design columns for one row, under a given group set.
 *
 * Groups are walked in the order given, and each contributes:
 *  - age: the row's age in years, or the fitted mean age when the
 *    protocol has no listing date;
 *  - lntvl: the row's ln(TVL), as supplied;
 *  - growth: the row's 7-day growth (or the fitted mean growth),
 *    clamped to [-0.9, 3] so one wild week cannot dominate;
 *  - lnch: the row's ln(chain count), as supplied;
 *  - family: one raw 0/1 dummy per fitted family level;
 *  - category: one raw 0/1 dummy per fitted category level.
 *
 * A group not in `groups` contributes nothing. Numeric columns are
 * standardised downstream; the family/category dummies are NOT —
 * they pass through as 0/1, which is why columnInfo marks them raw.
 */
function rawColumns(
  row: OddsRow,
  groups: readonly OddsGroup[],
  stats: OddsStats,
): number[] {
  const columns: number[] = [];
  for (const group of groups) {
    if (group === "age") {
      columns.push(row.ageYears ?? stats.meanAge);
    } else if (group === "lntvl") {
      columns.push(row.lnTvl);
    } else if (group === "growth") {
      const growth = row.growthRaw ?? stats.meanGrowth;
      columns.push(Math.max(-0.9, Math.min(3, growth)));
    } else if (group === "lnch") {
      columns.push(row.lnChains);
    } else if (group === "family") {
      for (const level of stats.famLevels) {
        columns.push(row.family === level ? 1 : 0);
      }
    } else if (group === "category") {
      for (const level of stats.catLevels) {
        columns.push(row.category === level ? 1 : 0);
      }
    }
  }
  return columns;
}

/**
 * Column metadata, aligned with the raw columns.
 *
 * `raw` is true for family/category dummy columns and false for
 * numeric ones. `penalty` is 16 for each dummy column — the ridge
 * strength that keeps a level seen only a couple of times from
 * swinging the model — and 1 for each numeric column.
 */
function columnInfo(
  groups: readonly OddsGroup[],
  stats: OddsStats,
): { raw: boolean[]; penalty: number[] } {
  const raw: boolean[] = [];
  const penalty: number[] = [];
  for (const group of groups) {
    if (group === "family") {
      for (let i = 0; i < stats.famLevels.length; i++) {
        raw.push(true);
        penalty.push(16);
      }
    } else if (group === "category") {
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

/**
 * Fit-time statistics for a group set over a set of rows.
 *
 * Mean age and mean growth are taken over the rows that actually
 * have those values (0 when none do — those means are also the
 * imputation values rawColumns falls back to). Family levels are
 * the families seen at least twice, sorted alphabetically; category
 * levels are every distinct category, sorted alphabetically. Then
 * each column's mean and population standard deviation (dividing by
 * n, not n-1) are computed over the rows — except that every raw
 * dummy column is overridden to mean 0 and sd 1 afterwards, so the
 * design matrix passes its 0/1 values through unchanged.
 */
function fitStats(
  rows: OddsRow[],
  groups: readonly OddsGroup[],
): OddsStats {
  const ages: number[] = [];
  const growths: number[] = [];
  const familyCounts = new Map<string, number>();
  const categorySet = new Set<string>();
  for (const row of rows) {
    if (row.ageYears !== null) ages.push(row.ageYears);
    if (row.growthRaw !== null) growths.push(row.growthRaw);
    familyCounts.set(row.family, (familyCounts.get(row.family) ?? 0) + 1);
    categorySet.add(row.category);
  }
  const famLevels = [...familyCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([family]) => family)
    .sort();
  const catLevels = [...categorySet].sort();
  const stats: OddsStats = {
    meanAge: mean(ages),
    meanGrowth: mean(growths),
    catLevels,
    famLevels,
    means: [],
    sds: [],
  };
  const rawMatrix = rows.map((row) => rawColumns(row, groups, stats));
  const d = rawMatrix.length > 0 ? rawMatrix[0]!.length : 0;
  const info = columnInfo(groups, stats);
  for (let j = 0; j < d; j++) {
    let total = 0;
    for (let i = 0; i < rawMatrix.length; i++) total += rawMatrix[i]![j]!;
    const colMean = rawMatrix.length > 0 ? total / rawMatrix.length : 0;
    let varianceTotal = 0;
    for (let i = 0; i < rawMatrix.length; i++) {
      const diff = rawMatrix[i]![j]! - colMean;
      varianceTotal += diff * diff;
    }
    const variance =
      rawMatrix.length > 0 ? varianceTotal / rawMatrix.length : 0;
    stats.means.push(colMean);
    stats.sds.push(variance > 1e-12 ? Math.sqrt(variance) : 1);
  }
  for (let j = 0; j < d; j++) {
    if (info.raw[j]) {
      stats.means[j] = 0;
      stats.sds[j] = 1;
    }
  }
  return stats;
}

/**
 * The standardised design matrix: each raw column mapped to
 * `(value - mean) / sd`, using the fitted statistics. Raw dummy
 * columns have mean 0 and sd 1 by construction, so they come
 * through as their original 0/1.
 */
function designMatrix(
  rows: OddsRow[],
  groups: readonly OddsGroup[],
  stats: OddsStats,
): number[][] {
  return rows.map((row) => {
    const raw = rawColumns(row, groups, stats);
    return raw.map((value, j) => (value - stats.means[j]!) / stats.sds[j]!);
  });
}

/**
 * Full-batch logistic regression by gradient descent.
 *
 * Weights start at zero (bias first, then one per design column).
 * Each iteration accumulates the gradient over every row — the
 * error `sigmoid(z) - y`, times each column for its weight — then
 * steps every weight by learning rate 0.15 times the mean gradient
 * plus its ridge penalty, where the penalty is
 * `penalties[j-1] * w[j] / n` and the bias (j = 0) is unpenalised.
 * The loop runs at most 1000 iterations and stops early when the
 * largest single step drops below 1e-9.
 */
function fitLogistic(
  x: number[][],
  y: number[],
  penalties: number[],
): number[] {
  const n = x.length;
  const d = n > 0 ? x[0]!.length : 0;
  const w: number[] = new Array(d + 1).fill(0);
  const learningRate = 0.15;
  for (let iteration = 0; iteration < 1000; iteration++) {
    const grad: number[] = new Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let z = w[0]!;
      for (let j = 0; j < d; j++) z += w[j + 1]! * x[i]![j]!;
      const err = sigmoid(z) - y[i]!;
      grad[0]! += err;
      for (let j = 0; j < d; j++) grad[j + 1]! += err * x[i]![j]!;
    }
    let largestStep = 0;
    for (let j = 0; j <= d; j++) {
      const penalty = j === 0 ? 0 : (penalties[j - 1]! * w[j]!) / n;
      const step = learningRate * (grad[j]! / n + penalty);
      w[j]! -= step;
      const size = Math.abs(step);
      if (size > largestStep) largestStep = size;
    }
    if (largestStep < 1e-9) break;
  }
  return w;
}

/**
 * Fit the odds model for a group set: statistics, design matrix,
 * then the logistic fit. `baseRate` is carried on the model for
 * reference; the fit itself does not use it.
 */
export function fitOdds(
  rows: OddsRow[],
  groups: readonly OddsGroup[],
  baseRate: number,
): OddsModel {
  const stats = fitStats(rows, groups);
  const x = designMatrix(rows, groups, stats);
  const weights = fitLogistic(
    x,
    rows.map((row) => row.y),
    columnInfo(groups, stats).penalty,
  );
  return { groups: [...groups], stats, weights, baseRate };
}

/**
 * Predict the token-trading probability for one row.
 *
 * The row's raw columns are standardised with the model's own
 * statistics, the linear score is the bias plus the weighted
 * columns, and the sigmoid of that score is clipped to [0.02, 0.98]:
 * a protocol is never priced as certainly tokenless or certainly
 * tokenised, however extreme its features.
 */
export function predictOdds(model: OddsModel, row: OddsRow): number {
  const raw = rawColumns(row, model.groups, model.stats);
  const standardised = raw.map(
    (value, j) => (value - model.stats.means[j]!) / model.stats.sds[j]!,
  );
  let z = model.weights[0]!;
  for (let j = 0; j < standardised.length; j++) {
    z += model.weights[j + 1]! * standardised[j]!;
  }
  const p = sigmoid(z);
  return Math.max(0.02, Math.min(0.98, p));
}

/**
 * Brier score: the mean squared error between predicted
 * probabilities and actual 0/1 outcomes. Empty inputs score 0.
 * Lower is better; a model that always predicts the base rate
 * scores `baseRate * (1 - baseRate)` in expectation.
 */
export function brierScore(predicted: number[], actual: number[]): number {
  if (predicted.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < predicted.length; i++) {
    const diff = predicted[i]! - actual[i]!;
    total += diff * diff;
  }
  return total / predicted.length;
}

/**
 * Expanding chronological folds over an already-sorted array.
 *
 * The rows are cut into 4 consecutive blocks, as equal as possible:
 * `base = floor(n / 4)` rows each, with the first `n - base * 4`
 * blocks getting one extra row. Three folds are returned: fold k
 * trains on blocks 0..k and tests on block k+1, so the test set is
 * always strictly later in the given order than everything it was
 * trained on. That is what makes the walk-forward test honest — no
 * future information leaks into the training set.
 */
export function expandingFolds<T>(
  sortedRows: T[],
): { train: T[]; test: T[] }[] {
  const n = sortedRows.length;
  const chunks = 4;
  const base = Math.floor(n / chunks);
  const extra = n - base * chunks;
  const blocks: T[][] = [];
  let start = 0;
  for (let b = 0; b < chunks; b++) {
    const size = base + (b < extra ? 1 : 0);
    blocks.push(sortedRows.slice(start, start + size));
    start += size;
  }
  const folds: { train: T[]; test: T[] }[] = [];
  for (let k = 0; k < 3; k++) {
    const train = blocks.slice(0, k + 1).flat();
    const test = blocks[k + 1]!;
    folds.push({ train, test });
  }
  return folds;
}

/**
 * Ten-fold Brier score, with folds assigned by slug order.
 *
 * Rows are sorted by slug ascending first, so the fold assignment
 * is deterministic and independent of snapshot order. Fold f holds
 * out every row whose sorted index satisfies `i % 10 === f`; the
 * model is fitted on the other nine tenths and predicts the held
 * out tenth. The predictions are placed back by `indexOf` lookup —
 * slugs are unique, so each row lands in its own slot — and the
 * Brier score is taken over the full ordered set.
 */
export function tenFoldBrier(
  rows: OddsRow[],
  groups: readonly OddsGroup[],
): number {
  const ordered = [...rows].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const predicted: number[] = new Array(ordered.length).fill(0);
  for (let fold = 0; fold < 10; fold++) {
    const train = ordered.filter((_, i) => i % 10 !== fold);
    const test = ordered.filter((_, i) => i % 10 === fold);
    if (test.length === 0) continue;
    const baseRate = mean(train.map((row) => row.y));
    const model = fitOdds(train, groups, baseRate);
    for (const row of test) {
      predicted[ordered.indexOf(row)] = predictOdds(model, row);
    }
  }
  return brierScore(predicted, ordered.map((row) => row.y));
}

/**
 * Walk-forward Brier score over the dated rows.
 *
 * Only rows with a listing date take part, sorted by (listedAt,
 * then slug). Each expanding fold fits on the earlier blocks and
 * predicts the next one; the predictions and actuals accumulate
 * across folds in fold order. `correct` is the share of test rows
 * where thresholding the prediction at the overall base rate
 * (predict 1 when p > baseRate, else 0) matches the actual outcome.
 * It returns the predictions and actuals too, so callers can reuse
 * them without re-running the folds.
 */
export function walkForwardBrier(
  rows: OddsRow[],
  groups: readonly OddsGroup[],
): {
  brier: number;
  correct: number;
  n: number;
  predicted: number[];
  actual: number[];
} {
  const dated = rows
    .filter((row) => row.listedAt !== null)
    .sort((a, b) => {
      if (a.listedAt! !== b.listedAt!) {
        return a.listedAt! < b.listedAt! ? -1 : 1;
      }
      return a.slug < b.slug ? -1 : 1;
    });
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const fold of expandingFolds(dated)) {
    const baseRate = mean(fold.train.map((row) => row.y));
    const model = fitOdds(fold.train, groups, baseRate);
    for (const row of fold.test) {
      predicted.push(predictOdds(model, row));
      actual.push(row.y);
    }
  }
  const baseRate = mean(rows.map((row) => row.y));
  let correctCount = 0;
  for (let i = 0; i < actual.length; i++) {
    const call = predicted[i]! > baseRate ? 1 : 0;
    if (call === actual[i]) correctCount += 1;
  }
  const correct = actual.length > 0 ? correctCount / actual.length : 0;
  return {
    brier: brierScore(predicted, actual),
    correct,
    n: actual.length,
    predicted,
    actual,
  };
}

/**
 * Baseline walk-forward Brier: the same dated sort and the same
 * expanding folds, but each fold predicts its training-set base
 * rate for every test row. This is the intercept-only model's
 * walk-forward score — the number the fitted model has to beat.
 */
export function baselineWalkForwardBrier(rows: OddsRow[]): number {
  const dated = rows
    .filter((row) => row.listedAt !== null)
    .sort((a, b) => {
      if (a.listedAt! !== b.listedAt!) {
        return a.listedAt! < b.listedAt! ? -1 : 1;
      }
      return a.slug < b.slug ? -1 : 1;
    });
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const fold of expandingFolds(dated)) {
    const rate = mean(fold.train.map((row) => row.y));
    for (const row of fold.test) {
      predicted.push(rate);
      actual.push(row.y);
    }
  }
  return brierScore(predicted, actual);
}

/**
 * Sequential selection with evidence: fit the odds model, deciding
 * group by group which features earn their place.
 *
 * The baseline term is the intercept-only model. Then each group in
 * ODDS_GROUPS order is tried on top of everything kept so far, and
 * kept only when its candidate model scores strictly better on
 * BOTH the ten-fold Brier and the walk-forward Brier. The final
 * Brier figures and walk-forward accuracy track the best kept
 * model; when nothing is kept at all, the walk-forward accuracy
 * falls back to the empty-group model's. The returned evidence
 * records every tried term, kept or not, so the dashboard can show
 * the whole selection story, not just the winner.
 *
 * Expected on the kit snapshot: n = 290, base rate ≈ 0.317, final
 * Brier ≈ 0.178 ten-fold and ≈ 0.135 walk-forward, walk-forward
 * correct ≈ 0.79.
 */
export function fitOddsWithEvidence(rows: OddsRow[]): {
  model: OddsModel;
  evidence: OddsEvidence;
} {
  const baseRate = mean(rows.map((row) => row.y));
  const baselineBrier = brierScore(
    rows.map(() => baseRate),
    rows.map((row) => row.y),
  );
  const baselineWfBrier = baselineWalkForwardBrier(rows);
  const terms: OddsTermEvidence[] = [
    {
      name: "intercept-only (base rate)",
      brier: baselineBrier,
      wfBrier: baselineWfBrier,
      kept: "baseline",
    },
  ];
  const kept: OddsGroup[] = [];
  let bestBrier = baselineBrier;
  let bestWfBrier = baselineWfBrier;
  let finalBrier = baselineBrier;
  let finalWfBrier = baselineWfBrier;
  let finalCorrect = 0;
  for (const group of ODDS_GROUPS) {
    const candidate: OddsGroup[] = [...kept, group];
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
      kept.push(group);
      bestBrier = brier;
      bestWfBrier = wf.brier;
      finalBrier = brier;
      finalWfBrier = wf.brier;
      finalCorrect = wf.correct;
    }
  }
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
