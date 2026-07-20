// Small display helpers shared by the product pages.
// Prices arrive from the API as decimal strings ("129.00") or null.

export const num = (s: string | null | undefined): number | null => {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** "$129.00" — bare em-dash when the price is missing. */
export const money = (s: string | null | undefined): string => {
  const n = num(s);
  return n == null ? "—" : `$${n.toFixed(2)}`;
};

/** Round to one decimal, dropping a trailing .0 ("5.7", "6"). */
export const pct1 = (n: number): string => String(Math.round(n * 10) / 10);

/** How far your price sits above the cheapest rival, in percent (1 decimal).
 *  Positive = you're more expensive; 0/negative = at or below. */
export const gapPct = (own: string | null, lowest: string | null): string | null => {
  const o = num(own);
  const l = num(lowest);
  if (o == null || l == null || l === 0) return null;
  return pct1(((o - l) / l) * 100);
};

/** Render a stored timestamp in the viewer's local timezone + locale format.
 *  Backend timestamps are UTC but serialized without an offset, so we mark them
 *  UTC before parsing — otherwise the browser would assume they're local. */
export const dateTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const d = new Date(hasTz ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
};

/** "3h ago" / "2d ago" — compact freshness for last-checked stamps. */
export const timeAgo = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const d = new Date(hasTz ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return null;
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (60 * 24))}d ago`;
};

/** Percent your current price is marked down from its regular/RRP price. */
export const discountPct = (regular: string | null, own: string | null): number | null => {
  const r = num(regular);
  const o = num(own);
  if (r == null || o == null || r <= 0 || o >= r) return null;
  return Math.round(((r - o) / r) * 100);
};

/** How far a rival's price sits below your regular/RRP price, as a percent. */
export const belowRegularPct = (regular: string | null, rival: string | null): number | null => {
  const r = num(regular);
  const v = num(rival);
  if (r == null || v == null || r <= 0 || v >= r) return null;
  return Math.round(((r - v) / r) * 100);
};
