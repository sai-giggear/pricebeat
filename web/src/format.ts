// Display helpers. Prices arrive as decimal strings ("129.00") or null.

export const num = (s: string | null | undefined): number | null => {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const fmt = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", currencyDisplay: "narrowSymbol" });

/** "$1,299.00", or an em-dash placeholder when missing. */
export const money = (s: string | null | undefined): string => {
  const n = num(s);
  return n == null ? "—" : fmt.format(n);
};

/** One decimal, trailing .0 dropped: "5.7", "6". */
export const pct1 = (n: number) => String(Math.round(n * 10) / 10);

/** How far `a` sits above `b`, in percent. */
export const gapPct = (a: string | null, b: string | null): number | null => {
  const x = num(a), y = num(b);
  return x == null || y == null || y === 0 ? null : ((x - y) / y) * 100;
};

/** Percent `price` is below `regular` (a markdown), when it is. */
export const offPct = (regular: string | null, price: string | null): number | null => {
  const r = num(regular), p = num(price);
  return r == null || p == null || r <= 0 || p >= r ? null : Math.round(((r - p) / r) * 100);
};

export const timeAgo = (iso: string | null): string | null => {
  if (!iso) return null;
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (!Number.isFinite(mins)) return null;
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

export const shortDate = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export const dateTime = (t: number) =>
  new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
