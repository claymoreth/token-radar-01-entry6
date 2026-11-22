// radar-7 — entry runner (Node 22, standard library only).
//
// Reads the sealed snapshot, scores every pre-token protocol with the
// model in lib/model.ts, discounts the lines that belong to a parent
// product that already records a token, costs each row's farm plan,
// accounts every protocol in the snapshot, and writes the ranked board
// to the output directory:
//
//   board.json    the whole board: model, rows, multiples, evidence,
//                 accounting and integrity
//   data.js       the same board as `window.RADAR = ...;`, read by
//                 dashboard/index.html from ../data.js
//   dashboard/    a copy of this repository's dashboard/
//   screenshots/  a copy of this repository's screenshots/
//   dossier.json  buildDossier of the output directory, the summary
//                 the judge reads (written only once screenshots/
//                 holds at least one image)
//
// Run locally:
//
//   mkdir -p out && RADAR_INPUT=<snapshot.json> RADAR_OUTPUT=out node main.ts
//
// --input <file|dir> overrides RADAR_INPUT; --output <dir> overrides
// RADAR_OUTPUT. In the grader's container the defaults apply:
// /input/snapshot.json in, /output out (MAKEFUN_OUTPUT_DIR stands in
// for /output outside the container, as the kit's starter does).
//
// Deterministic: the same snapshot always yields the same bytes. No
// randomness anywhere in this file; the seeded PRNG lives in lib/.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoardModel, looRatioPredictor } from "./lib/model.ts";
import type { Board, BoardRow, Snapshot } from "./lib/model.ts";
import { addFarm } from "./lib/farm.ts";
import type { BoardRow as FarmRow, Snapshot as FarmSnapshot } from "./lib/farm.ts";
import { buildAccounting } from "./lib/accounting.ts";
import type { Accounting } from "./lib/accounting.ts";
import { buildIntegrity } from "./lib/integrity.ts";
import type { Integrity } from "./lib/integrity.ts";
import { PARENT_FACTOR, PARENT_PRODUCTS, parentScale } from "./lib/parent.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/** The scorer's own caps (reference/gate.json, as the kit's starter names them). */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };

// The parent-product list and factor live in lib/parent.ts — one home,
// shared with lib/model.ts (which needs the same factor when it
// re-ranks the board inside the bootstrap). See that file for the
// provenance note: the list is v4's, the claim is v4's assumption,
// matching is by exact slug only.

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

// ------------------------------------------------------------------ inputs

const inputArg = arg("input", process.env.RADAR_INPUT ?? "/input/snapshot.json");
const inputFile = inputArg.endsWith(".json") ? inputArg : join(inputArg, "snapshot.json");
if (!existsSync(inputFile)) {
  process.stderr.write(
    `radar-7: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or set RADAR_INPUT\n`,
  );
  process.exit(2);
}
const outDir = arg(
  "output",
  process.env.RADAR_OUTPUT ?? process.env.MAKEFUN_OUTPUT_DIR ?? "/output",
);

const snapshot = JSON.parse(readFileSync(inputFile, "utf8")) as Snapshot;
if (!Array.isArray(snapshot.protocols) || !Array.isArray(snapshot.watchlist)) {
  process.stderr.write(`radar-7: ${inputFile} is not a snapshot (no protocols/watchlist arrays)\n`);
  process.exit(2);
}

// ------------------------------------------------------------------ parent products

// A board row is a parent product's line when its slug is exactly one
// of PARENT_PRODUCTS (case-sensitive, slug match only — no substring or
// name matching). A line of a product that already has a token cannot
// launch a token of its own at full value, so it keeps PARENT_FACTOR of
// its fitted implied value, is marked off-list, and is labelled on the
// dashboard with the v4 description of the line. A listed slug with no
// row on the board is ignored (no error, no dummy row) and is listed in
// the run log as an audit trail. Every detection is listed in the run
// log, with its parent, so the rule can be audited.
function applyParentDiscount(
  rows: BoardRow[],
): {
  count: number;
  detected: { slug: string; name: string; parent: string }[];
  missing: string[];
} {
  const seen = new Set<string>();
  const detected: { slug: string; name: string; parent: string }[] = [];
  for (const row of rows) {
    if (!(row.slug in PARENT_PRODUCTS)) continue;
    seen.add(row.slug);
    // Discount the fitted value and every bound derived from it; the
    // launch value (TVL x multiple) is left alone, it is not a
    // function of the odds, and the dashboard shows the factor.
    // (parentScale lives in lib/parent.ts, shared with the bootstrap.)
    const scale = parentScale;
    row.parentFactor = PARENT_FACTOR;
    row.parentName = PARENT_PRODUCTS[row.slug]!;
    row.impliedValueUsd = scale(row.impliedValueUsd);
    row.p25 = scale(row.p25);
    row.p75 = scale(row.p75);
    row.p10 = scale(row.p10);
    row.p90 = scale(row.p90);
    row.bootstrapLow = scale(row.bootstrapLow);
    row.bootstrapHigh = scale(row.bootstrapHigh);
    detected.push({ slug: row.slug, name: row.name, parent: PARENT_PRODUCTS[row.slug]! });
  }
  const missing = Object.keys(PARENT_PRODUCTS).filter((slug) => !seen.has(slug));
  // The discount moves rows, so rank again from the discounted values:
  // sort by implied value, then TVL, then slug, and force the implied
  // values strictly decreasing (ties nudged down by $1, as the model
  // does) so no two rows share a rank or a value.
  rows.sort((a, b) => {
    if (b.impliedValueUsd !== a.impliedValueUsd) return b.impliedValueUsd - a.impliedValueUsd;
    if (b.tvlUsd !== a.tvlUsd) return b.tvlUsd - a.tvlUsd;
    return a.slug < b.slug ? -1 : 1;
  });
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].impliedValueUsd >= rows[i - 1].impliedValueUsd) {
      rows[i].impliedValueUsd = rows[i - 1].impliedValueUsd - 1;
    }
  }
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  return { count: detected.length, detected, missing };
}

// ------------------------------------------------------------------ build

const board = buildBoardModel(snapshot);
const parents = applyParentDiscount(board.rows);
// The farm stage gets the leave-one-out predictor so each peer's
// heldOut is a genuinely held-out model/actual figure.
addFarm(board.rows as FarmRow[], snapshot as FarmSnapshot, looRatioPredictor());
const accounting = buildAccounting(snapshot, board.rows);
const integrity = buildIntegrity(board.rows, snapshot);

interface BoardOut extends Board {
  floorUsd: number;
  accounting: Accounting;
  integrity: Integrity;
}
const out: BoardOut = {
  ...board,
  floorUsd: snapshot.floor_usd,
  accounting,
  integrity,
};
const json = JSON.stringify(out, null, 2);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "board.json"), `${json}\n`);
writeFileSync(join(outDir, "data.js"), `window.RADAR = ${json};\n`);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyFiles(join(here, "dashboard"), join(outDir, "dashboard"));
const shots = copyFiles(join(here, "screenshots"), join(outDir, "screenshots"));

// The dossier is written last: the scorer rebuilds it from this
// output directory and compares bytes. It needs at least one
// screenshot; before the screenshots are taken the run still writes
// board.json and data.js so the dashboard can be rendered.
let dossier = false;
if (shots.length === 0) {
  process.stderr.write(
    "radar-7: screenshots/ holds no image yet: board.json and data.js are written, dossier.json skipped until the screenshots are taken\n",
  );
} else {
  writeFileSync(
    join(outDir, "dossier.json"),
    buildDossier(outDir, {
      text_max_bytes: TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_CAPS,
      dashboard: DASHBOARD_CAPS,
    }),
  );
  dossier = true;
}

const rank1 = board.rows[0]!;
const watchlistCovered = board.rows.filter((r) => r.watchlist).length;
process.stdout.write(
  `radar-7: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.rows.length} rows (${watchlistCovered}/${snapshot.watchlist.length} watchlist), rank 1 ${rank1.name} ${rank1.impliedValueUsd}, ${parents.count} parent-product rows x0.48` +
    (parents.count > 0
      ? ` (${parents.detected.map((d) => `${d.name} <- ${d.parent}`).join("; ")})`
      : "") +
    (parents.missing.length > 0
      ? `; ${parents.missing.length} listed parent slugs not on the board (${parents.missing.join(", ")})`
      : "") +
    `\nradar-7: wrote ${join(outDir, "board.json")}, ${join(outDir, "data.js")}, ${join(outDir, "dashboard")} (${dashFiles.length} files), ${join(outDir, "screenshots")} (${shots.length} images)` +
    (dossier ? ` and ${join(outDir, "dossier.json")}` : " (no dossier.json yet)") +
    "\n",
);
