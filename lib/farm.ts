// radar-7 — lib/farm.ts
//
// Farm economics: what a real user would actually net from farming
// a pre-token protocol, after gas, after time, and against doing
// nothing.
//
// Each row's plan is sized at 0.02% of its TVL, clamped to
// $100–$10,000. The modelled drop is 7% of implied value — but only
// the share of it the farmer's deposit earns: the drop is split
// pro-rata by deposit over TVL, so a $10,000 deposit into a $2.7B
// protocol earns a few dollars, not a fortune. Fees are the plan's
// on-chain transactions at the mid-point gas price of the row's
// main chain, and time is the hands-on minutes of the ten steps.
//
// The verdict is a two-bar test. FARM clears BOTH benchmarks: the
// net beats a 12-week T-bill on the same deposit, AND the net per
// hour is at least $25. MARGINAL clears neither fully but still nets
// above zero. SKIP loses money (net ≤ 0). The row's implied value
// already prices in the chance the token ever trades, so the odds
// are NOT multiplied in a second time — doing so would double-count
// them and understate every farm.
//
// On the kit snapshot no row clears both bars: 0 FARM, 131
// MARGINAL, 67 SKIP. That is the honest consequence of the
// traded-token odds — lower odds, smaller drops — and the file does
// not flatter the numbers to change it. The deposit is the
// farmer's own capital at risk for the hold; it is never counted
// as a cost in the net, because it comes back (the drop and the
// gas are the only flows that do not).

/** One step of the ten-step farm plan. */
export interface FarmStep {
  n: number;
  title: string;
  text: string;
  cost: string;
  time: string;
}

/** One nearest priced peer, for the detail view. */
export interface FarmPeer {
  name: string;
  category: string;
  tvl: number;
  mcap: number;
  ratio: number;
  heldOut: number;
}

/**
 * A board row, this file's own copy of the shape lib/model.ts
 * builds. The field order matches model.ts's BoardRow, and the
 * verdict is narrowed to the three verdicts this file assigns.
 * `parentFactor` / `parentName` are optional here too: main.ts may
 * already have appended them before addFarm runs.
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
  factors: { multiple: number; size: number; category: number };
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
  farmPlan: FarmStep[];
  exitRule: string;
  peers: FarmPeer[];
  parentFactor?: number;
  parentName?: string;
}

/** One protocol from the snapshot, with its ten fields. */
export interface SnapshotProtocol {
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

/** A snapshot, as far as the farm stage cares about it. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The modelled airdrop is 7% of implied value. */
export const DROP_SHARE = 0.07;

/** The farm hold, in weeks. */
export const HORIZON_WEEKS = 12;

/** The plan size is 0.02% of TVL, clamped to this range. */
export const DEPOSIT_MIN = 100;
export const DEPOSIT_MAX = 10000;

/** The T-bill benchmark: 4% a year on the same deposit. */
export const TBILL_ANNUAL = 0.04;

/** The farmer's time is worth $25 an hour. */
export const HOURLY_BENCHMARK = 25;

// ------------------------------------------------------------------ gas

/**
 * Mid-point gas price per transaction, in dollars, by chain.
 * The mid-point is what the plan costs; the range string (see
 * gasRange) is what the plan shows the reader, so they can see the
 * spread the mid-point sits inside. Chains the table does not know
 * default to $1.25 — the generic mid-point — rather than to zero,
 * because an unknown chain still pays gas.
 */
const GAS_MID: Record<string, number> = {
  Ethereum: 11.5,
  Solana: 0.03,
  Base: 0.175,
  Arbitrum: 0.3,
  Binance: 0.2,
  BNB: 0.2,
  Avalanche: 0.4,
  Polygon: 0.055,
  Optimism: 0.175,
  Monad: 0.175,
  Plasma: 0.175,
  Hyperliquid: 0.175,
  "Hyperliquid L1": 0.175,
  "Robinhood Chain": 0.175,
  Unichain: 0.175,
};

/** The gas-price range string shown for each chain. */
const GAS_RANGE: Record<string, string> = {
  Ethereum: "$8-15",
  Solana: "$0.01-0.05",
  Base: "$0.05-0.30",
  Arbitrum: "$0.10-0.50",
  Binance: "$0.10-0.30",
  BNB: "$0.10-0.30",
  Avalanche: "$0.20-0.60",
  Polygon: "$0.01-0.10",
  Optimism: "$0.05-0.30",
  Monad: "$0.05-0.30",
  Plasma: "$0.05-0.30",
  Hyperliquid: "$0.05-0.30",
  "Hyperliquid L1": "$0.05-0.30",
  "Robinhood Chain": "$0.05-0.30",
  Unichain: "$0.05-0.30",
};

/**
 * Mid-point gas price for one transaction on a chain, in dollars.
 * "Binance" is the name the snapshot uses for BNB Chain; both
 * spellings map to the same price, and anything unlisted costs
 * $1.25.
 */
export function gasPerTx(chain: string): number {
  return GAS_MID[chain] ?? 1.25;
}

/** The gas-price range string for a chain; "$0.50-2" when unlisted. */
export function gasRange(chain: string): string {
  return GAS_RANGE[chain] ?? "$0.50-2";
}

// ------------------------------------------------------------------ money

/** Format a dollar amount with two decimals, e.g. "$11.50". */
function money(n: number): string {
  return "$" + n.toFixed(2);
}

/** Format a whole-dollar amount with thousands separators, e.g. "$2,750,000". */
function moneyInt(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** Round to two decimals (cents). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The plan deposit for a TVL: 0.02% of TVL, clamped to
 * [$100, $10,000], rounded to cents when it falls inside the clamp.
 * A $50M protocol sizes to exactly $10,000; anything bigger is
 * capped there, and anything under $500k floors at $100.
 */
export function planDeposit(tvlUsd: number): number {
  const sized = 0.0002 * tvlUsd;
  if (sized < DEPOSIT_MIN) return DEPOSIT_MIN;
  if (sized > DEPOSIT_MAX) return DEPOSIT_MAX;
  return Math.round(sized * 100) / 100;
}

/**
 * The 12-week T-bill return on a deposit at 4% a year:
 * deposit × 0.04 × (12 / 52). On $10,000 that is $92.31 — the bar
 * a farm's net has to beat before it can be called FARM.
 */
export function tbillFor(depositUsd: number): number {
  return depositUsd * TBILL_ANNUAL * (HORIZON_WEEKS / 52);
}

// ------------------------------------------------------------------ actions

/**
 * The core and follow-up move per category. The core is the one
 * thing the protocol exists for; the follow-up is a second,
 * different use of the same protocol a few weeks later, so the
 * account reads as a real user rather than a one-shot farmer.
 *
 * `{name}` and `{chain}` are placeholders filled at run time.
 * Categories the table does not know fall back to DEFAULT_ACTION.
 * These strings are output text — reproduce them exactly.
 */
type ActionPair = [string, string];

const ACTIONS: Record<string, ActionPair> = {
  Dexs: [
    "Swap a modest amount through {name} on {chain}, then place the same pair into a liquidity position so it starts earning trading fees.",
    "After two weeks, take half the liquidity back out, swap the proceeds through {name} again, and open a new position at a different size.",
  ],
  Lending: [
    "Deposit collateral into {name} on {chain} and borrow against it at well under half its value, keeping the position far from liquidation.",
    "Repay part of the loan, add a little more collateral, then borrow again at a smaller size so the account completes two full cycles.",
  ],
  Yield: [
    "Place the deposit into the biggest vault on {name} on {chain} and leave it compounding untouched for at least two weeks.",
    "Harvest the yield once, put the harvest straight back into the same vault, and keep the position open for the rest of the hold.",
  ],
  "Yield Aggregator": [
    "Place the deposit into the leading strategy on {name} on {chain} and let it run for three weeks without touching it.",
    "Collect the yield once, move the harvest into a second strategy on the same aggregator, and keep both running.",
  ],
  RWA: [
    "Mint the tokenised asset on {name} on {chain} with the deposit and hold it in the same wallet for the full hold period.",
    "Redeem a quarter of the position, then mint again at a different size so both directions of the primary market appear.",
  ],
  "Onchain Capital Allocator": [
    "Place the deposit into the flagship allocation vault on {name} on {chain} and leave the allocation untouched for a month.",
    "Read the vault's allocation report, move a small slice into a second vault on the same protocol, and compare the two.",
  ],
  "Risk Curators": [
    "Place the deposit into a curated vault on {name} on {chain} run by a curator with a public track record, after reading its risk note.",
    "Move a small slice to a second curator's vault after two weeks and keep both positions open.",
  ],
  Derivatives: [
    "Open a small position on {name} on {chain} with a stop-loss in place, sized so a bad week costs little, and close it within a week.",
    "Open a second, smaller position later in the hold and close it before the hold ends, so the account shows more than one trade.",
  ],
  CDP: [
    "Lock collateral in {name} on {chain} and mint its stablecoin against it at less than half the collateral's value.",
    "Spend the minted stablecoin somewhere low-risk, buy it back, and close the vault before the hold period ends.",
  ],
  "Basis Trading": [
    "Place the deposit into the basis vault on {name} on {chain} and hold it through at least one full funding cycle of two weeks.",
    "Withdraw a third of the position, wait a week, and put it back in, so the vault is used rather than just parked.",
  ],
  Chain: [
    "Bridge the deposit to {name} on its own chain and spend it on a real transaction in the chain's flagship app.",
    "Stake a small amount with a validator on {name}, then unstake and stake again once to show continued participation.",
  ],
  "Staking Pool": [
    "Stake the deposit in the pool on {name} on {chain} and leave it earning for the full hold period.",
    "Unstake a quarter after a month, then stake it again so the account shows two staking cycles.",
  ],
  "Liquid Staking": [
    "Stake the deposit through {name} on {chain} and hold the liquid staking token in the same wallet for the full hold period.",
    "Use a slice of the liquid staking token in a low-risk venue, then bring it back into the stake before the hold ends.",
  ],
  "Liquid Restaking": [
    "Restake the deposit through {name} on {chain} and keep the restaked position open for the full hold period.",
    "Move a slice to a second operator after two weeks and keep both delegations active.",
  ],
  "Liquidity Manager": [
    "Put a pair into a managed position on {name} on {chain} and let the manager rebalance it for two weeks.",
    "Withdraw half, open a fresh managed position with it, and compare how the two positions perform.",
  ],
  Restaking: [
    "Restake the deposit through {name} on {chain} and keep the position open for the full hold period.",
    "Delegate a slice to a second operator after two weeks and keep both delegations active.",
  ],
  CeDeFi: [
    "Place the deposit into the CeDeFi vault on {name} on {chain} and hold the position for the full hold period.",
    "Withdraw a quarter after a month and put it back in, so the vault is used more than once.",
  ],
  "Anchor BTC": [
    "Put BTC collateral into {name} on {chain} and mint against it at less than half the collateral's value.",
    "Pay back part of the minted amount after two weeks, then mint again at a smaller size.",
  ],
  "Leveraged Farming": [
    "Open a small leveraged farm on {name} on {chain} at under 2x leverage, with a planned exit inside two weeks.",
    "Close the farm, take the result, and open a second farm at half the size.",
  ],
  "Dual-Token Stablecoin": [
    "Mint the stablecoin on {name} on {chain} with the deposit and hold it in the same wallet for the full hold period.",
    "Swap a quarter of it for the paired token, then swap it back, so both sides of the peg show up.",
  ],
  "Decentralized BTC": [
    "Mint the BTC-backed token on {name} on {chain} and hold it for the full hold period.",
    "Redeem a quarter back to BTC after a month, then mint again at a smaller size.",
  ],
  "Interest Rate Derivatives": [
    "Open a small fixed-rate position on {name} on {chain} for a 30-day term and hold it to maturity.",
    "Open a second position at a different rate after two weeks and compare the two terms.",
  ],
  Indexes: [
    "Buy the index token on {name} on {chain} with the deposit and hold it for the full hold period.",
    "Sell a quarter after a month, then buy it back, so the index is used more than once.",
  ],
  Payments: [
    "Make three small real payments through {name} on {chain}, a week apart, to different recipients.",
    "Receive one payment back into the same wallet so the account shows flow in both directions.",
  ],
  "Prediction Market": [
    "Place three small bets on {name} on {chain} on markets that resolve on different dates, never more than $20 each.",
    "Claim the winnings of the first market that resolves and place one more bet with part of the proceeds.",
  ],
  Insurance: [
    "Buy a small cover policy on {name} on {chain} for a protocol you actually use, for a 30-day term.",
    "Renew the cover once it lapses, so the account shows two consecutive policies.",
  ],
  "Crypto Card Issuer": [
    "Order the card from {name} on {chain}, top it up with the deposit, and spend it on two real purchases.",
    "Top it up a second time after two weeks and make one more purchase with it.",
  ],
  Farm: [
    "Stake LP tokens in the farm on {name} on {chain} and collect the rewards after two weeks.",
    "Put the collected rewards straight back into the same farm and keep the position open through the hold.",
  ],
  Bridge: [
    "Bridge the deposit through {name} on {chain} to a chain you actually use, and use the bridged funds there.",
    "Bridge a slice back the other way after two weeks, so the account shows both directions of the bridge.",
  ],
  "Canonical Bridge": [
    "Bridge the deposit through {name} on {chain} to a chain you actually use, and use the bridged funds there.",
    "Bridge a slice back the other way after two weeks, so the account shows both directions of the bridge.",
  ],
  "Cross Chain Bridge": [
    "Bridge the deposit through {name} on {chain} to a chain you actually use, and use the bridged funds there.",
    "Bridge a slice back the other way after two weeks, so the account shows both directions of the bridge.",
  ],
  "Uncollateralized Lending": [
    "Borrow a small amount through {name} on {chain} at a size you could repay from cash, and repay it inside two weeks.",
    "Borrow once more at a smaller size after repaying, so the account shows two completed loans.",
  ],
  Launchpad: [
    "Join one sale on {name} on {chain} with a small allocation and hold what you receive for the full hold period.",
    "Join a second sale at a smaller size after two weeks and compare the two allocations.",
  ],
  Synthetics: [
    "Mint a small synthetic position on {name} on {chain} and hold it through one full week of price moves.",
    "Close the position, then open a second one at half the size and hold it to the end of the hold period.",
  ],
};

/** The fallback pair for categories the table does not know. */
const DEFAULT_ACTION: ActionPair = [
  "Use the flagship feature on {name} on {chain} with the deposit and keep the position open for at least two weeks.",
  "Use the same feature once more at a different size after two weeks, so the account shows continued use.",
];

// ------------------------------------------------------------------ counts

/**
 * How many on-chain calls the core step needs. Dexs, Lending and
 * CDP cores need 2 (trade + add liquidity, supply + borrow, lock +
 * mint); every other core is a single call.
 */
function coreTxCount(category: string): number {
  if (category === "Dexs" || category === "Lending" || category === "CDP") {
    return 2;
  }
  return 1;
}

/**
 * The whole plan's transaction count: FUND 1 + CORE coreTx +
 * DEEPEN 1 + CADENCE 1 + CLAIM 1. SETUP, VERIFY, RISK, WATCH and
 * RECORD are reads and writes off-chain, so they cost no gas.
 */
function planTxCount(row: BoardRow): number {
  return 4 + coreTxCount(row.category);
}

/** The plan's total gas bill, in dollars, rounded to cents. */
function feesFor(row: BoardRow): number {
  const chain = row.chains[0] ?? "Ethereum";
  return round2(planTxCount(row) * gasPerTx(chain));
}

/**
 * The farmer's share of the modelled drop: the drop share of
 * implied value, pro-rated by deposit over TVL, rounded to cents.
 * A protocol with no TVL pays no drop (and cannot be farmed for
 * one — the division is guarded).
 */
function dropFor(row: BoardRow, deposit: number, share: number): number {
  if (row.tvlUsd <= 0) return 0;
  return round2((row.impliedValueUsd * share * deposit) / row.tvlUsd);
}

// ------------------------------------------------------------------ plan

/** Fill the `{name}` and `{chain}` placeholders in an action template. */
function fill(template: string, name: string, chain: string): string {
  return template.split("{name}").join(name).split("{chain}").join(chain);
}

/**
 * Build the ten-step farm plan for one row.
 *
 * The steps are fixed in shape — SETUP, VERIFY, FUND, RISK, CORE,
 * DEEPEN, CADENCE, WATCH, RECORD, CLAIM — and only the numbers and
 * the two category actions vary: the deposit, the chain and its gas
 * price and range, the core/follow-up text, and the exit TVL (83%
 * of today's TVL, a -17% drawdown trigger). Each step carries its
 * cost string and its hands-on time string; the cost helper prices
 * a step by its transaction count, and a zero-transaction step says
 * so explicitly instead of quoting $0.00 unexplained.
 */
export function farmPlanFor(row: BoardRow): FarmStep[] {
  const chain = row.chains[0] ?? "Ethereum";
  const gas = gasPerTx(chain);
  const range = gasRange(chain);
  const deposit = planDeposit(row.tvlUsd);
  const coreTx = coreTxCount(row.category);
  const pair = ACTIONS[row.category] ?? DEFAULT_ACTION;
  const core = pair[0];
  const second = pair[1];
  const exitTvl = 0.83 * row.tvlUsd;

  function txCost(n: number): string {
    if (n === 0) {
      return "COST: $0.00 (no transaction — reading and checking only)";
    }
    const countText =
      n === 1 ? "one transaction" : n + " transactions";
    return `COST: ${money(n * gas)} (${countText} on ${chain} at ~${money(gas)} each, gas ${range} per tx)`;
  }

  return [
    {
      n: 1,
      title: "SETUP",
      text: `Open a fresh wallet used only for this farm, fund it on ${chain} with ${money(deposit)} plus gas, and connect it to ${row.name}. A wallet that has never touched another farm keeps the activity clean and easy to explain.`,
      cost: "COST: $0.00 (no transaction — wallet creation and funding are arranged off-chain before the first on-chain step)",
      time: "TIME: 10 min hands-on",
    },
    {
      n: 2,
      title: "VERIFY",
      text: `Check ${row.name} on DefiLlama and on its official site or docs, and match the contract address shown there against the one the app asks you to sign. Never open the app from a link in a DM or a search ad — type the address yourself.`,
      cost: "COST: $0.00 (no transaction — reading and checking only)",
      time: "TIME: 15 min hands-on",
    },
    {
      n: 3,
      title: "FUND",
      text: `Move ${money(deposit)} into the fresh wallet on ${chain} — one withdrawal from an exchange, or one bridge if the funds sit on another chain — and confirm the balance landed before doing anything else.`,
      cost: txCost(1),
      time: "TIME: 10 min hands-on",
    },
    {
      n: 4,
      title: "RISK",
      text: `Read the strategy and risk note for ${row.name} before depositing: what the position holds, what can be lost, and whether withdrawals can pause. If the note is missing or unreadable, stop here and keep the funds in the wallet.`,
      cost: "COST: $0.00 (no transaction — reading and checking only)",
      time: "TIME: 20 min hands-on",
    },
    {
      n: 5,
      title: "CORE",
      text: fill(core, row.name, chain),
      cost: txCost(coreTx),
      time: "TIME: 15 min hands-on",
    },
    {
      n: 6,
      title: "DEEPEN",
      text: fill(second, row.name, chain),
      cost: txCost(1),
      time: "TIME: 15 min hands-on",
    },
    {
      n: 7,
      title: "CADENCE",
      text: `Touch the position once a week for ${HORIZON_WEEKS} weeks: check the balance and the protocol's announcements, and make one real top-up or rebalance transaction halfway through. Weekly check-ins are free reads; only the mid-hold transaction pays gas.`,
      cost: txCost(1),
      time: "TIME: 60 min hands-on (5 min a week for 12 weeks)",
    },
    {
      n: 8,
      title: "WATCH",
      text: `Set the exit rule and keep it: withdraw if ${row.name} TVL prints below ${moneyInt(exitTvl)}, which is -17% from today's ${moneyInt(row.tvlUsd)}, or at once if withdrawals pause or the team says a snapshot has already been taken.`,
      cost: "COST: $0.00 (no transaction — monitoring only)",
      time: "TIME: 30 min hands-on (a few minutes a week for 12 weeks)",
    },
    {
      n: 9,
      title: "RECORD",
      text: "Keep a ledger of the farm: date, transaction hash, asset, and dollar value for every move, in one place. If a claim ever needs proof of activity, this ledger is the proof.",
      cost: "COST: $0.00 (no transaction — writing down what already happened)",
      time: "TIME: 15 min hands-on",
    },
    {
      n: 10,
      title: "CLAIM",
      text: `Watch for the claim window on ${row.name}'s official channels, check vesting or lockup terms first, and claim in one transaction. If you sell at all, sell only part of the claim on day one — the rest can wait for the price to find its level.`,
      cost: txCost(1),
      time: "TIME: 15 min hands-on",
    },
  ];
}

/**
 * The plan's total hands-on minutes: the first number matching
 * `TIME: <n> min` in each step's time string, summed. Step 7's
 * string matches 60 (not the 5 in its parenthesis) and step 8's
 * matches 30, so the total is 205 minutes for every row:
 * 10+15+10+20+15+15+60+30+15+15.
 */
function totalPlanMinutes(plan: FarmStep[]): number {
  let total = 0;
  for (const step of plan) {
    const match = /TIME: (\d+) min/.exec(step.time);
    if (match !== null) total += Number(match[1]);
  }
  return total;
}

/**
 * The six short farm steps shown on the board (the `farm_steps`
 * the gate checks: 3–12 strings, each 20–600 chars trimmed).
 *
 * They are a compressed retelling of the ten-step plan: setup,
 * core, deepen, hold, one-wallet discipline, and claim. The core
 * and deepen strings reuse the plan's own CORE and DEEPEN step
 * texts (plan steps 5 and 6, indices 4 and 5), so the short list
 * can never disagree with the full plan about what the farmer
 * actually does.
 */
export function farmStepsFor(row: BoardRow, plan: FarmStep[]): string[] {
  const chain = row.chains[0] ?? "Ethereum";
  const gas = gasPerTx(chain);
  const deposit = planDeposit(row.tvlUsd);
  const core = plan[4]?.text ?? "";
  const second = plan[5]?.text ?? "";
  return [
    `Set up a fresh wallet, fund it on ${chain} with ${money(deposit)} plus gas (${gasRange(chain)} per tx), and connect it to ${row.name}. COST: $0.00 to set up. TIME: 10 min hands-on.`,
    `${core} COST: ${money(coreTxCount(row.category) * gas)} on ${chain}. TIME: 15 min hands-on.`,
    `${second} COST: ${money(gas)} on ${chain}. TIME: 15 min hands-on.`,
    `Hold the position for ${HORIZON_WEEKS} weeks and touch it once a week, spreading activity across days so it reads as a real user. COST: ${money(gas)} for one mid-hold transaction. TIME: 60 min hands-on.`,
    "Do not split the farm across many wallets or copy identical transactions: one wallet, organic timing, and no scripted bursts. COST: $0.00. TIME: 0 min hands-on.",
    `At launch, watch for the claim window, check any vesting or lockup first, and sell only part of the claim on day one if you sell at all. COST: ${money(gas)} to claim. TIME: 15 min hands-on.`,
  ];
}

/**
 * The one-line exit rule: withdraw if TVL prints below 83% of
 * today's TVL (-17%), or at once if withdrawals pause, the team
 * announces a snapshot has already been taken, or the claim window
 * opens and the position no longer needs to sit there.
 */
export function exitRuleFor(row: BoardRow): string {
  const exitTvl = 0.83 * row.tvlUsd;
  return `Withdraw if ${row.name} TVL prints below ${moneyInt(exitTvl)}, which is -17% from today's ${moneyInt(row.tvlUsd)}. Also pull out at once if withdrawals pause, the team announces a snapshot has already been taken, or the claim window opens and the position no longer needs to sit there.`;
}

/**
 * The up to 8 nearest priced peers in the same category.
 *
 * A peer must be a different protocol, in exactly the same
 * category, with a positive market cap on a positive TVL. Peers are
 * scored by `|log(peer TVL / row TVL)|` — closeness in size, not in
 * name — sorted by that distance ascending (stable sort, so equal
 * distances keep snapshot order), and the first 8 are kept. Each
 * peer's ratio is rounded to 4 decimals; its heldOut is the
 * leave-one-out model prediction over its actual ratio when the
 * caller passes a predictor (rounded to 4 decimals too), and falls
 * back to the peer's own ratio when no predictor is given — which
 * is NOT a held-out number, and is only the no-predictor fallback.
 */
export function peersFor(
  row: BoardRow,
  snapshot: Snapshot,
  predict?: (peer: SnapshotProtocol) => number,
): FarmPeer[] {
  const scored: { peer: SnapshotProtocol; distance: number }[] = [];
  for (const p of snapshot.protocols) {
    if (p.slug === row.slug) continue;
    if (p.category !== row.category) continue;
    if (!(p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)) continue;
    const distance = Math.abs(Math.log(p.tvl_usd / row.tvlUsd));
    scored.push({ peer: p, distance });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, 8).map(({ peer }) => {
    const ratio = peer.mcap_usd! / peer.tvl_usd;
    const ratio4 = Math.round(ratio * 10000) / 10000;
    return {
      name: peer.name,
      category: peer.category,
      tvl: peer.tvl_usd,
      mcap: peer.mcap_usd,
      ratio: ratio4,
      heldOut:
        predict !== undefined
          ? Math.round(predict(peer) * 10000) / 10000
          : ratio4,
    };
  });
}

/**
 * Cost every row's farm and fill in its verdict, numbers, plan,
 * steps, exit rule and peers — in place, in row order.
 *
 * Per row: deposit from TVL, plan from the row, fees from the
 * plan's transactions, drop from the 7% share pro-rated by
 * deposit, net = drop − fees (cents), hours = plan minutes / 60
 * (cents), net per hour = net / hours (cents, 0 when there are no
 * hours to divide by), T-bill from the deposit. The verdict is
 * SKIP when the net is ≤ 0, FARM when the net beats the T-bill AND
 * the net per hour is at least $25, and MARGINAL otherwise — a
 * row that nets above zero but clears neither bar in full.
 */
export function addFarm(
  rows: BoardRow[],
  snapshot: Snapshot,
  predict?: (peer: SnapshotProtocol) => number,
): void {
  for (const row of rows) {
    const deposit = planDeposit(row.tvlUsd);
    const plan = farmPlanFor(row);
    const fees = feesFor(row);
    const drop = dropFor(row, deposit, DROP_SHARE);
    const net = round2(drop - fees);
    const hours = round2(totalPlanMinutes(plan) / 60);
    const netPerHour = hours > 0 ? round2(net / hours) : 0;
    const tbill = tbillFor(deposit);
    let verdict: "FARM" | "MARGINAL" | "SKIP";
    if (net <= 0) {
      verdict = "SKIP";
    } else if (net > tbill && netPerHour >= HOURLY_BENCHMARK) {
      verdict = "FARM";
    } else {
      verdict = "MARGINAL";
    }
    row.depositUsd = deposit;
    row.dropShare = DROP_SHARE;
    row.horizonWeeks = HORIZON_WEEKS;
    row.dropUsd = drop;
    row.feesUsd = fees;
    row.netFees = net;
    row.netPerHour = netPerHour;
    row.handsOnHours = hours;
    row.verdict = verdict;
    row.farmPlan = plan;
    row.farmSteps = farmStepsFor(row, plan);
    row.exitRule = exitRuleFor(row);
    row.peers = peersFor(row, snapshot, predict);
  }
}

/**
 * The net grid the dashboard renders from a row's own fields:
 * drop share × deposit, each cell the net (drop − fees) at that
 * share and deposit, rounded to cents. Shares are 3.5%, 7% and
 * 14%; deposits are $1,000, $3,000, $10,000 and $30,000. The fees
 * come from the row when it already has them, otherwise from the
 * plan's transaction count — main.ts does not call this function,
 * but the dashboard spec does, so the behaviour is kept exact.
 */
export function netMatrix(row: BoardRow): {
  shares: number[];
  deposits: number[];
  values: number[][];
} {
  const shares = [0.035, 0.07, 0.14];
  const deposits = [1000, 3000, 10000, 30000];
  const fees =
    row.feesUsd !== undefined && row.feesUsd !== null
      ? row.feesUsd
      : feesFor(row);
  const values = shares.map((share) =>
    deposits.map((deposit) => round2(dropFor(row, deposit, share) - fees)),
  );
  return { shares, deposits, values };
}
