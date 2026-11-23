// radar-7 — lib/accounting.ts
//
// The 758-protocol ledger buckets.
//
// Every protocol in the snapshot lands in exactly one bucket, so the
// bucket counts always add up to the ledger total — that is the whole
// point. A protocol is tested top to bottom against the nine groups
// in definition order and takes the FIRST bucket it matches, so the
// priority order below is load-bearing: a ranked protocol on the
// watchlist is counted there even though it would also match a later
// bucket, and a priced token is a comparable even if its category is
// also a bridge. The last bucket is the catch-all: anything that
// matched nothing above falls into it, so no protocol is ever left
// uncounted and the buckets always sum to the ledger total.
//
// The floor label is derived from the snapshot's own `floor_usd`
// (never hardcoded): with the kit snapshot's $50,000,000 floor the
// label reads "$50M". If a future snapshot changed the floor, the
// label would follow it.

/** One protocol, with exactly the ten fields the snapshot carries. */
export interface AccountingProtocol {
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

/** A snapshot, as far as accounting cares about it. */
export interface AccountingSnapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: AccountingProtocol[];
  watchlist: string[];
}

/** One ledger bucket: its key, its human label, and its count. */
export interface AccountingGroup {
  key: string;
  label: string;
  count: number;
}

/** The accounting block that ships inside board.json. */
export interface Accounting {
  total: number;
  groups: AccountingGroup[];
  ranked: number;
  watchlist: number;
}

/** Categories that make a protocol a bridge, for bucket purposes. */
const BRIDGE_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Cross Chain Bridge",
]);

/** Categories that make a protocol liquid staking / restaking. */
const LIQUID_STAKING_CATEGORIES = new Set([
  "Liquid Staking",
  "Liquid Restaking",
]);

/**
 * The nine bucket definitions, in the exact order protocols are
 * tested against them. `floorUsd` is threaded through so the two
 * labels that mention the floor can be built from it.
 *
 * The labels are written for the dashboard's ledger view; the
 * "ranked — early" label carries the derived floor label (for
 * example "$50M") in place of a hardcoded number.
 */
function groupDefinitions(floorUsd: number): AccountingGroup[] {
  const floorLabel =
    floorUsd >= 1e6 ? "$" + floorUsd / 1e6 + "M" : "$" + floorUsd;
  return [
    {
      key: "ranked-watchlist",
      label: "Ranked — on the 40-name watchlist",
      count: 0,
    },
    {
      key: "ranked-early-below-floor",
      label: `Ranked — early, pre-token, below the ${floorLabel} floor`,
      count: 0,
    },
    {
      key: "ranked-off-list",
      label: "Ranked — pre-token, off the watchlist and above the floor",
      count: 0,
    },
    {
      key: "token-trades-priced-comp",
      label: "Priced token — trades, used as a comparable",
      count: 0,
    },
    {
      key: "token-recorded-no-usable-cap",
      label: "Token recorded, but no usable market cap",
      count: 0,
    },
    {
      key: "out-bridge",
      label: "Out — bridge",
      count: 0,
    },
    {
      key: "out-liquid-staking",
      label: "Out — liquid staking / restaking",
      count: 0,
    },
    {
      key: "out-exchange",
      label: "Out — centralised exchange",
      count: 0,
    },
    {
      key: "out-versioned-or-wrapped",
      label:
        "Out — versioned/wrapped variant, or unranked pre-token with no recorded token",
      count: 0,
    },
  ];
}

/**
 * Classify one protocol into its bucket key. First match wins.
 *
 * The tests, in order:
 *  1. ranked AND on the watchlist;
 *  2. ranked AND below the floor AND with no market cap at all
 *     (an early, pre-token protocol too small to rank on size);
 *  3. ranked, anything else (pre-token, off the watchlist, above
 *     the floor);
 *  4. a market cap that is present, positive, on a positive TVL —
 *     its token trades, so it is a priced comparable;
 *  5. a ticker recorded somewhere (a symbol or a gecko id) but no
 *     usable cap — the token is recorded, not tradeable;
 *  6. a bridge category;
 *  7. a liquid staking / restaking category;
 *  8. exactly the "CEX" category;
 *  9. everything else: versioned or wrapped variants, and unranked
 *     pre-token protocols with no recorded token.
 *
 * Note what rule 2 does NOT check: it does not ask whether the
 * protocol has a recorded token — a ranked row is pre-token by
 * construction, so `mcap_usd === null` is the only extra condition
 * it needs.
 */
function classifyProtocol(
  p: AccountingProtocol,
  rankedSlugs: Set<string>,
  watchlistSlugs: Set<string>,
  floorUsd: number,
): string {
  const ranked = rankedSlugs.has(p.slug);
  if (ranked && watchlistSlugs.has(p.slug)) return "ranked-watchlist";
  if (ranked && p.tvl_usd < floorUsd && p.mcap_usd === null) {
    return "ranked-early-below-floor";
  }
  if (ranked) return "ranked-off-list";
  if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
    return "token-trades-priced-comp";
  }
  if (p.symbol !== null || p.gecko_id !== null) {
    return "token-recorded-no-usable-cap";
  }
  if (p.category !== null && BRIDGE_CATEGORIES.has(p.category)) {
    return "out-bridge";
  }
  if (p.category !== null && LIQUID_STAKING_CATEGORIES.has(p.category)) {
    return "out-liquid-staking";
  }
  if (p.category === "CEX") return "out-exchange";
  return "out-versioned-or-wrapped";
}

/**
 * Build the accounting block for a snapshot and a finished board.
 *
 * The ranked set is the slugs of the rows passed in; the watchlist
 * set is the snapshot's watchlist. Every protocol is classified in
 * snapshot order and its bucket incremented. The returned object is
 * keyed total, groups, ranked, watchlist, in that order, and the
 * groups stay in definition order.
 *
 * Expected counts on the kit snapshot: total 758; groups in order
 * 40 / 138 / 20 / 128 / 288 / 43 / 41 / 42 / 18; ranked 198;
 * watchlist 40.
 */
export function buildAccounting(
  snapshot: AccountingSnapshot,
  rows: { slug: string }[],
): Accounting {
  const rankedSlugs = new Set(rows.map((row) => row.slug));
  const watchlistSlugs = new Set(snapshot.watchlist);
  const groups = groupDefinitions(snapshot.floor_usd);
  const byKey = new Map(groups.map((group) => [group.key, group]));
  for (const protocol of snapshot.protocols) {
    const key = classifyProtocol(
      protocol,
      rankedSlugs,
      watchlistSlugs,
      snapshot.floor_usd,
    );
    const group = byKey.get(key);
    if (group !== undefined) group.count += 1;
  }
  return {
    total: snapshot.protocols.length,
    groups,
    ranked: rows.length,
    watchlist: snapshot.watchlist.length,
  };
}
