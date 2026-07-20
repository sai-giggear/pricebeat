// Typed client for the PriceBeat JSON API.

export interface ProductRow {
  id: number;
  name: string;
  sku: string | null;
  brand: string | null;
  category: string | null;
  own_price: string;
  regular_price: string | null;
  lowest_price: string | null;
  lowest_seller: string;
  gap_to_lowest: string | null;
  is_lowest: boolean;
  suggested_price: string | null;
  has_data: boolean;
}

export interface MappingRow {
  id: number;
  competitor_name: string;
  favicon_url: string | null;
  identifier: string;
  offer_title: string | null;
  match_status: "verified" | "likely" | "review" | null;
  last_checked_at: string | null;
  check_interval_hours: number;
  stock_status: string | null;
  in_stock: boolean | null;
  shipping: string | null;
}

export interface HistoryRow {
  fetched_at: string | null;
  price: string | null;
  status: string;
}

export interface CompetitorOption {
  id: number;
  name: string;
  favicon_url: string | null;
}

export interface ProductDetail {
  id: number;
  name: string;
  sku: string | null;
  permalink: string | null;
  own_price: string;
  regular_price: string | null;
  lowest_price: string | null;
  lowest_seller: string;
  gap_to_lowest: string | null;
  is_lowest: boolean;
  suggested_price: string | null;
  has_data: boolean;
  mappings: MappingRow[];
  histories: { mapping_id: number; competitor_name: string; rows: HistoryRow[] }[];
  competitors: CompetitorOption[];
}

export interface Competitor {
  id: number;
  name: string;
  config_summary: string;
  price_selector: string;
  site_url: string | null;
  favicon_url: string | null;
}

export interface DetectResult {
  source: string;
  price_selector: string;
  method: string;
  site_url: string;
  favicon_url: string | null;
  sample_price: string | null;
}

export interface TrackProduct {
  id: number;
  name: string;
  sku: string | null;
  brand: string | null;
  category: string | null;
}

export interface RunSummary {
  products: number;
  snapshots: number;
  failures: number;
}

/** A full tracking run is a background job; the UI polls it for progress. */
export interface TrackJob {
  id?: number;
  state: "idle" | "running" | "done" | "error";
  done: number;
  total: number;
  summary: RunSummary | null;
  error: string | null;
}

export interface Settings {
  woo_base_url: string;
  woo_key_set: boolean;
  woo_secret_set: boolean;
  track_brands: string[];
  track_categories: string[];
  track_products: number[];
  available_brands: string[];
  available_categories: string[];
  available_products: TrackProduct[];
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  url: string;
  notes: string;
}

async function handle(r: Response) {
  if (!r.ok) {
    let detail = `Request failed (${r.status})`;
    try {
      const body = await r.json();
      if (body?.detail) detail = body.detail;
    } catch { /* non-JSON error */ }
    throw new Error(detail);
  }
  return r.json();
}

const get = (url: string) => fetch(url).then(handle);
const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(handle);
const del = (url: string) => fetch(url, { method: "DELETE" }).then(handle);

export const api = {
  products: (): Promise<ProductRow[]> => get("/api/products"),
  product: (id: number | string): Promise<ProductDetail> => get(`/api/products/${id}`),
  trackAll: (): Promise<TrackJob> => post("/api/track"),
  trackStatus: (): Promise<TrackJob> => get("/api/track/status"),
  trackProduct: (id: number | string) => post(`/api/products/${id}/track`),
  sync: () => post("/api/sync"),
  competitors: (): Promise<Competitor[]> => get("/api/competitors"),
  detectCompetitor: (url: string): Promise<DetectResult> =>
    post("/api/competitors/detect", { url }),
  createCompetitor: (body: { name?: string; url?: string; price_selector?: string }) =>
    post("/api/competitors", body),
  updateCompetitor: (id: number, body: { name: string; price_selector?: string; site_url?: string }) =>
    fetch(`/api/competitors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(handle),
  deleteCompetitor: (id: number) => del(`/api/competitors/${id}`),
  reset: (): Promise<{ competitors: number; mappings: number; snapshots: number }> =>
    post("/api/reset"),
  createMapping: (body: { product_id: number; competitor_id?: number; identifier: string }) =>
    post("/api/mappings", body),
  trackMapping: (id: number) => post(`/api/mappings/${id}/track`),
  deleteMapping: (id: number) => del(`/api/mappings/${id}`),
  reassignMapping: (id: number, product_id: number) =>
    fetch(`/api/mappings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id }),
    }).then(handle),
  settings: (): Promise<Settings> => get("/api/settings"),
  saveSettings: (body: { woo_base_url: string; woo_key: string; woo_secret: string }) =>
    post("/api/settings", body),
  saveTracking: (body: { brands: string[]; categories: string[]; product_ids: number[] }) =>
    post("/api/settings/tracking", body),
  version: (): Promise<VersionInfo> => get("/api/version"),
};
