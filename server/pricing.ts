// Pure pricing logic: reading prices from text, judging a listing against our
// product, and deciding where we stand. No I/O, so it's all unit-tested.

/** First price-looking number in a string. "1,234.56" and "1500" match whole. */
export function parsePrice(text: string | null | undefined): number | null {
  const m = (text ?? "").replace(/ /g, " ").match(/\d[\d,]*\.\d+|\d[\d,]*/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Round to cents, half up. Money is compared and computed in integer cents
 *  so float noise never shows up as $840.5099999. */
export const cents = (v: number) => Math.round(v * 100);
export const money = (v: number | null | undefined) =>
  v == null ? null : (cents(v) / 100).toFixed(2);

export type Analysis = {
  lowest_price: number | null;
  lowest_seller: string;
  gap_to_lowest: number | null;
  is_lowest: boolean;
  suggested_price: number | null;
};

/** Undercut the cheapest rival by this percent when we're beaten. */
export const UNDERCUT_PERCENT = 1;

export function analyze(own: number, rivals: { name: string; price: number }[]): Analysis {
  if (!rivals.length) {
    return { lowest_price: null, lowest_seller: "you", gap_to_lowest: null,
             is_lowest: true, suggested_price: null };
  }
  const winner = rivals.reduce((a, b) => (b.price < a.price ? b : a));
  if (cents(own) <= cents(winner.price)) {
    return { lowest_price: own, lowest_seller: "you", gap_to_lowest: 0,
             is_lowest: true, suggested_price: null };
  }
  const target = Math.round((cents(winner.price) * (100 - UNDERCUT_PERCENT)) / 100);
  return {
    lowest_price: winner.price,
    lowest_seller: winner.name,
    gap_to_lowest: (cents(own) - cents(winner.price)) / 100,
    is_lowest: false,
    suggested_price: Math.max(target, 1) / 100,
  };
}

// ---- Match verification ---------------------------------------------------
// Identifier first: the seller's GTIN/MPN/SKU equal to our SKU is proof.
// Otherwise compare titles, where model codes ("sm-s948b", "fp-e50") are the
// strongest signal. Weak overlap is flagged for review, so a wrong link gets
// caught instead of silently driving a bad suggestion.

export type MatchStatus = "verified" | "likely" | "review";

const STOP = new Set(["the", "a", "an", "and", "with", "for", "of", "in", "to", "by", "new"]);
const normId = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
const tokens = (t: string) =>
  new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)));
const codes = (s: Set<string>) => new Set([...s].filter((t) => /\d/.test(t)));

/** null means nothing to judge with (no identifiers and no title). */
export function matchStatus(
  productName: string, productSku: string | null,
  offerIds: (string | null | undefined)[], offerTitle: string | null | undefined,
): MatchStatus | null {
  const ids = new Set(offerIds.filter(Boolean).map((i) => normId(i!)));
  if (productSku && ids.has(normId(productSku))) return "verified";
  if (!offerTitle) return null;
  const ours = tokens(productName);
  const theirs = tokens(offerTitle);
  if (!ours.size) return null;
  const ourCodes = codes(ours);
  const sharedCodes = [...codes(theirs)].filter((c) => ourCodes.has(c)).length;
  // Disjoint model codes are the classic wrong-variant mistake.
  if (ourCodes.size && codes(theirs).size && !sharedCodes) return "review";
  const overlap = [...ours].filter((t) => theirs.has(t)).length / ours.size;
  return overlap >= 0.45 || sharedCodes ? "likely" : "review";
}

/** "v1.2.0" beats "1.1.9". Unparseable tags never count as newer. */
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) => (v.trim().match(/^v?(\d+(?:\.\d+)*)/)?.[1] ?? "").split(".").filter(Boolean).map(Number);
  const a = parts(latest), b = parts(current);
  if (!a.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d > 0;
  }
  return false;
}
