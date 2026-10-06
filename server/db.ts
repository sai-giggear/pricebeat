// SQLite storage. The schema matches PriceBeat 1.x exactly, so an existing
// price_tracker.db opens as-is with no migration step.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { settings } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS product (
  id INTEGER PRIMARY KEY, woo_id INTEGER NOT NULL, name VARCHAR NOT NULL,
  sku VARCHAR, own_price NUMERIC(12, 2) NOT NULL, regular_price NUMERIC(12, 2),
  brand VARCHAR, category VARCHAR, permalink VARCHAR, updated_at DATETIME NOT NULL);
CREATE INDEX IF NOT EXISTS ix_product_woo_id ON product (woo_id);
CREATE TABLE IF NOT EXISTS competitor (
  id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, config VARCHAR NOT NULL,
  site_url VARCHAR, favicon_url VARCHAR);
CREATE TABLE IF NOT EXISTS appsettings (
  id INTEGER PRIMARY KEY, "key" VARCHAR NOT NULL, value VARCHAR NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ix_appsettings_key ON appsettings ("key");
CREATE TABLE IF NOT EXISTS mapping (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES product (id),
  competitor_id INTEGER NOT NULL REFERENCES competitor (id),
  identifier VARCHAR NOT NULL, title VARCHAR, brand VARCHAR, sku VARCHAR,
  gtin VARCHAR, mpn VARCHAR, match_status VARCHAR, created_at DATETIME,
  last_checked_at DATETIME, check_interval_hours FLOAT NOT NULL DEFAULT 24.0);
CREATE INDEX IF NOT EXISTS ix_mapping_product_id ON mapping (product_id);
CREATE INDEX IF NOT EXISTS ix_mapping_competitor_id ON mapping (competitor_id);
CREATE TABLE IF NOT EXISTS pricesnapshot (
  id INTEGER PRIMARY KEY, mapping_id INTEGER NOT NULL REFERENCES mapping (id),
  price NUMERIC(12, 2), currency VARCHAR NOT NULL, in_stock BOOLEAN NOT NULL,
  fetched_at DATETIME NOT NULL, status VARCHAR NOT NULL, error_reason VARCHAR,
  shipping NUMERIC(12, 2), stock_status VARCHAR, condition VARCHAR);
CREATE INDEX IF NOT EXISTS ix_pricesnapshot_mapping_fetched ON pricesnapshot (mapping_id, fetched_at);
`;

export type Product = {
  id: number; woo_id: number; name: string; sku: string | null;
  own_price: number; regular_price: number | null; brand: string | null;
  category: string | null; permalink: string | null; updated_at: string;
};
export type Competitor = {
  id: number; name: string; config: string;
  site_url: string | null; favicon_url: string | null;
};
export type Mapping = {
  id: number; product_id: number; competitor_id: number; identifier: string;
  title: string | null; brand: string | null; sku: string | null;
  gtin: string | null; mpn: string | null; match_status: string | null;
  created_at: string | null; last_checked_at: string | null;
  check_interval_hours: number;
};
export type Snapshot = {
  id: number; mapping_id: number; price: number | null; currency: string;
  in_stock: number; fetched_at: string; status: string;
  error_reason: string | null; shipping: number | null;
  stock_status: string | null; condition: string | null;
};

export let db: Database;

export function openDb(path = settings.databasePath): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/** Timestamps are stored the way 1.x stored them: naive UTC,
 *  "2026-07-20 05:24:26.086". They sort as strings and SQLite reads them. */
export const nowStamp = (d = new Date()) => d.toISOString().replace("T", " ").replace("Z", "");

/** Stored stamp to an ISO string the browser can parse, or null. */
export const iso = (stamp: string | null) => (stamp ? stamp.replace(" ", "T") + "Z" : null);

export const stampMs = (stamp: string) => Date.parse(stamp.replace(" ", "T") + "Z");

export function getSetting(key: string, fallback = ""): string {
  const row = db.query<{ value: string }, [string]>(
    `SELECT value FROM appsettings WHERE "key" = ?`).get(key);
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.query(`INSERT INTO appsettings ("key", value) VALUES (?, ?)
            ON CONFLICT ("key") DO UPDATE SET value = excluded.value`).run(key, value);
}

export const jsonSetting = <T>(key: string, fallback: T): T => {
  try { return JSON.parse(getSetting(key) || "null") ?? fallback; } catch { return fallback; }
};

export function deleteMapping(id: number): void {
  db.query("DELETE FROM pricesnapshot WHERE mapping_id = ?").run(id);
  db.query("DELETE FROM mapping WHERE id = ?").run(id);
}

/** Every product's current competitor prices (newest ok snapshot per
 *  mapping) in one query. */
export function latestPrices(productIds?: number[]): Map<number, { name: string; price: number }[]> {
  const rows = db.query<{ product_id: number; name: string; price: number }, []>(`
    WITH ranked AS (
      SELECT mapping_id, price, ROW_NUMBER() OVER (
        PARTITION BY mapping_id ORDER BY fetched_at DESC, id DESC) AS rn
      FROM pricesnapshot WHERE status = 'ok' AND price IS NOT NULL)
    SELECT m.product_id, c.name, r.price FROM ranked r
    JOIN mapping m ON m.id = r.mapping_id
    JOIN competitor c ON c.id = m.competitor_id
    WHERE r.rn = 1`).all();
  const wanted = productIds && new Set(productIds);
  const out = new Map<number, { name: string; price: number }[]>();
  for (const r of rows) {
    if (wanted && !wanted.has(r.product_id)) continue;
    if (!out.has(r.product_id)) out.set(r.product_id, []);
    out.get(r.product_id)!.push({ name: r.name, price: r.price });
  }
  return out;
}

/** Products the user chose to track: brand/category pool, then optional
 *  product-level narrowing. Empty selection means everything. Products in
 *  track_excluded ("stopped") are always left out, whatever else is picked. */
export function activeProducts(products: Product[]): Product[] {
  const brands = new Set(jsonSetting<string[]>("track_brands", []));
  const cats = new Set(jsonSetting<string[]>("track_categories", []));
  const ids = new Set(jsonSetting<number[]>("track_products", []));
  const stopped = new Set(jsonSetting<number[]>("track_excluded", []));
  return products.filter((p) => !stopped.has(p.id) &&
    (!brands.size || brands.has(p.brand ?? "")) &&
    (!cats.size || cats.has(p.category ?? "")) &&
    (!ids.size || ids.has(p.id)));
}
