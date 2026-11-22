// radar-7 parent products: the fixed list of product lines that
// belong to a parent protocol or company, not standalone launches.
//
// Ported verbatim from the v4 entry (entry4 lib/model.ts:124-145).
// Each value is v4's description of the line, not a parent name, and
// the list's claim — that the line will never issue a token of its
// own — is v4's model assumption, not a fact verified per protocol
// here.
//
// One home for the list, imported by both main.ts (which discounts
// the board) and lib/model.ts (which needs the same factor when it
// re-ranks the board inside the bootstrap, so the rank range is
// measured on the discounted board the reader actually sees, not on
// the pre-discount drafts). Matching is by exact slug,
// case-sensitive — no substring or name matching.

/** A parent product's line keeps this share of its fitted value. */
export const PARENT_FACTOR = 0.48;

export const PARENT_PRODUCTS: Record<string, string> = {
  "arcus-perps": "Arcus perps desk",
  "avant-avusd": "Avant avUSD stablecoin",
  "azverse-perps": "AZverse perps desk",
  "bitfi-basis": "BitFi basis-trading product",
  "cian-yield-layer": "CIAN yield product",
  "circle-gateway": "Circle cross-chain product",
  "defi-saver-asset-management": "DeFi Saver asset-management product",
  "extended-perps": "Extended perps desk",
  "figure-markets-exchange": "Figure Markets exchange arm",
  "figure-markets-prime": "Figure Markets prime arm",
  "ipor-fusion": "IPOR Fusion vault product",
  "loopscale-lending": "Loopscale lending product",
  "mellow-core": "Mellow core vault product",
  "nado-spot": "Nado spot product",
  "polymarket-international": "Polymarket international arm",
  "sentora-curator": "Sentora curator product",
  "solv-strategies": "Solv strategy product",
  "stellar-defi-hub": "Stellar DeFi hub product",
  "theo-network-thusd": "Theo Network thUSD stablecoin",
  "usdcx": "Circle USDCx wrapped product",
};

/** The discounted value of a fitted figure, as the board shows it. */
export function parentScale(v: number): number {
  return Math.max(1, Math.round(v * PARENT_FACTOR));
}
