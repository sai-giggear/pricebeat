// Typed client for the PriceBeat API, plus the app-wide tracking-run state
// (the "Fetch all" button lives in the top bar but every page reacts to it).
import { createSignal } from "solid-js";

export type MatchStatus = "verified" | "likely" | "review" | null;

export interface ProductRow {
  id: number; name: string; sku: string | null; brand: string | null; category: string | null;
  permalink: string | null; own_price: string; regular_price: string | null;
  lowest_price: string | null; lowest_seller: string; gap_to_lowest: string | null;
  is_lowest: boolean; suggested_price: string | null; has_data: boolean; rivals: number;
}

export interface HistoryPoint { at: string; price: string | null; status: string }

export interface MappingRow {
  id: number; competitor_name: string; favicon_url: string | null; identifier: string;
  offer_title: string | null; match_status: MatchStatus; last_checked_at: string | null;
  check_interval_hours: number; price: string | null; stock_status: string | null;
  in_stock: boolean | null; shipping: string | null; last_status: string | null;
  last_error: string | null; history: HistoryPoint[];
}

export interface ProductDetail extends ProductRow { mappings: MappingRow[] }

export interface Competitor {
  id: number; name: string; site_url: string | null; favicon_url: string | null;
  listings: number; price_selector: string; method: string;
}

export interface Detected {
  source: string; price_selector: string; method: string; site_url: string;
  favicon_url: string | null; sample_price: string | null;
}

export interface Candidate {
  url: string; title: string; host: string; favicon_url: string | null; price: string | null;
  currency: string | null; in_stock: boolean | null; match_status: MatchStatus;
  already_tracked: boolean; suggested: boolean; error: string | null;
}

export interface RunSummary { products: number; snapshots: number; failures: number }

export interface Job {
  state: "idle" | "running" | "done" | "error"; done: number; total: number;
  summary: RunSummary | null; error: string | null;
}

export interface TrackProduct { id: number; name: string; sku: string | null; brand: string | null; category: string | null }

export interface Settings {
  woo_base_url: string; woo_key_set: boolean; woo_secret_set: boolean;
  track_brands: string[]; track_categories: string[]; track_products: number[];
  available_brands: string[]; available_categories: string[]; available_products: TrackProduct[];
}

export interface VersionInfo { current: string; latest: string | null; update_available: boolean; url: string; notes: string }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.detail ?? `Request failed (${r.status})`);
  return data as T;
}

export const api = {
  products: () => call<ProductRow[]>("GET", "/api/products"),
  product: (id: number | string) => call<ProductDetail>("GET", `/api/products/${id}`),
  trackProduct: (id: number) => call<RunSummary>("POST", `/api/products/${id}/track`),
  trackMapping: (id: number) => call<RunSummary>("POST", `/api/mappings/${id}/track`),
  addMapping: (product_id: number, identifier: string) => call("POST", "/api/mappings", { product_id, identifier }),
  deleteMapping: (id: number) => call("DELETE", `/api/mappings/${id}`),
  moveMapping: (id: number, product_id: number) => call("PATCH", `/api/mappings/${id}`, { product_id }),
  discover: (id: number, query = "") =>
    call<{ query: string; candidates: Candidate[] }>("POST", `/api/products/${id}/discover`, { query }),
  discoverAdd: (id: number, urls: string[]) =>
    call<{ added: number; skipped: { url: string; reason: string }[] }>("POST", `/api/products/${id}/discover/add`, { urls }),
  competitors: () => call<Competitor[]>("GET", "/api/competitors"),
  detect: (url: string) => call<Detected>("POST", "/api/competitors/detect", { url }),
  addCompetitor: (url: string, name: string) => call("POST", "/api/competitors", { url, name }),
  editCompetitor: (id: number, body: { name: string; site_url: string; price_selector: string }) =>
    call("PATCH", `/api/competitors/${id}`, body),
  deleteCompetitor: (id: number) => call("DELETE", `/api/competitors/${id}`),
  reset: () => call<{ competitors: number; mappings: number; snapshots: number }>("POST", "/api/reset"),
  settings: () => call<Settings>("GET", "/api/settings"),
  saveConnection: (body: { woo_base_url: string; woo_key: string; woo_secret: string }) =>
    call("POST", "/api/settings", body),
  saveTracking: (body: { brands: string[]; categories: string[]; product_ids: number[] }) =>
    call("POST", "/api/settings/tracking", body),
  sync: () => call<{ synced: number; removed: number }>("POST", "/api/sync"),
  version: () => call<VersionInfo>("GET", "/api/version"),
  trackStatus: () => call<Job>("GET", "/api/track/status").catch(() => null),
};

// ---- Tracking run ---------------------------------------------------------
// A full run is a server-side background job; we poll its status. `dataVersion`
// bumps whenever fresh prices land, so pages refetch.

const [job, setJob] = createSignal<Job | null>(null);
const [dataVersion, setDataVersion] = createSignal(0);
export { job, dataVersion };
export const bumpData = () => setDataVersion((v) => v + 1);
export const running = () => job()?.state === "running";

let polling = false;
async function follow() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await api.trackStatus();
      setJob(s);
      if (s?.state !== "running") break;
    }
    bumpData();
  } finally {
    polling = false;
  }
}

export async function fetchAll() {
  setJob({ state: "running", done: 0, total: 0, summary: null, error: null });
  try {
    setJob(await call<Job>("POST", "/api/track"));
  } catch (err) {
    // 409: a run (probably the hourly sweep) is already going. Follow it.
    const s = await api.trackStatus();
    if (s?.state !== "running") {
      setJob({ state: "error", done: 0, total: 0, summary: null, error: (err as Error).message });
      return;
    }
  }
  await follow();
}

/** Pick up a run started elsewhere (the scheduler, the launch catch-up). */
export async function resumeRun() {
  const s = await api.trackStatus();
  if (s?.state === "running") { setJob(s); void follow(); }
}
