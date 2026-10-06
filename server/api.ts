// JSON API. Every handler returns plain data; errors are thrown as HttpError
// and turned into {detail} responses by index.ts.
import { activeProducts, db, deleteMapping, getSetting, iso, jsonSetting, latestPrices,
         nowStamp, setSetting, type Competitor, type Mapping, type Product, type Snapshot } from "./db";
import { VERSION } from "./config";
import { discover, googleSearch, SearchBlocked, shortlist } from "./discovery";
import { isRunning, latestJob, runTracking, startJob } from "./engine";
import { analyze, isNewer, money } from "./pricing";
import { cleanUrl, detectSource, fetchPrice, hostOf } from "./scrape";
import { applySync, fetchProducts, fetchSales } from "./woo";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Req = Request & { params: Record<string, string> };
const id = (req: Req, key = "id") => Number(req.params[key]);
const body = async <T>(req: Request): Promise<T> => {
  try { return (await req.json()) as T; } catch { return {} as T; }
};

function product(pid: number): Product {
  const p = db.query<Product, [number]>("SELECT * FROM product WHERE id = ?").get(pid);
  if (!p) throw new HttpError(404, "Product not found");
  return p;
}

const parseConfig = (c: Competitor) => {
  try { return JSON.parse(c.config || "{}"); } catch { return {}; }
};

function productRow(p: Product, rivals: { name: string; price: number }[]) {
  const a = analyze(p.own_price, rivals);
  return {
    id: p.id, name: p.name, sku: p.sku, brand: p.brand, category: p.category,
    permalink: p.permalink,
    own_price: money(p.own_price), regular_price: money(p.regular_price),
    lowest_price: money(a.lowest_price), lowest_seller: a.lowest_seller,
    gap_to_lowest: money(a.gap_to_lowest), is_lowest: a.is_lowest,
    suggested_price: money(a.suggested_price), has_data: a.lowest_price != null,
    rivals: rivals.length,
  };
}

// ---- products ---------------------------------------------------------------

function listProducts() {
  const products = activeProducts(db.query<Product, []>("SELECT * FROM product").all());
  const prices = latestPrices();
  return products.map((p) => productRow(p, prices.get(p.id) ?? []));
}

function productDetail(req: Req) {
  const p = product(id(req));
  const mappings = db.query<Mapping & { competitor_name: string; favicon_url: string | null }, [number]>(`
    SELECT m.*, c.name AS competitor_name, c.favicon_url FROM mapping m
    JOIN competitor c ON c.id = m.competitor_id WHERE m.product_id = ? ORDER BY m.id`).all(p.id);
  const history = db.query<Snapshot, [number]>(`SELECT * FROM pricesnapshot WHERE mapping_id = ?
    ORDER BY fetched_at DESC, id DESC LIMIT 60`);
  return {
    ...productRow(p, latestPrices([p.id]).get(p.id) ?? []),
    mappings: mappings.map((m) => {
      const rows = history.all(m.id);
      const ok = rows.find((r) => r.status === "ok");
      return {
        id: m.id, competitor_name: m.competitor_name, favicon_url: m.favicon_url,
        identifier: m.identifier, offer_title: m.title, match_status: m.match_status,
        last_checked_at: iso(m.last_checked_at), check_interval_hours: m.check_interval_hours,
        price: money(ok?.price), stock_status: ok?.stock_status ?? null,
        in_stock: ok ? !!ok.in_stock : null, shipping: money(ok?.shipping),
        last_status: rows[0]?.status ?? null, last_error: rows[0]?.error_reason ?? null,
        history: rows.reverse().map((r) => ({ at: iso(r.fetched_at), price: money(r.price), status: r.status })),
      };
    }),
  };
}

// ---- mappings -----------------------------------------------------------------

/** Track a competitor listing of one of our products. The competitor is
 *  inferred from the URL's host, and added (method detected) when new.
 *  Not fetched here: the caller prices a batch in one run. */
async function createMapping(productId: number, rawUrl: string): Promise<number> {
  let url: string;
  try { url = cleanUrl(rawUrl); } catch {
    throw new HttpError(400, "Enter a full competitor product URL (including https://)");
  }
  product(productId);
  if (db.query("SELECT 1 FROM mapping WHERE product_id = ? AND identifier = ?").get(productId, url)) {
    throw new HttpError(409, "This URL is already tracked for this product");
  }
  const host = hostOf(url);
  if (!host) throw new HttpError(400, "Enter a full competitor product URL (including https://)");
  let comp = db.query<Competitor, []>("SELECT * FROM competitor").all()
    .find((c) => c.site_url && hostOf(c.site_url) === host);
  if (!comp) {
    const cfg = await detect(url);
    comp = db.query<Competitor, [string, string, string, string]>(`INSERT INTO competitor
      (name, config, site_url, favicon_url) VALUES (?,?,?,?) RETURNING *`)
      .get(host, JSON.stringify({ source: cfg.source, price_selector: cfg.price_selector }),
           cfg.site_url, cfg.favicon_url)!;
  }
  return db.query<{ id: number }, [number, number, string, string]>(`INSERT INTO mapping
    (product_id, competitor_id, identifier, created_at, check_interval_hours)
    VALUES (?,?,?,?,24.0) RETURNING id`).get(productId, comp.id, url, nowStamp())!.id;
}

async function detect(url: string) {
  try { return await detectSource(url); } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  }
}

// ---- update check -------------------------------------------------------------
// Best-effort: offline, rate-limited, 404 before the first release, odd tag
// all mean "no update", never an error. Cached 6h (5 min after a failure) to
// stay far under GitHub's 60 requests/hour for anonymous callers.

const REPO = "sai-giggear/pricebeat";
const RELEASES = `https://github.com/${REPO}/releases/latest`;
let versionCache: { at: number; value: any } | null = null;

export async function versionStatus(fetcher: typeof fetch = fetch) {
  const ttl = versionCache?.value.latest ? 6 * 3_600_000 : 300_000;
  if (versionCache && Date.now() - versionCache.at < ttl) return versionCache.value;
  let value = { current: VERSION, latest: null as string | null, update_available: false, url: RELEASES, notes: "" };
  try {
    const resp = await fetcher(`https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(6000) });
    if (resp.ok) {
      const rel: any = await resp.json();
      const tag = String(rel.tag_name ?? "").trim();
      const newer = !!tag && isNewer(tag, VERSION);
      const zip = (rel.assets ?? []).map((a: any) => a.browser_download_url).find((u: string) => u?.endsWith(".zip"));
      value = { current: VERSION, latest: tag.replace(/^v/, "") || null, update_available: newer,
                url: newer ? zip || rel.html_url || RELEASES : RELEASES,
                notes: newer ? String(rel.body ?? "").trim() : "" };
    }
  } catch { /* offline or similar: no update known */ }
  versionCache = { at: Date.now(), value };
  return value;
}

/** Run a Woo call with the saved connection, as a 400 when there is none and a
 *  502 when the store fails. */
async function withStore<T>(what: string, call: (base: string, key: string, secret: string) => Promise<T>) {
  const base = getSetting("woo_base_url").trim();
  if (!base) throw new HttpError(400, "Connect your store first (store URL and API keys in Settings)");
  try { return await call(base, getSetting("woo_key"), getSetting("woo_secret")); }
  catch (err) {
    throw new HttpError(502, `Couldn't fetch ${what} from the store: ${err instanceof Error ? err.message : err}`);
  }
}

/** Other stores you run, as bare hosts. Search leaves them out like your own. */
const ownStores = () => jsonSetting<string[]>("own_stores", []);
const ownHosts = (p: Product) =>
  new Set([hostOf(getSetting("woo_base_url")), hostOf(p.permalink), ...ownStores()].filter(Boolean));

// ---- routes -------------------------------------------------------------------

type Handler = (req: Req) => unknown;
export const routes: Record<string, Partial<Record<"GET" | "POST" | "PATCH" | "DELETE", Handler>>> = {
  "/api/products": { GET: listProducts },
  "/api/products/:id": { GET: productDetail },

  "/api/products/:id/track": {
    POST: async (req) => { product(id(req)); return runTracking({ productIds: [id(req)] }); },
  },

  // Stop tracking one product: it leaves the product list and price runs.
  // Rivals and history stay, and Settings can bring it back.
  "/api/products/:id/stop": {
    POST: (req) => {
      const pid = product(id(req)).id;
      const stopped = jsonSetting<number[]>("track_excluded", []);
      if (!stopped.includes(pid)) setSetting("track_excluded", JSON.stringify([...stopped, pid]));
      return { ok: true };
    },
  },

  "/api/track": {
    POST: () => {
      if (isRunning()) throw new HttpError(409, "A tracking run is already in progress");
      return startJob();
    },
  },
  "/api/track/status": {
    GET: () => latestJob() ?? { state: "idle", done: 0, total: 0, summary: null, error: null },
  },

  "/api/mappings": {
    POST: async (req) => {
      const b = await body<{ product_id: number; identifier: string }>(req);
      const mid = await createMapping(Number(b.product_id), String(b.identifier ?? ""));
      // Price it now: the point of pasting a link is to see the price.
      await runTracking({ mappingIds: [mid] });
      return { id: mid };
    },
  },
  "/api/mappings/:id": {
    DELETE: (req) => {
      if (!db.query("SELECT 1 FROM mapping WHERE id = ?").get(id(req))) throw new HttpError(404, "Mapping not found");
      deleteMapping(id(req));
      return { ok: true };
    },
    // Point a mapping at another product, the fix for a wrong match. History
    // moves with it, since snapshots hang off the mapping.
    PATCH: async (req) => {
      const { product_id } = await body<{ product_id: number }>(req);
      if (!db.query("SELECT 1 FROM mapping WHERE id = ?").get(id(req))) throw new HttpError(404, "Mapping not found");
      product(Number(product_id));
      db.query("UPDATE mapping SET product_id = ? WHERE id = ?").run(Number(product_id), id(req));
      return { ok: true };
    },
  },
  "/api/mappings/:id/track": {
    POST: (req) => {
      if (!db.query("SELECT 1 FROM mapping WHERE id = ?").get(id(req))) throw new HttpError(404, "Mapping not found");
      return runTracking({ mappingIds: [id(req)] });
    },
  },

  "/api/products/:id/discover": {
    POST: async (req) => {
      const p = product(id(req));
      const q = String((await body<{ query?: string }>(req)).query ?? "").trim() || p.name.trim();
      const tracked = new Set(db.query<{ identifier: string }, [number]>(
        "SELECT identifier FROM mapping WHERE product_id = ?").all(p.id).map((m) => m.identifier));
      try {
        const candidates = await discover(p.name, p.sku, q, ownHosts(p), tracked);
        return { query: q, candidates: candidates.map((c) => ({ ...c, price: money(c.price) })) };
      } catch (err) {
        if (err instanceof SearchBlocked) throw new HttpError(502, err.message);
        throw err;
      }
    },
  },
  // Search only: which shops turn up for this product. No page is fetched, so
  // the Competitors page can run it across the whole catalogue quickly.
  "/api/products/:id/search": {
    POST: async (req) => {
      const p = product(id(req));
      try {
        return shortlist(await googleSearch(p.name.trim()), ownHosts(p), 10)
          .map((h) => ({ ...h, host: hostOf(h.url) }));
      } catch (err) {
        if (err instanceof SearchBlocked) throw new HttpError(502, err.message);
        throw err;
      }
    },
  },
  "/api/products/:id/discover/add": {
    POST: async (req) => {
      const pid = product(id(req)).id;
      const { urls = [] } = await body<{ urls?: string[] }>(req);
      const added: number[] = [], skipped: { url: string; reason: string }[] = [];
      for (const url of urls) {
        try { added.push(await createMapping(pid, url)); } catch (err) {
          // One unreachable site mustn't lose the others.
          skipped.push({ url, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      if (added.length) await runTracking({ mappingIds: added });
      return { added: added.length, mapping_ids: added, skipped };
    },
  },

  "/api/competitors": {
    GET: () => db.query<Competitor & { listings: number }, []>(`SELECT c.*,
        (SELECT COUNT(*) FROM mapping m WHERE m.competitor_id = c.id) AS listings
        FROM competitor c ORDER BY c.name COLLATE NOCASE`).all().map((c) => {
      const cfg = parseConfig(c);
      return { id: c.id, name: c.name, site_url: c.site_url, favicon_url: c.favicon_url,
               listings: c.listings, price_selector: cfg.price_selector ?? "",
               method: cfg.source === "shopify" ? "Shopify JSON"
                 : cfg.price_selector ? `JSON-LD, then ${cfg.price_selector}` : "JSON-LD" };
    }),
    POST: async (req) => {
      const b = await body<{ url?: string; name?: string }>(req);
      let url: string;
      try { url = cleanUrl(b.url ?? ""); } catch { throw new HttpError(400, "Enter the store's full URL (including https://)"); }
      const cfg = await detect(url);
      const name = (b.name ?? "").trim() || hostOf(url);
      return db.query(`INSERT INTO competitor (name, config, site_url, favicon_url)
        VALUES (?,?,?,?) RETURNING id`).get(name,
        JSON.stringify({ source: cfg.source, price_selector: cfg.price_selector }), cfg.site_url, cfg.favicon_url);
    },
  },
  "/api/competitors/detect": {
    POST: async (req) => {
      let url: string;
      try { url = cleanUrl((await body<{ url?: string }>(req)).url ?? ""); } catch {
        throw new HttpError(400, "Enter the store's full URL (including https://)");
      }
      const cfg = await detect(url);
      // Best-effort sample, so the UI can say "we found $X here".
      const sample = await fetchPrice(url, cfg).catch(() => null);
      return { ...cfg, sample_price: money(sample?.price) };
    },
  },
  "/api/competitors/:id": {
    PATCH: async (req) => {
      const c = db.query<Competitor, [number]>("SELECT * FROM competitor WHERE id = ?").get(id(req));
      if (!c) throw new HttpError(404, "Competitor not found");
      const b = await body<{ name?: string; price_selector?: string; site_url?: string }>(req);
      const cfg = parseConfig(c);
      // The selector is only a fallback now; blank keeps the current one.
      if (b.price_selector?.trim()) cfg.price_selector = b.price_selector.trim();
      db.query("UPDATE competitor SET name = ?, site_url = ?, config = ? WHERE id = ?").run(
        b.name?.trim() || c.name,
        b.site_url === undefined ? c.site_url : b.site_url.trim() || null,
        JSON.stringify(cfg), c.id);
      return { ok: true };
    },
    DELETE: (req) => {
      const cid = id(req);
      if (!db.query("SELECT 1 FROM competitor WHERE id = ?").get(cid)) throw new HttpError(404, "Competitor not found");
      db.transaction(() => {
        for (const m of db.query<{ id: number }, [number]>("SELECT id FROM mapping WHERE competitor_id = ?").all(cid)) deleteMapping(m.id);
        db.query("DELETE FROM competitor WHERE id = ?").run(cid);
      })();
      return { ok: true };
    },
  },
  // Wipe competitors, mappings and history. Products and settings stay.
  "/api/reset": {
    POST: () => db.transaction(() => {
      const counts: Record<string, number> = {};
      for (const [label, table] of [["snapshots", "pricesnapshot"], ["mappings", "mapping"], ["competitors", "competitor"]]) {
        counts[label] = db.query(`DELETE FROM ${table}`).run().changes;
      }
      return counts;
    })(),
  },

  "/api/settings": {
    // Stored key/secret never go back to the browser, only whether they're set.
    GET: () => {
      const products = db.query<Product, []>("SELECT * FROM product ORDER BY name COLLATE NOCASE").all();
      const distinct = (pick: (p: Product) => string | null) =>
        [...new Set(products.map(pick).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b));
      return {
        woo_base_url: getSetting("woo_base_url"),
        woo_key_set: !!getSetting("woo_key"), woo_secret_set: !!getSetting("woo_secret"),
        own_stores: ownStores().join(", "),
        track_brands: jsonSetting("track_brands", []),
        track_categories: jsonSetting("track_categories", []),
        track_products: jsonSetting("track_products", []),
        track_excluded: jsonSetting("track_excluded", []),
        // Sync stamps every product it touches, so the newest stamp is the last sync.
        last_synced: iso(products.reduce<string | null>((m, p) => (!m || p.updated_at > m ? p.updated_at : m), null)),
        available_brands: distinct((p) => p.brand),
        available_categories: distinct((p) => p.category),
        available_products: products.map(({ id, name, sku, brand, category, own_price }) =>
          ({ id, name, sku, brand, category, price: money(own_price) })),
      };
    },
    POST: async (req) => {
      const b = await body<{ woo_base_url?: string; woo_key?: string; woo_secret?: string; own_stores?: string }>(req);
      setSetting("woo_base_url", (b.woo_base_url ?? "").trim());
      // "giggear.com.au, https://www.other.com/" → ["giggear.com.au", "other.com"]
      setSetting("own_stores", JSON.stringify((b.own_stores ?? "").split(/[\s,]+/)
        .map((s) => hostOf(s.includes("://") ? s : `https://${s}`)).filter(Boolean)));
      // Blank means keep the stored one, so secrets never need re-entering.
      if (b.woo_key) setSetting("woo_key", b.woo_key.trim());
      if (b.woo_secret) setSetting("woo_secret", b.woo_secret.trim());
      return { ok: true };
    },
  },
  "/api/settings/tracking": {
    POST: async (req) => {
      const b = await body<{ brands?: string[]; categories?: string[]; product_ids?: number[]; excluded?: number[] }>(req);
      setSetting("track_brands", JSON.stringify(b.brands ?? []));
      setSetting("track_categories", JSON.stringify(b.categories ?? []));
      setSetting("track_products", JSON.stringify(b.product_ids ?? []));
      setSetting("track_excluded", JSON.stringify(b.excluded ?? []));
      return { ok: true };
    },
  },
  "/api/sync": {
    POST: async () => applySync(await withStore("products", fetchProducts)),
  },
  // Units sold per synced product over the last `days`, best first. Products
  // with no sales are left out.
  "/api/sales": {
    GET: async (req) => {
      const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days")) || 90, 1), 3650);
      const sold = await withStore("orders", (b, k, s) => fetchSales(b, k, s, days));
      return db.query<{ id: number; woo_id: number }, []>("SELECT id, woo_id FROM product").all()
        .map((p) => ({ id: p.id, sold: sold.get(p.woo_id) ?? 0 }))
        .filter((r) => r.sold > 0)
        .sort((a, b) => b.sold - a.sold);
    },
  },

  "/api/version": { GET: () => versionStatus() },
};
