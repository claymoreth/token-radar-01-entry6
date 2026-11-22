// radar-7 integrity: a checksum plus a few counts so the dashboard
// (and any reader) can prove the board on screen is the board that
// was computed — same rows, same order, same implied values, no
// silent edit in between.
//
// Checksum input, exactly: rows sorted by rank ascending, one line
// per row, "slug|rank|impliedValueUsd", lines joined with "\n" and no
// trailing newline. impliedValueUsd is written with JavaScript's
// default number-to-string form (the same text String(value)
// produces). Change one character of one row and the checksum moves.
//
// The hash is FNV-1a 32-bit, the same algorithm in every language:
//   hash = 0x811c9dc5
//   for each UTF-8 byte b of the string: hash = hash XOR b,
//   then hash = hash * 0x01000193 (mod 2^32)
//   result: hash as 8 lowercase hex digits, zero-padded.
// fnv1a("") is "811c9dc5", fnv1a("a") is "e40c292c".
//
// Note the two FNV-1a helpers in this entry on purpose: lib/range.ts
// returns a NUMBER for seeding, this file returns a hex STRING for
// the checksum. Different contracts, both kept — do not merge them.

export interface IntegrityRow {
  slug: string;
  rank: number;
  impliedValueUsd: number;
  watchlist?: boolean;
}

export interface IntegritySnapshot {
  protocols: unknown[];
  watchlist: string[];
}

export interface Integrity {
  checksum: string;
  totalImplied: number;
  watchlistCovered: number;
  watchlistTotal: number;
  ledgerTotal: number;
  rows: number;
}

export function fnv1a(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let hash = 0x811c9dc5;
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function checksumInput(rows: IntegrityRow[]): string {
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  return sorted.map((r) => `${r.slug}|${r.rank}|${r.impliedValueUsd}`).join("\n");
}

export function buildIntegrity(rows: IntegrityRow[], snapshot: IntegritySnapshot): Integrity {
  const watchlist = new Set(snapshot.watchlist);
  let covered = 0;
  for (const r of rows) if (watchlist.has(r.slug)) covered += 1;
  const total = rows.reduce((sum, r) => sum + r.impliedValueUsd, 0);
  return {
    checksum: fnv1a(checksumInput(rows)),
    totalImplied: Math.round(total * 100) / 100,
    watchlistCovered: covered,
    watchlistTotal: snapshot.watchlist.length,
    ledgerTotal: snapshot.protocols.length,
    rows: rows.length,
  };
}
