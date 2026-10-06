// Reading a price from a competitor page, and working out how to.
//
// Order of preference, most robust first:
//   Shopify   /products/<handle>.js JSON (theme-proof)       source = "shopify"
//   JSON-LD   schema.org Product/Offer in the page            source = "auto"
//   CSS       a selector tuned per platform, or ".price"      source = "auto"
// HTML is parsed with Bun's built-in HTMLRewriter, so there's no parser dependency.
import { parsePrice } from "./pricing";

export const HEADERS = { "User-Agent": "PriceTrackerBot/1.0" };
export const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9",
};
const TIMEOUT_MS = 20_000;

export type Status = "ok" | "failed" | "blocked";

export type PriceResult = {
  price: number | null;
  currency: string;
  in_stock: boolean;
  status: Status;
  error_reason?: string;
  // The seller's own listing data, when the page carries it.
  title?: string | null;
  brand?: string | null;
  sku?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  shipping?: number | null;
  stock_status?: string | null; // e.g. "InStock"
  condition?: string | null;    // e.g. "NewCondition"
};

export type SourceConfig = { source: "shopify" | "auto"; price_selector: string };

export const failed = (reason: string, status: Status = "failed"): PriceResult =>
  ({ price: null, currency: "AUD", in_stock: false, status, error_reason: reason });

export const get = (url: string, headers: Record<string, string> = HEADERS) =>
  fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });

// ---- URLs -----------------------------------------------------------------

/** Drop tracking params (utm_*, ref, ...) and the fragment, so the same product
 *  pasted twice is one identifier. "variant" stays: Shopify needs it. */
export function cleanUrl(raw: string): string {
  const u = new URL(raw.trim());
  for (const k of [...u.searchParams.keys()]) if (k !== "variant") u.searchParams.delete(k);
  u.hash = "";
  return u.toString();
}

/** Bare hostname, "www." ignored. "" when the URL can't be parsed. */
export function hostOf(url: string | null | undefined): string {
  try { return new URL(url ?? "").hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

// ---- HTML -----------------------------------------------------------------

/** Text of the first element matching each selector in a comma list, tried in
 *  order, so ".summary .price, .price" prefers the first when both exist. */
export async function firstText(html: string, selectorList: string): Promise<string | null> {
  for (const sel of selectorList.split(",").map((s) => s.trim()).filter(Boolean)) {
    let found = false, capturing = false, text = "";
    try {
      await new HTMLRewriter()
        .on(sel, {
          element(el) {
            if (found) return; // later matches are ignored
            found = capturing = true;
            if (el.removed || !el.canHaveContent) capturing = false;
            else el.onEndTag(() => { capturing = false; });
          },
          text(t) { if (capturing) text += t.text; },
        })
        .transform(new Response(html)).text();
    } catch { continue; } // a selector HTMLRewriter can't parse
    if (found) return text;
  }
  return null;
}

export async function scripts(html: string, selector: string): Promise<string[]> {
  const out: string[] = [];
  let cur = "";
  await new HTMLRewriter()
    .on(selector, {
      element(el) { cur = ""; el.onEndTag(() => { out.push(cur); }); },
      text(t) { cur += t.text; },
    })
    .transform(new Response(html)).text();
  return out;
}

export async function faviconOf(html: string, origin: string): Promise<string> {
  let href: string | null = null;
  await new HTMLRewriter()
    .on("link", {
      element(el) {
        const rel = (el.getAttribute("rel") ?? "").toLowerCase();
        if (!href && rel.includes("icon")) href = el.getAttribute("href");
      },
    })
    .transform(new Response(html)).text();
  return new URL(href ?? "/favicon.ico", origin).toString();
}

// ---- JSON-LD offer --------------------------------------------------------

type Json = any;

const enumTail = (v: Json) =>
  typeof v === "string" && v ? v.replace(/\/+$/, "").split("/").pop()! : null;

/** Priced offers in an `offers` value, in order. AggregateOffer has lowPrice. */
function offersIn(offers: Json): Json[] {
  if (Array.isArray(offers)) return offers.flatMap(offersIn);
  if (!offers || typeof offers !== "object") return [];
  return offers.price != null || offers.lowPrice != null ? [offers] : offersIn(offers.offers);
}

/** Our prices are AUD, so an AUD offer wins. Stores that also sell to NZ list
 *  the NZD offer first (rubbermonkey.com.au does). Otherwise the first. */
function pickOffer(offers: Json): Json {
  const all = offersIn(offers);
  return all.find((o) => o.priceCurrency === "AUD") ?? all[0] ?? null;
}

function offerFromProduct(node: Json): Partial<PriceResult> | null {
  const o = pickOffer(node.offers);
  if (!o) return null;
  const price = parsePrice(String(o.price ?? o.lowPrice));
  if (price == null) return null;
  let details = o.shippingDetails;
  if (Array.isArray(details)) details = details[0];
  const rate = details?.shippingRate?.value;
  const brand = typeof node.brand === "object" ? node.brand?.name : node.brand;
  const gtinKey = ["gtin13", "gtin", "gtin12", "gtin14", "gtin8"].find((k) => node[k]);
  const availability = enumTail(o.availability);
  return {
    price,
    currency: typeof o.priceCurrency === "string" ? o.priceCurrency : "AUD",
    title: typeof node.name === "string" ? node.name : null,
    brand: typeof brand === "string" && brand ? brand : null,
    sku: node.sku ? String(node.sku) : null,
    gtin: gtinKey ? String(node[gtinKey]) : null,
    mpn: node.mpn ? String(node.mpn) : null,
    shipping: rate != null ? parsePrice(String(rate)) : null,
    stock_status: availability,
    condition: enumTail(o.itemCondition),
  };
}

function findOffer(node: Json): Partial<PriceResult> | null {
  if (Array.isArray(node)) {
    for (const n of node) { const f = findOffer(n); if (f) return f; }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if ("offers" in node) { const f = offerFromProduct(node); if (f) return f; }
  for (const k of ["@graph", "itemListElement", "item", "mainEntity"]) {
    if (k in node) { const f = findOffer(node[k]); if (f) return f; }
  }
  return null;
}

export async function jsonldOffer(html: string): Promise<Partial<PriceResult> | null> {
  // Prefix match: some stores (Neto/Maropost) write the "+" as "&#x2B;", which
  // browsers decode but HTMLRewriter compares raw.
  for (const text of await scripts(html, 'script[type^="application/ld"]')) {
    try {
      const found = findOffer(JSON.parse(text));
      if (found) return found;
    } catch { /* malformed block, try the next */ }
  }
  return null;
}

// ---- Fetching a price -----------------------------------------------------

const UNAVAILABLE = new Set(["OutOfStock", "SoldOut", "Discontinued"]);

const isBlock = (r: Response) => r.status === 403 || r.status === 429;

/** GET a page. Bot walls are fickle: rubbermonkey.com.au has refused our bot UA
 *  some weeks and a browser UA others, so a refusal gets one retry as the other. */
async function getPage(url: string): Promise<Response> {
  const resp = await get(url);
  return isBlock(resp) ? get(url, BROWSER_HEADERS) : resp;
}

async function fetchAuto(url: string, selector: string): Promise<PriceResult> {
  const resp = await getPage(url);
  if (isBlock(resp)) return failed(`HTTP ${resp.status}`, "blocked");
  if (!resp.ok) return failed(`HTTP ${resp.status}`);
  return priceFromHtml(await resp.text(), selector);
}

/** Price from an already fetched page: JSON-LD first, then the CSS selector. */
export async function priceFromHtml(html: string, selector: string): Promise<PriceResult> {
  const offer = await jsonldOffer(html);
  if (offer) {
    return { currency: "AUD", ...offer, price: offer.price!, status: "ok",
             in_stock: !UNAVAILABLE.has(offer.stock_status ?? "") };
  }
  if (selector) {
    const price = parsePrice(await firstText(html, selector));
    if (price != null) return { price, currency: "AUD", in_stock: true, status: "ok" };
  }
  // Amazon drops the price block entirely when no seller has stock.
  if (/currently unavailable/i.test(html)) return failed("listing unavailable: nobody is selling it right now");
  return failed("no JSON-LD or selector price found");
}

export function shopifyJsUrl(url: string): string | null {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("products");
  return i >= 0 && parts[i + 1] ? `${u.origin}/products/${parts[i + 1]}.js` : null;
}

/** Shopify product JSON: prices in integer cents, exact variant when the URL
 *  names one. */
export function fromShopifyJs(data: Json, url: string): PriceResult | null {
  const variantId = new URL(url).searchParams.get("variant");
  const variant = variantId
    ? (data.variants ?? []).find((v: Json) => String(v.id) === variantId) : null;
  const centsVal = variant ? variant.price : data.price;
  if (typeof centsVal !== "number") return null;
  const available = variant ? variant.available : data.available;
  return {
    price: centsVal / 100, currency: "AUD", status: "ok",
    in_stock: available == null ? true : !!available,
    title: data.title ?? null, brand: data.vendor ?? null, sku: variant?.sku || null,
    stock_status: available == null ? null : available ? "InStock" : "OutOfStock",
  };
}

export async function fetchPrice(url: string, cfg: SourceConfig): Promise<PriceResult> {
  try {
    if (cfg.source === "shopify") {
      const js = shopifyJsUrl(url);
      if (js) {
        const resp = await get(js);
        if (resp.ok) {
          const result = fromShopifyJs(await resp.json().catch(() => ({})), url);
          if (result) return result;
        }
      }
      // JSON endpoint missing or odd: read the page like any other store.
    }
    return await fetchAuto(url, cfg.price_selector);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ---- Detection ------------------------------------------------------------

export type Detected = SourceConfig & { method: string; site_url: string; favicon_url: string };

/** Fetch a page, turning problems into a readable message. */
export async function fetchHtml(url: string): Promise<string> {
  let resp: Response;
  try { resp = await getPage(url); } catch (err) {
    throw new Error(`Couldn't fetch ${url}: ${err instanceof Error ? err.message : err}`);
  }
  if (isBlock(resp)) {
    throw new Error(`Competitor page blocked our request (HTTP ${resp.status})`);
  }
  if (!resp.ok) throw new Error(`Couldn't fetch ${url}: HTTP ${resp.status}`);
  return resp.text();
}

export async function detectSource(url: string, fetchText = fetchHtml): Promise<Detected> {
  const origin = new URL(url).origin;
  const html = await fetchText(url);
  const low = html.toLowerCase();
  const base = { site_url: origin, favicon_url: await faviconOf(html, origin) };

  // A stray "shopify" mention (a buy-button embed) mustn't misclassify the
  // whole store, so confirm through the products JSON.
  if (low.includes("cdn.shopify.com") || low.includes("/cdn/shop/") || low.includes("shopify")) {
    try {
      const data = JSON.parse(await fetchText(`${origin}/products.json?limit=1`));
      if (Array.isArray(data.products)) {
        return { ...base, source: "shopify", price_selector: "",
                 method: "Shopify product JSON" };
      }
    } catch { /* not Shopify after all */ }
  }
  if (low.includes("bigcommerce") || low.includes("productview-price") || low.includes("/stencil/")) {
    return { ...base, source: "auto", price_selector: ".productView-price .price",
             method: "BigCommerce: structured data, then price CSS" };
  }
  if (low.includes("woocommerce") || low.includes("/wp-content/")) {
    return { ...base, source: "auto",
             price_selector: ".summary .price .amount, .price .amount, .price",
             method: "WooCommerce: structured data, then price CSS" };
  }
  if (/application\/ld(\+|&#x2b;)json/.test(low)) {
    return { ...base, source: "auto", price_selector: ".price",
             method: "Structured data (JSON-LD), CSS fallback" };
  }
  return { ...base, source: "auto", price_selector: ".price",
           method: "Generic CSS (.price), check it works" };
}
