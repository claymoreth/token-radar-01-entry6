// radar-7 accounting: every one of the snapshot's protocols lands
// in exactly one bucket, so the buckets always add up to the ledger
// total. The order below is the priority order — a protocol is tested
// top to bottom and takes the first bucket it matches, so no protocol
// is counted twice and none falls through the cracks.
//
//   ranked-watchlist            on the board AND on the 40-name watchlist
//   ranked-early-below-floor    on the board, pre-token, TVL below the floor
//   ranked-off-list             on the board, pre-token, anything else
//                               (for example a parent product's line
//                               ranked alongside the board entry)
//   token-trades-priced-comp    not ranked, token trades with a usable
//                               market cap (mcap > 0 and TVL > 0): the
//                               comparables the model is fitted on
//   token-recorded-no-usable-cap not ranked, a token is recorded (a symbol
//                               or a Gecko id) but the market cap is null
//                               or zero or negative, so no ratio exists
//   out-bridge                  Bridge / Canonical Bridge / Cross Chain Bridge
//   out-liquid-staking          Liquid Staking / Liquid Restaking
//   out-exchange                CEX
//   out-versioned-or-wrapped    everything left: versioned variants
//                               (v2, v3, ...) and unranked pre-token
//                               protocols with no recorded token
//
// "Has a token" is read from the snapshot's own fields (symbol or
// gecko_id), never from a name. The floor is read from the snapshot,
// never hardcoded — the "$50M" in the second label is the snapshot's
// own floor written out, and it must be rebuilt if the floor moves.

export interface AccountingProtocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface AccountingSnapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: AccountingProtocol[];
  watchlist: string[];
}

export interface AccountingGroup {
  key: string;
  label: string;
  count: number;
}

export interface Accounting {
  total: number;
  groups: AccountingGroup[];
  ranked: number;
  watchlist: number;
}

const BRIDGE_CATEGORIES = new Set(["Bridge", "Canonical Bridge", "Cross Chain Bridge"]);
const LIQUID_STAKING_CATEGORIES = new Set(["Liquid Staking", "Liquid Restaking"]);

function groupDefs(floorUsd: number): { key: string; label: string }[] {
  const floorLabel = floorUsd >= 1e6 ? `$${floorUsd / 1e6}M` : `$${floorUsd}`;
  return [
    { key: "ranked-watchlist", label: "Ranked — on the 40-name watchlist" },
    { key: "ranked-early-below-floor", label: `Ranked — early, pre-token, below the ${floorLabel} floor` },
    { key: "ranked-off-list", label: "Ranked — pre-token, off the watchlist and above the floor" },
    { key: "token-trades-priced-comp", label: "Priced token — trades, used as a comparable" },
    { key: "token-recorded-no-usable-cap", label: "Token recorded, but no usable market cap" },
    { key: "out-bridge", label: "Out — bridge" },
    { key: "out-liquid-staking", label: "Out — liquid staking / restaking" },
    { key: "out-exchange", label: "Out — centralised exchange" },
    { key: "out-versioned-or-wrapped", label: "Out — versioned/wrapped variant, or unranked pre-token with no recorded token" },
  ];
}

function classify(
  p: AccountingProtocol,
  ranked: Set<string>,
  watchlist: Set<string>,
  floorUsd: number,
): string {
  if (ranked.has(p.slug) && watchlist.has(p.slug)) return "ranked-watchlist";
  if (ranked.has(p.slug) && p.tvl_usd < floorUsd && p.mcap_usd === null) {
    return "ranked-early-below-floor";
  }
  if (ranked.has(p.slug)) return "ranked-off-list";
  if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
    return "token-trades-priced-comp";
  }
  if (p.symbol !== null || p.gecko_id !== null) return "token-recorded-no-usable-cap";
  if (BRIDGE_CATEGORIES.has(p.category)) return "out-bridge";
  if (LIQUID_STAKING_CATEGORIES.has(p.category)) return "out-liquid-staking";
  if (p.category === "CEX") return "out-exchange";
  return "out-versioned-or-wrapped";
}

export function buildAccounting(
  snapshot: AccountingSnapshot,
  rows: { slug: string }[],
): Accounting {
  const ranked = new Set(rows.map((r) => r.slug));
  const watchlist = new Set(snapshot.watchlist);
  const defs = groupDefs(snapshot.floor_usd);
  const counts = new Map<string, number>();
  for (const def of defs) counts.set(def.key, 0);
  for (const p of snapshot.protocols) {
    const key = classify(p, ranked, watchlist, snapshot.floor_usd);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups = defs.map((def) => ({
    key: def.key,
    label: def.label,
    count: counts.get(def.key) ?? 0,
  }));
  return {
    total: snapshot.protocols.length,
    groups,
    ranked: rows.length,
    watchlist: snapshot.watchlist.length,
  };
}
