import { describe, expect, test } from "bun:test";
import { analyze, isNewer, matchStatus, parsePrice } from "../server/pricing";
import { cleanUrl, detectSource, firstText, fromShopifyJs, jsonldOffer, shopifyJsUrl } from "../server/scrape";
import { parseResults, refused, shortlist } from "../server/discovery";
import { fetchSales, unescape } from "../server/woo";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();

describe("pricing", () => {
  test("parsePrice", () => {
    expect(parsePrice("$18.50")).toBe(18.5);
    expect(parsePrice("Now only AU$1,299.00 inc GST")).toBe(1299);
    expect(parsePrice("1500")).toBe(1500);
    expect(parsePrice("1234.56")).toBe(1234.56);
    expect(parsePrice("call us")).toBeNull();
    expect(parsePrice(null)).toBeNull();
  });

  test("analyze: you're lowest, beaten, no data, floor", () => {
    expect(analyze(90, [{ name: "A", price: 100 }])).toMatchObject({ is_lowest: true, lowest_seller: "you", suggested_price: null });
    expect(analyze(120, [{ name: "A", price: 100 }, { name: "B", price: 110 }]))
      .toMatchObject({ is_lowest: false, lowest_seller: "A", lowest_price: 100, gap_to_lowest: 20, suggested_price: 99 });
    expect(analyze(50, [])).toMatchObject({ lowest_price: null, is_lowest: true });
    expect(analyze(1, [{ name: "A", price: 0.01 }]).suggested_price).toBe(0.01);
    // Half-up at the cent: 10.05 * 0.99 = 9.9495 -> 9.95
    expect(analyze(20, [{ name: "A", price: 10.05 }]).suggested_price).toBe(9.95);
  });

  test("matchStatus", () => {
    expect(matchStatus("Acme Widget", "ACME-AW2000B", ["acmeaw2000b"], null)).toBe("verified");
    expect(matchStatus("Pelican 1510 Carry On Case", null, [], "Pelican 1510 Protector Carry-On Case Black")).toBe("likely");
    expect(matchStatus("Yamaha Digital Piano P-145", null, [], "Yamaha Digital Piano P-225")).toBe("review");
    expect(matchStatus("Pelican 1510 Case", null, [], "Garden hose 20m")).toBe("review");
    expect(matchStatus("Pelican 1510 Case", null, [], null)).toBeNull();
  });

  test("isNewer", () => {
    expect(isNewer("v2.1.0", "2.0.0")).toBe(true);
    expect(isNewer("2.0.0", "2.0.0")).toBe(false);
    expect(isNewer("1.9", "2.0.0")).toBe(false);
    expect(isNewer("2.0.0", "2.0")).toBe(true);
    expect(isNewer("nightly", "2.0.0")).toBe(false);
  });
});

describe("scraping", () => {
  test("JSON-LD offer carries the whole listing", async () => {
    const offer = await jsonldOffer(await fixture("jsonld.html"));
    expect(offer).toMatchObject({
      price: 149, currency: "AUD", title: "Acme Widget Pro 2000 (Black) AW-2000B", brand: "Acme",
      sku: "ACME-AW2000B", gtin: "9312345678907", mpn: "AW-2000B", shipping: 9.95,
      stock_status: "InStock", condition: "NewCondition",
    });
    expect(await jsonldOffer(await fixture("simple.html"))).toBeNull();
  });

  test("JSON-LD: entity-encoded type, AUD offer preferred", async () => {
    // rubbermonkey.com.au (Neto): "+" written as "&#x2B;", NZD offer listed first.
    const html = `<script type="application/ld&#x2B;json">{"@type":"Product","name":"Case","offers":[
      {"@type":"Offer","priceCurrency":"NZD","price":"586.99"},
      {"@type":"Offer","priceCurrency":"AUD","price":"589.00"}]}</script>`;
    expect(await jsonldOffer(html)).toMatchObject({ price: 589, currency: "AUD" });
  });

  test("firstText: nested text, selector lists in priority order", async () => {
    const html = `<p class="price"><del>$10</del><span class="amount"><bdi>$1,299.<b>00</b></bdi></span></p><i class="amount">$5</i>`;
    expect(await firstText(html, ".price .amount")).toBe("$1,299.00");
    expect(await firstText(html, ".nope, .amount")).toBe("$1,299.00");
    expect(await firstText(html, ".nope")).toBeNull();
    expect(parsePrice(await firstText(await fixture("simple.html"), ".price"))).toBe(18.5);
  });

  test("cleanUrl keeps only the Shopify variant", () => {
    expect(cleanUrl("https://x.com/p/w?utm_source=g&ref=a#reviews")).toBe("https://x.com/p/w");
    expect(cleanUrl(" https://x.com/products/w?variant=42&utm_medium=cpc ")).toBe("https://x.com/products/w?variant=42");
  });

  test("Shopify JSON prefers the URL's variant", () => {
    expect(shopifyJsUrl("https://s.com/collections/a/products/widget?variant=2")).toBe("https://s.com/products/widget.js");
    expect(shopifyJsUrl("https://s.com/pages/about")).toBeNull();
    const data = { title: "W", vendor: "Acme", price: 1000, available: true,
                   variants: [{ id: 1, price: 1000, available: true }, { id: 2, price: 1250, available: false, sku: "W-2" }] };
    expect(fromShopifyJs(data, "https://s.com/products/w?variant=2"))
      .toMatchObject({ price: 12.5, in_stock: false, sku: "W-2", stock_status: "OutOfStock", brand: "Acme" });
    expect(fromShopifyJs(data, "https://s.com/products/w")).toMatchObject({ price: 10, in_stock: true });
  });

  test("detectSource confirms Shopify through products.json", async () => {
    const pages: Record<string, string> = {
      "https://s.com/products/w": `<link rel="icon" href="/f.png"><script src="https://cdn.shopify.com/x.js"></script>`,
      "https://s.com/products.json?limit=1": `{"products": []}`,
      "https://w.com/p": `<link rel="stylesheet" href="/wp-content/a.css">`,
      "https://f.com/p": `<p>powered by shopify</p>`,
    };
    const fetchText = async (u: string) => { if (!(u in pages)) throw new Error("404"); return pages[u]; };
    expect(await detectSource("https://s.com/products/w", fetchText))
      .toMatchObject({ source: "shopify", favicon_url: "https://s.com/f.png" });
    expect(await detectSource("https://w.com/p", fetchText))
      .toMatchObject({ source: "auto", price_selector: ".summary .price .amount, .price .amount, .price", favicon_url: "https://w.com/favicon.ico" });
    // A stray mention without the JSON endpoint isn't Shopify.
    expect((await detectSource("https://f.com/p", fetchText)).source).toBe("auto");
  });
});

describe("discovery", () => {
  // Google's shape: result links wrap an <h3>; its own links and the hidden
  // /goto redirects sit alongside.
  const RESULTS = `<html><body>
    <div><a href="https://rival.example/product/widget?srsltid=Af"><br><h3>Widget 3000 — Rival</h3></a></div>
    <div><a href="/url?q=https://shop2.example/w"><h3>Widget | <b>Shop2</b></h3></a></div>
    <a href="https://www.google.com/preferences"><h3>Settings</h3></a>
    <div><a href="/goto?url=CAES"><h3>Hidden</h3></a></div>
    <div><a href="https://rival.example/product/widget?srsltid=Af"><h3>Widget 3000 — Rival</h3></a></div>
  </body></html>`;

  test("parses results in order, de-duplicated, engine links dropped", async () => {
    expect(await parseResults(RESULTS)).toEqual([
      { url: "https://rival.example/product/widget?srsltid=Af", title: "Widget 3000 — Rival" },
      { url: "https://shop2.example/w", title: "Widget | Shop2" },
      { url: "https://www.google.com/goto?url=CAES", title: "Hidden" },
    ]);
    expect(await parseResults("<p>no results</p>")).toEqual([]);
  });

  test("recognises a refusal", () => {
    expect(refused("Our systems have detected unusual traffic")).toBe(true);
    expect(refused(RESULTS)).toBe(false);
  });

  test("shortlist drops own store, socials and repeat sellers", () => {
    const hits = ["https://mystore.com/p", "https://www.facebook.com/x", "https://a.com/1?utm_source=x",
                  "https://a.com/2", "https://m.youtube.com/v", "https://b.com/1"].map((url) => ({ url, title: url }));
    expect(shortlist(hits, new Set(["mystore.com"]), 10).map((h) => h.url)).toEqual(["https://a.com/1", "https://b.com/1"]);
    expect(shortlist(hits, new Set(), 1)).toHaveLength(1);
  });
});

test("Woo names are HTML-unescaped", () => {
  expect(unescape("Bags &amp; Cases &#8211; Big&#x21; &bogus;")).toBe("Bags & Cases – Big! &bogus;");
});

test("fetchSales tallies units per variation, else product", async () => {
  const urls: string[] = [];
  const pages = [[
    { line_items: [{ product_id: 10, variation_id: 0, quantity: 2 }, { product_id: 20, variation_id: 21, quantity: 1 }] },
    { line_items: [{ product_id: 10, variation_id: 0, quantity: 3 }] },
  ], []];
  const fetcher = (async (url: string) => { urls.push(url); return Response.json(pages[urls.length - 1]); }) as typeof fetch;
  const sold = await fetchSales("https://me.com/", "ck", "cs", 30, fetcher);
  expect([...sold]).toEqual([[10, 5], [21, 1]]);
  expect(urls[0]).toMatch(/^https:\/\/me\.com\/wp-json\/wc\/v3\/orders\?after=\d{4}-.*&status=processing,completed&_fields=line_items&per_page=100&page=1$/);
});
