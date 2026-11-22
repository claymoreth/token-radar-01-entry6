# Launch Radar — radar-7

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/claymoreth/token-radar-01-entry6/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/claymoreth/token-radar-01-entry6/reward.svg)](https://make.fun/bounty/token-radar-01)

Pre-token protocols, valued from their own record — not from hype. An entry for
[make.fun's token-radar-01 bounty](https://make.fun/bounty/token-radar-01): 198
pre-token protocols ranked by implied value, each with a costed farm verdict
and a ten-step farm plan, on one static dashboard.

## How the board is made

The board answers one question: if a protocol with no token issued one
tomorrow, what would it be worth? The answer is fitted from the snapshot's
own priced protocols, never from a hardcoded name or number:

**implied value = TVL × fitted multiple × token odds**

- **Fitted multiple.** A log-ratio model: the target is ln(mcap / TVL) over
  the 128 priced protocols. Terms are added one at a time and kept only when
  they lower the held-out miss in **both** out-of-sample tests —
  leave-one-out and a chronological walk-forward. Only the size curve
  ln(TVL) survived: final LOO miss 3.40, walk-forward 2.89, against a flat
  baseline of 5.07 / 5.29. A shuffled-growth control term is tested and
  never kept. Category and family were tested and did not survive either
  test — the category effect fails leave-one-out even though it helps
  walk-forward, so the model stays size-only.
- **Token odds.** A logistic regression on whether a protocol's token
  TRADES — positive market cap on a positive TVL — against no token
  recorded at all. Protocols in between, whose ticker is recorded but
  whose token does not trade (288 of them, including one with a negative
  cap), are left out of training, not forced into either side. That
  costs training rows: n = 290, base rate 31.7% (92 trade, 198 do not).
  Final Brier 0.178 ten-fold, 0.135 walk-forward, against a base-rate
  baseline of 0.217 / 0.211; 79% of walk-forward calls right. Age, 7-day
  growth and category are kept (family, ln(TVL) and chain count tested,
  not kept). Family and category enter as two separate ridge groups —
  raw 0/1 dummies, λ=16 each — not one standardised block: the
  standardised block scored 0.301 walk-forward, worse than the numeric
  model alone. Read the trade-off honestly: this target trains on fewer
  protocols and a lower base rate than a ticker-recorded model (n = 442,
  base 55%), so the board's total implied value is smaller — $517.0M
  instead of $994.4M under the ticker definition — but the walk-forward
  score is far steadier (0.135 vs 0.259) and far more calls land right
  (79% vs 63%). The odds are the chance the token trades, not the chance
  DefiLlama writes a ticker down.
- **Ranges.** Every row shows P25–P75 and P10–P90 from the quantiles of the
  value model's own held-out log residuals — and the dashboard shows
  whether those bands held out of sample: P25–P75 caught 50% (LOO) and
  49% (walk-forward) against a stated 50%; P10–P90 caught 80% and 79%
  against a stated 80%. Each row also carries a bootstrap rank range
  (P5–P95 of its rank across 200 refits, parent discount applied inside
  the refits): rank 1 Steakhouse sits at 1–2, Polymarket International
  at 4–6.
- **Costed farm verdicts.** Each row's plan is sized at 0.02% of its TVL
  (clamped to $100–$10,000), the modelled drop is 7% of implied value,
  fees are the plan's on-chain transactions at the mid-point gas price of
  its main chain, and time is the hands-on minutes of the ten steps.
  FARM clears both a 12-week T-bill on the same deposit and $25/hour for
  the farmer's time; MARGINAL clears neither fully but still nets above
  zero; SKIP loses money to gas. On this snapshot **0 rows clear both
  bars** — the board is 0 FARM, 131 MARGINAL and 67 SKIP. The best net
  is marginfi Lending at $23.60/hour (net $80.72 on a $5,542.60 deposit;
  it clears its $51.16 T-bill bar but not the $25/hour bar), then Lofty
  at $21.10/hour. That is the honest consequence of the traded-token
  odds: lower odds, smaller drops, no farm clears both bars. The detail
  view shows the benchmarks (T-bill, drop if a token launches, the drop
  share and odds above which fees are covered, the quantified exit TVL)
  and a net grid by drop share × deposit.
- **Parent products.** A row whose slug is on the fixed list of 20
  parent-product lines (ported verbatim from the v4 entry, `lib/parent.ts`
  `PARENT_PRODUCTS`) keeps 48% of its fitted value and is marked
  off-list ("Off-List · Parent ×0.48"). Matching is by exact slug,
  case-sensitive — no substring or name matching. Twenty rows are caught
  on this snapshot, including Polymarket International (rank #5 at
  $11.9M after the discount; $29.3M if it launches, odds 84%), Sentora
  Curator, Defi Saver Asset Management and Circle Gateway. The label
  shown is the v4 description of the line (e.g. "Polymarket
  international arm"), not a parent name.
- **Protocol accounting.** All 758 protocols land in exactly one bucket
  (40 watchlist, 138 early below the $50M floor, 20 off-list, 128 priced
  comparables, 288 token-recorded without a usable cap, 43 bridges, 41
  liquid staking, 42 exchanges, 18 versioned/wrapped), so the buckets
  always add up to the ledger total. The dashboard recomputes six
  integrity checks in the browser from the data file itself, including
  an FNV-1a checksum of the ranked rows (7186dec9, verified independently
  in Python). Nearest priced peers carry a genuinely held-out figure:
  the leave-one-out model prediction over the peer's actual cap/TVL
  ratio — 1.00 means the model priced the peer exactly.

## Run it locally

Node 22 or later, standard library only — no install step.

```sh
mkdir -p out
RADAR_INPUT=<path to snapshot.json> RADAR_OUTPUT=out node main.ts
```

`--input <snapshot.json|directory>` overrides `RADAR_INPUT`;
`--output <dir>` overrides `RADAR_OUTPUT` (default `/output`,
`MAKEFUN_OUTPUT_DIR` outside the grader's container). The run writes
`out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/`
and `out/dossier.json` (the dossier needs the three screenshots in
`screenshots/` first: `1-board.png`, `2-detail.png`, `3-filtered.png`).
The run is deterministic: the same snapshot always yields the same bytes
(board.json md5 112ec9146d16f80369b1d66eea9cf430 across runs).

## Layout

- `main.ts` — the entry runner: model → parent discount → farm →
  accounting → integrity → board.json / data.js / dossier.json.
- `lib/model.ts` — the fitted value model, token odds and intervals.
- `lib/odds.ts` — the token-odds logistic regression.
- `lib/range.ts` — residual quantiles, coverage and the seeded PRNG.
- `lib/farm.ts` — farm economics, the ten-step plan, peers.
- `lib/accounting.ts` — the 758-protocol ledger buckets.
- `lib/integrity.ts` — the FNV-1a checksum and ledger counts.
- `lib/parent.ts` — the 20 parent-product lines and the ×0.48 factor,
  shared by the runner and the bootstrap rank range.
- `dashboard/` — the static page (`index.html`, `app.css`, `app.js`);
  it reads `../data.js`, makes no network request.
- `vendor/makefun-board.ts` — make.fun's dashboard-dossier library.
