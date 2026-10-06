// Tracking runs: fetch competitor prices, record snapshots, adapt how often
// each listing is re-checked.
import { activeProducts, db, nowStamp, stampMs, type Mapping, type Product } from "./db";
import { settings } from "./config";
import { cents, matchStatus } from "./pricing";
import { failed, fetchPrice, hostOf, type PriceResult, type SourceConfig } from "./scrape";

// Halve the interval while a price moves, back off 1.5x while it holds.
export const MIN_INTERVAL_HOURS = 6;
export const MAX_INTERVAL_HOURS = 72;

export type RunSummary = { products: number; snapshots: number; failures: number };
export type Fetcher = (url: string, cfg: SourceConfig) => Promise<PriceResult>;

type Pair = { product: Product; mapping: Mapping };

const isDue = (m: Mapping, now: number) =>
  !m.last_checked_at ||
  now >= stampMs(m.last_checked_at) + (m.check_interval_hours || 24) * 3_600_000;

function collect(productIds?: number[], mappingIds?: number[], dueOnly = false): Pair[] {
  const rows = db.query<Record<string, any>, []>(`
    SELECT p.*, m.id AS m_id, m.product_id, m.competitor_id, m.identifier, m.title,
      m.brand AS m_brand, m.sku AS m_sku, m.gtin, m.mpn, m.match_status, m.created_at,
      m.last_checked_at, m.check_interval_hours
    FROM product p JOIN mapping m ON m.product_id = p.id`).all();
  let pairs: Pair[] = rows.map((r) => ({
    product: { id: r.id, woo_id: r.woo_id, name: r.name, sku: r.sku, own_price: r.own_price,
               regular_price: r.regular_price, brand: r.brand, category: r.category,
               permalink: r.permalink, updated_at: r.updated_at },
    mapping: { id: r.m_id, product_id: r.product_id, competitor_id: r.competitor_id,
               identifier: r.identifier, title: r.title, brand: r.m_brand, sku: r.m_sku,
               gtin: r.gtin, mpn: r.mpn, match_status: r.match_status, created_at: r.created_at,
               last_checked_at: r.last_checked_at, check_interval_hours: r.check_interval_hours },
  }));
  if (mappingIds) pairs = pairs.filter((p) => mappingIds.includes(p.mapping.id));
  else if (productIds) pairs = pairs.filter((p) => productIds.includes(p.product.id));
  else {
    // Bulk runs only cover what the user chose to track.
    const active = new Set(activeProducts(pairs.map((p) => p.product)).map((p) => p.id));
    pairs = pairs.filter((p) => active.has(p.product.id));
  }
  if (dueOnly) {
    const now = Date.now();
    pairs = pairs.filter((p) => isDue(p.mapping, now));
  }
  return pairs;
}

function latestOkPrice(mappingId: number): number | null {
  return db.query<{ price: number }, [number]>(`SELECT price FROM pricesnapshot
    WHERE mapping_id = ? AND status = 'ok' ORDER BY fetched_at DESC, id DESC LIMIT 1`)
    .get(mappingId)?.price ?? null;
}

export function applyResult(product: Product, mappingId: number, r: PriceResult, at = nowStamp()): void {
  const m = db.query<Mapping, [number]>("SELECT * FROM mapping WHERE id = ?").get(mappingId);
  if (!m) return; // deleted while the run was in flight
  const prev = latestOkPrice(m.id);
  db.query(`INSERT INTO pricesnapshot (mapping_id, price, currency, in_stock, fetched_at,
            status, error_reason, shipping, stock_status, condition) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(m.id, r.price, r.currency, r.in_stock ? 1 : 0, at, r.status, r.error_reason ?? null,
         r.shipping ?? null, r.stock_status ?? null, r.condition ?? null);
  if (r.status !== "ok" || r.price == null) {
    db.query("UPDATE mapping SET last_checked_at = ? WHERE id = ?").run(at, m.id);
    return;
  }
  // Only overwrite with real values, so a selector-only fetch doesn't blank
  // fields an earlier JSON-LD fetch filled in.
  const title = r.title || m.title, brand = r.brand || m.brand, sku = r.sku || m.sku;
  const gtin = r.gtin || m.gtin, mpn = r.mpn || m.mpn;
  let interval = m.check_interval_hours || 24;
  if (prev != null) {
    interval = cents(r.price) !== cents(prev)
      ? Math.max(MIN_INTERVAL_HOURS, interval / 2)
      : Math.min(MAX_INTERVAL_HOURS, interval * 1.5);
  }
  db.query(`UPDATE mapping SET last_checked_at=?, title=?, brand=?, sku=?, gtin=?, mpn=?,
            match_status=?, check_interval_hours=? WHERE id=?`)
    .run(at, title, brand, sku, gtin, mpn,
         matchStatus(product.name, product.sku, [sku, gtin, mpn], title), interval, m.id);
}

/** Hosts run in parallel (up to maxConcurrentHosts); each host's own URLs go
 *  one at a time, their starts at least scrapeDelayMs apart, so being polite to
 *  one competitor doesn't slow the others. */
export async function runTracking(opts: {
  productIds?: number[]; mappingIds?: number[]; dueOnly?: boolean;
  progress?: (done: number, total: number) => void; fetcher?: Fetcher;
} = {}): Promise<RunSummary> {
  const fetcher = opts.fetcher ?? fetchPrice;
  const pairs = collect(opts.productIds, opts.mappingIds, opts.dueOnly);
  const summary = { products: new Set(pairs.map((p) => p.product.id)).size, snapshots: 0, failures: 0 };
  if (!pairs.length) return summary;

  const configs = new Map<number, SourceConfig>();
  for (const c of db.query<{ id: number; config: string }, []>("SELECT id, config FROM competitor").all()) {
    let cfg: any = {};
    try { cfg = JSON.parse(c.config || "{}"); } catch {}
    configs.set(c.id, { source: cfg.source === "shopify" ? "shopify" : "auto",
                        price_selector: cfg.price_selector ?? "" });
  }
  const byHost = Map.groupBy(pairs, (p) => hostOf(p.mapping.identifier));
  const queue = [...byHost.values()];
  opts.progress?.(0, pairs.length);

  async function worker() {
    for (let items = queue.shift(); items; items = queue.shift()) {
      let lastStart = -Infinity;
      for (const { product, mapping } of items) {
        // Gap measured from the previous request's start: a host that took longer
        // than the gap to answer has already had its breather.
        const wait = lastStart + settings.scrapeDelayMs - Date.now();
        if (wait > 0) await Bun.sleep(wait);
        lastStart = Date.now();
        let r: PriceResult;
        try {
          r = await fetcher(mapping.identifier, configs.get(mapping.competitor_id) ?? { source: "auto", price_selector: "" });
        } catch (err) {
          r = failed(err instanceof Error ? err.message : String(err));
        }
        try { applyResult(product, mapping.id, r); } catch { continue; } // keep the run going
        summary.snapshots++;
        if (r.status !== "ok" || r.price == null) summary.failures++;
        opts.progress?.(summary.snapshots, pairs.length);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(settings.maxConcurrentHosts, queue.length) }, worker));
  return summary;
}

/** Drop history older than the retention window. The newest snapshot per
 *  mapping, and its newest successful one, are always kept. */
export function pruneSnapshots(days = settings.snapshotRetentionDays): number {
  if (days <= 0) return 0;
  const cutoff = nowStamp(new Date(Date.now() - days * 86_400_000));
  return db.query(`DELETE FROM pricesnapshot WHERE fetched_at < ?
    AND id NOT IN (SELECT MAX(id) FROM pricesnapshot GROUP BY mapping_id)
    AND id NOT IN (SELECT MAX(id) FROM pricesnapshot WHERE status = 'ok' GROUP BY mapping_id)`)
    .run(cutoff).changes;
}

// ---- Background job -------------------------------------------------------
// A full run takes minutes, too long for one HTTP request, so it runs in the
// background and the UI polls. One at a time: two runs would double-write.

export type Job = {
  id: number; state: "running" | "done" | "error"; done: number; total: number;
  started_at: string; finished_at: string | null; summary: RunSummary | null; error: string | null;
};

let lastJob: Job | null = null;
let nextId = 0;

export const latestJob = () => lastJob;
export const isRunning = () => lastJob?.state === "running";

export function startJob(dueOnly = false): Job {
  if (isRunning()) throw new Error("A tracking run is already in progress");
  const job: Job = { id: ++nextId, state: "running", done: 0, total: 0,
                     started_at: new Date().toISOString(), finished_at: null, summary: null, error: null };
  lastJob = job;
  runTracking({ dueOnly, progress: (d, t) => { job.done = d; job.total = t; } })
    .then((s) => { pruneSnapshots(); job.summary = s; job.state = "done"; })
    .catch((err) => { job.state = "error"; job.error = err instanceof Error ? err.message : String(err); })
    .finally(() => { job.finished_at = new Date().toISOString(); });
  return job;
}

/** Hourly sweep of whatever is due. Skips quietly if a run is in flight. */
export function startScheduler(): Timer {
  return setInterval(() => { if (!isRunning()) startJob(true); }, 3_600_000);
}
