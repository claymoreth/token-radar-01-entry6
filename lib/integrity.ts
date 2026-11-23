// radar-7 — lib/integrity.ts
//
// Proves the board on screen is the board that was computed.
//
// The dashboard recomputes these checks in the browser from the data
// file itself, so a reader can tell whether the rows they are looking
// at are the rows the model produced. The checksum is a 32-bit
// FNV-1a hash over one line per ranked row — `slug|rank|impliedValue`
// — joined with newlines and no trailing newline. The ledger counts
// say how many of the watchlist names the board actually covers and
// how many protocols the snapshot held in total.
//
// Note the naming trap in this file: its `fnv1a` is NOT the one in
// lib/range.ts. The range version hashes UTF-16 code units and
// returns a number (it seeds the model); this one encodes the string
// to UTF-8 bytes first and returns an 8-digit lowercase hex string.
// Both are FNV-1a, both start from the same offset basis, and they
// give different answers for the same input — keep both, and do not
// "simplify" them into one. (For pure-ASCII input the two agree on
// the byte sequence, since ASCII code units and UTF-8 bytes coincide;
// the difference only shows for non-ASCII text, but the return
// types alone — number versus hex string — already forbid merging.)

/** One ranked row, as far as the checksum cares about it. */
export interface IntegrityRow {
  slug: string;
  rank: number;
  impliedValueUsd: number;
  watchlist?: boolean;
}

/**
 * A snapshot, as far as integrity cares about it: only the size of
 * the protocol list matters (the ledger total), and the watchlist
 * itself (how many names the board was supposed to cover). The
 * contents of `protocols` are never read.
 */
export interface IntegritySnapshot {
  protocols: unknown[];
  watchlist: string[];
}

/** The integrity block that ships inside board.json. */
export interface Integrity {
  checksum: string;
  totalImplied: number;
  watchlistCovered: number;
  watchlistTotal: number;
  ledgerTotal: number;
  rows: number;
}

/**
 * 32-bit FNV-1a hash of a string, as 8 lowercase hex digits.
 *
 * The string is encoded to UTF-8 bytes first (TextEncoder), then
 * each byte is XOR-ed into the running hash and the hash is
 * multiplied by the FNV prime with 32-bit integer multiplication,
 * keeping the result unsigned after every step. The hex is padded
 * on the left with zeroes to a full 8 digits.
 *
 * Check values, for a quick sanity test: the empty string hashes
 * to "811c9dc5" (the untouched offset basis), and "a" hashes to
 * "e40c292c".
 */
export function fnv1a(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash = hash ^ bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The exact string the checksum is taken over.
 *
 * The rows are copied and sorted by rank ascending — the checksum
 * must not depend on the order the caller happened to pass the rows
 * in — and each row becomes one line, `slug|rank|impliedValueUsd`,
 * with the implied value written in JavaScript's default
 * number-to-string form (no rounding, no formatting). The lines are
 * joined with "\n" and there is deliberately NO trailing newline:
 * adding one would change the hash.
 */
export function checksumInput(rows: IntegrityRow[]): string {
  const ordered = [...rows].sort((a, b) => a.rank - b.rank);
  return ordered
    .map((row) => `${row.slug}|${row.rank}|${row.impliedValueUsd}`)
    .join("\n");
}

/**
 * Build the integrity block for a finished board.
 *
 * Counts how many of the board's rows carry a watchlist slug, sums
 * every row's implied value (rounded to cents — the sum of whole
 * dollars is already exact, so this is a no-op in practice, kept
 * for the stated contract), and hashes the ranked rows. The
 * returned object is keyed checksum, totalImplied, watchlistCovered,
 * watchlistTotal, ledgerTotal, rows, in that order.
 */
export function buildIntegrity(
  rows: IntegrityRow[],
  snapshot: IntegritySnapshot,
): Integrity {
  const watchlist = new Set(snapshot.watchlist);
  let covered = 0;
  for (const row of rows) {
    if (watchlist.has(row.slug)) covered += 1;
  }
  let total = 0;
  for (const row of rows) {
    total += row.impliedValueUsd;
  }
  return {
    checksum: fnv1a(checksumInput(rows)),
    totalImplied: Math.round(total * 100) / 100,
    watchlistCovered: covered,
    watchlistTotal: snapshot.watchlist.length,
    ledgerTotal: snapshot.protocols.length,
    rows: rows.length,
  };
}
