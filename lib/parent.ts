// radar-7 — lib/parent.ts
//
// The 20 parent-product lines and the ×0.48 factor.
//
// Some board rows are not standalone protocols at all: they are one
// product line of a larger parent that already records a token of its
// own. A line like that cannot launch a token of its own at full
// value, so the board keeps only 48% of its fitted implied value and
// marks the row off-list, labelled with the description of the line.
//
// The list itself is a fixed data table ported from the v4 entry, and
// the descriptions are v4's descriptions of each line — they are NOT
// parent names, and they must not be "improved" or renamed. Matching
// is by exact slug, case-sensitive. No substring matching, no name
// matching: a slug either is on this list, letter for letter, or it
// is not a parent-product line.
//
// The same factor is used in two places, so it lives here once: the
// runner (main.ts) discounts the finished board, and the value model
// (lib/model.ts) discounts inside the bootstrap so the rank ranges
// are measured on the discounted board the reader actually sees.
// Both places call parentScale, so the two can never drift apart.
// A listed slug with no row on the board is simply ignored by the
// runner — it is not an error, and no dummy row is invented for it.

/**
 * The share of fitted value a parent product's line keeps: 48%.
 * Every discounted value is `max(1, round(v * 0.48))` — see
 * parentScale below — so a discounted line can never drop to zero.
 */
export const PARENT_FACTOR = 0.48;

/**
 * Slug → description of the line, exactly 20 entries, in the order
 * the v4 entry listed them. The description is what the dashboard
 * shows for the row; it describes the line (a perps desk, a vault
 * product, an exchange arm), not the parent company behind it.
 */
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

/**
 * Scale one fitted value by the parent factor.
 *
 * Multiplies by PARENT_FACTOR, rounds to the nearest whole dollar,
 * and floors at $1. The floor matters for tiny lines: without it a
 * small fitted value could round down to nothing, and a board row
 * with a $0 implied value would be nonsense.
 */
export function parentScale(v: number): number {
  return Math.max(1, Math.round(v * PARENT_FACTOR));
}
