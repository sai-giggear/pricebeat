// WooCommerce REST sync. Variable products are expanded into their
// variations, each tracked as its own product.
import { db, deleteMapping, nowStamp } from "./db";

export type WooProduct = {
  woo_id: number; name: string; sku: string | null; price: number;
  regular_price: number | null; brand: string | null; category: string | null;
  permalink: string | null;
};

type Row = Record<string, any>;

// Woo returns taxonomy names HTML-encoded ("Bags &amp; Cases").
// ponytail: common named entities only; numeric ones are all handled.
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  hellip: "…", trade: "™", reg: "®", copy: "©" };
export const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : NAMED[e.toLowerCase()] ?? whole);

const firstName = (items: unknown) =>
  Array.isArray(items) && items[0]?.name ? unescape(items[0].name) : null;

const decimal = (raw: unknown) => {
  const s = String(raw ?? "").trim();
  const n = Number(s);
  return s && Number.isFinite(n) ? n : null;
};

function build(row: Row, brand: string | null, category: string | null,
               parent?: Row, nameOverride?: string): WooProduct | null {
  const price = decimal(row.price);
  if (price == null) return null; // no active price, nothing to track
  // Keep regular_price only when it's a genuine markdown.
  const regular = decimal(row.regular_price);
  return {
    woo_id: Number(row.id),
    name: unescape(nameOverride ?? row.name ?? ""),
    sku: row.sku || parent?.sku || null,
    price,
    regular_price: regular != null && regular > price ? regular : null,
    brand, category,
    permalink: row.permalink || parent?.permalink || null,
  };
}

export async function fetchProducts(baseUrl: string, key: string, secret: string,
                                    fetcher: typeof fetch = fetch): Promise<WooProduct[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const auth = "Basic " + btoa(`${key}:${secret}`);
  async function pages(path: string): Promise<Row[]> {
    const all: Row[] = [];
    for (let page = 1; ; page++) {
      const resp = await fetcher(`${base}/wp-json/wc/v3/${path}?per_page=100&page=${page}`,
        { headers: { Authorization: auth }, signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${base}`);
      const rows = (await resp.json()) as Row[];
      if (!Array.isArray(rows) || !rows.length) return all;
      all.push(...rows);
    }
  }
  const out: WooProduct[] = [];
  for (const r of await pages("products")) {
    const brand = firstName(r.brands), category = firstName(r.categories);
    if (r.type === "variable" && r.variations?.length) {
      for (const v of await pages(`products/${r.id}/variations`)) {
        const attrs = (v.attributes ?? []).map((a: Row) => a.option).filter(Boolean).join(", ");
        const p = build(v, brand, category, r, attrs ? `${r.name} - ${attrs}` : r.name);
        if (p) out.push(p);
      }
    } else {
      const p = build(r, brand, category);
      if (p) out.push(p);
    }
  }
  return out;
}

/** Upsert the fetched catalogue, then delete products no longer in the feed
 *  (with their mappings and history). Only called after a complete fetch, so a
 *  network failure part-way can never wipe the catalogue. */
export function applySync(products: WooProduct[]): { synced: number; removed: number } {
  const stamp = nowStamp();
  const seen = new Set<number>();
  let removed = 0;
  db.transaction(() => {
    const find = db.query<{ id: number }, [number]>("SELECT id FROM product WHERE woo_id = ?");
    for (const p of products) {
      seen.add(p.woo_id);
      const values = [p.name, p.sku, p.price, p.regular_price, p.brand, p.category, p.permalink, stamp];
      const existing = find.get(p.woo_id);
      if (existing) {
        db.query(`UPDATE product SET name=?, sku=?, own_price=?, regular_price=?, brand=?,
                  category=?, permalink=?, updated_at=? WHERE id=?`).run(...values, existing.id);
      } else {
        db.query(`INSERT INTO product (name, sku, own_price, regular_price, brand, category,
                  permalink, updated_at, woo_id) VALUES (?,?,?,?,?,?,?,?,?)`).run(...values, p.woo_id);
      }
    }
    if (!seen.size) return;
    for (const { id, woo_id } of db.query<{ id: number; woo_id: number }, []>(
        "SELECT id, woo_id FROM product").all()) {
      if (seen.has(woo_id)) continue;
      for (const m of db.query<{ id: number }, [number]>(
          "SELECT id FROM mapping WHERE product_id = ?").all(id)) deleteMapping(m.id);
      db.query("DELETE FROM product WHERE id = ?").run(id);
      removed++;
    }
  })();
  return { synced: seen.size, removed };
}
