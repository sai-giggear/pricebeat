import { beforeEach, expect, test } from "bun:test";
process.env.SCRAPE_DELAY_SECONDS = "0.05";
const { openDb, setSetting } = await import("../server/db");
let db: import("bun:sqlite").Database;
const { pruneSnapshots, runTracking } = await import("../server/engine");
const { routes } = await import("../server/api");
const { applySync } = await import("../server/woo");
import type { PriceResult } from "../server/scrape";

const ok = (price: number, extra: Partial<PriceResult> = {}): PriceResult =>
  ({ price, currency: "AUD", in_stock: true, status: "ok", ...extra });

function seed() {
  db = openDb(":memory:");
  applySync([
    { woo_id: 1, name: "Pelican 1510 Case", sku: "1510", price: 300, regular_price: 350, brand: "Pelican", category: "Cases", permalink: null },
    { woo_id: 2, name: "Nebo Torch", sku: "N1", price: 50, regular_price: null, brand: "Nebo", category: "Lights", permalink: null },
  ]);
  db.exec(`INSERT INTO competitor (id, name, config, site_url) VALUES
    (1, 'A', '{"source":"auto"}', 'https://a.com'), (2, 'B', '{"source":"auto"}', 'https://b.com');
    INSERT INTO mapping (id, product_id, competitor_id, identifier, check_interval_hours) VALUES
    (1, 1, 1, 'https://a.com/1510', 24), (2, 1, 2, 'https://b.com/1510', 24), (3, 2, 1, 'https://a.com/n1', 24);`);
}
beforeEach(seed);

const call = async (path: string, method: string, params: Record<string, string> = {}, body?: unknown) => {
  const req = Object.assign(new Request("http://x" + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }), { params });
  return (routes as any)[path][method](req);
};

test("run records snapshots, stamps offer data, verifies match", async () => {
  const summary = await runTracking({ fetcher: async (url) =>
    url.includes("a.com/1510") ? ok(280, { title: "Pelican 1510", sku: "1510" }) : ok(310) });
  expect(summary).toEqual({ products: 2, snapshots: 3, failures: 0 });
  const m1 = db.query("SELECT * FROM mapping WHERE id = 1").get() as any;
  expect(m1).toMatchObject({ title: "Pelican 1510", match_status: "verified" });
  expect(m1.last_checked_at).toBeTruthy();

  const rows = await call("/api/products", "GET");
  expect(rows.find((r: any) => r.id === 1)).toMatchObject({
    lowest_price: "280.00", lowest_seller: "A", is_lowest: false, gap_to_lowest: "20.00", suggested_price: "277.20", rivals: 2 });
});

test("interval halves when the price moves, grows when stable, due-only skips fresh", async () => {
  let price = 100;
  const fetcher = async () => ok(price);
  await runTracking({ mappingIds: [1], fetcher });
  await runTracking({ mappingIds: [1], fetcher });
  const interval = () => (db.query("SELECT check_interval_hours h FROM mapping WHERE id = 1").get() as any).h;
  expect(interval()).toBe(36);
  price = 90;
  await runTracking({ mappingIds: [1], fetcher });
  expect(interval()).toBe(18);
  expect((await runTracking({ dueOnly: true, fetcher })).snapshots).toBe(2); // 1 was just checked
});

test("a failing source is isolated and counted", async () => {
  const summary = await runTracking({ fetcher: async (url) => { if (url.includes("b.com")) throw new Error("boom"); return ok(1); } });
  expect(summary).toMatchObject({ snapshots: 3, failures: 1 });
  expect(db.query("SELECT error_reason FROM pricesnapshot WHERE mapping_id = 2").get()).toEqual({ error_reason: "boom" });
});

test("hosts run in parallel, same-host requests are spaced", async () => {
  const started: [string, number][] = [];
  const t0 = performance.now();
  await runTracking({ fetcher: async (url) => { started.push([new URL(url).host, performance.now() - t0]); return ok(1); } });
  const a = started.filter(([h]) => h === "a.com").map(([, t]) => t);
  const b = started.find(([h]) => h === "b.com")![1];
  expect(a[1] - a[0]).toBeGreaterThanOrEqual(45);
  expect(b).toBeLessThan(40);
});

test("bulk runs respect the tracking filter", async () => {
  setSetting("track_brands", JSON.stringify(["Nebo"]));
  expect(await runTracking({ fetcher: async () => ok(1) })).toMatchObject({ products: 1, snapshots: 1 });
});

test("prune keeps the newest and newest-ok snapshot per mapping", () => {
  db.exec(`INSERT INTO pricesnapshot (mapping_id, price, currency, in_stock, fetched_at, status) VALUES
    (1, 10, 'AUD', 1, '2020-01-01 00:00:00', 'ok'), (1, 11, 'AUD', 1, '2020-01-02 00:00:00', 'ok'),
    (1, NULL, 'AUD', 0, '2020-01-03 00:00:00', 'failed'), (2, 5, 'AUD', 1, '2020-01-01 00:00:00', 'ok')`);
  expect(pruneSnapshots(30)).toBe(1);
  expect(pruneSnapshots(0)).toBe(0);
});

test("sync upserts and removes products gone from the feed", () => {
  db.exec(`INSERT INTO pricesnapshot (mapping_id, price, currency, in_stock, fetched_at, status) VALUES (3, 1, 'AUD', 1, '2026-01-01 00:00:00', 'ok')`);
  expect(applySync([{ woo_id: 1, name: "Renamed", sku: "1510", price: 299, regular_price: null, brand: null, category: null, permalink: null }]))
    .toEqual({ synced: 1, removed: 1 });
  expect(db.query("SELECT name, own_price FROM product").all()).toEqual([{ name: "Renamed", own_price: 299 }]);
  expect(db.query("SELECT COUNT(*) n FROM pricesnapshot WHERE mapping_id = 3").get()).toEqual({ n: 0 });
});

test("API: detail, reassign, delete, reset, settings never leak secrets", async () => {
  await runTracking({ fetcher: async () => ok(42) });
  const d = await call("/api/products/:id", "GET", { id: "1" });
  expect(d.mappings).toHaveLength(2);
  expect(d.mappings[0]).toMatchObject({ price: "42.00", in_stock: true, history: [{ price: "42.00", status: "ok" }] });
  await expect(call("/api/products/:id", "GET", { id: "99" })).rejects.toMatchObject({ status: 404 });

  await call("/api/mappings/:id", "PATCH", { id: "2" }, { product_id: 2 });
  expect((await call("/api/products/:id", "GET", { id: "2" })).mappings).toHaveLength(2);
  await call("/api/mappings/:id", "DELETE", { id: "2" });
  expect(db.query("SELECT COUNT(*) n FROM pricesnapshot WHERE mapping_id = 2").get()).toEqual({ n: 0 });

  await call("/api/settings", "POST", {}, { woo_base_url: "https://me.com", woo_key: "ck_1", woo_secret: "cs_1" });
  await call("/api/settings", "POST", {}, { woo_base_url: "https://me.com", woo_key: "", woo_secret: "" });
  const s = await call("/api/settings", "GET");
  expect(s).toMatchObject({ woo_key_set: true, woo_secret_set: true, available_brands: ["Nebo", "Pelican"] });
  expect(JSON.stringify(s)).not.toContain("ck_1");

  expect(await call("/api/reset", "POST")).toEqual({ snapshots: 2, mappings: 2, competitors: 2 });
  expect(db.query("SELECT COUNT(*) n FROM product").get()).toEqual({ n: 2 });
});

test("API: duplicate URL and bad URL are clean errors", async () => {
  await expect(call("/api/mappings", "POST", {}, { product_id: 1, identifier: "https://a.com/1510?utm_source=x" }))
    .rejects.toMatchObject({ status: 409 });
  await expect(call("/api/mappings", "POST", {}, { product_id: 1, identifier: "not a url" }))
    .rejects.toMatchObject({ status: 400 });
  await expect(call("/api/sync", "POST")).rejects.toMatchObject({ status: 400 });
});
