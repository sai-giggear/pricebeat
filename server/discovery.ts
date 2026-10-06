// Find shops selling one of our products, price each listing, and grade it.
//
// Search runs Google in this computer's own Chrome or Edge, headless.
// google.com/search returns an empty JS shell to plain HTTP clients; a real
// browser runs that JS and gets real results. gl=au pins them to Australia.
// The browser keeps its own profile (cookies, consent) in the data folder, so
// Google sees a returning visitor rather than a fresh one every search.
//
// Heavy use still meets a CAPTCHA. That surfaces as SearchBlocked, so the UI
// says "blocked" instead of the misleading "no competitors found".
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config";
import { matchStatus, type MatchStatus } from "./pricing";
import { BROWSER_HEADERS, cleanUrl, detectSource, fetchHtml, fetchPrice, hostOf, priceFromHtml } from "./scrape";

const GOOGLE = "https://www.google.com";
const MAX_CANDIDATES = 10;

const ENGINE_HOST = /(^|\.)(google\.[a-z.]+|googleusercontent\.com|gstatic\.com)$/;
const REFUSAL = ["captcha", "unusual traffic", "might be a robot", "detected suspicious"];

// Sites every product search turns up that never sell it. Marketplaces stay:
// eBay and Amazon sellers are exactly who we price against.
const NON_RETAIL = ["facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com",
  "reddit.com", "pinterest.com", "wikipedia.org", "quora.com", "linkedin.com", "medium.com",
  "blogspot.com", "youtube.com", "vimeo.com", "productreview.com.au", "trustpilot.com",
  "choice.com.au", "whirlpool.net.au"];

export class SearchBlocked extends Error {}

type Hit = { url: string; title: string };

function target(href: string | null): string | null {
  if (!href) return null;
  // Google hides the destination behind an opaque /goto?url=. resolveGoto()
  // follows it after parsing.
  if (href.startsWith("/goto?")) return GOOGLE + href;
  // Older layouts wrap results in a redirect with the real URL in ?q=.
  if (href.startsWith("/")) href = new URL(href, "https://x").searchParams.get("q") ?? "";
  if (!/^https?:\/\//.test(href)) return null;
  try { return ENGINE_HOST.test(new URL(href).hostname.toLowerCase()) ? null : href; }
  catch { return null; }
}

/** Organic results in order, de-duplicated: each is a link wrapping a heading. */
export async function parseResults(html: string): Promise<Hit[]> {
  const hits: Hit[] = [];
  let href: string | null = null, title = "", inHeading = false;
  await new HTMLRewriter()
    .on("a", {
      element(el) {
        href = target(el.getAttribute("href"));
        title = "";
        el.onEndTag(() => {
          if (href && title.trim() && !hits.some((h) => h.url === href)) {
            hits.push({ url: href, title: title.trim().replace(/\s+/g, " ") });
          }
          href = null;
        });
      },
    })
    .on("a h2, a h3", {
      element(el) { inHeading = true; el.onEndTag(() => { inHeading = false; }); },
      text(t) { if (inHeading && href) title += t.text; },
    })
    .transform(new Response(html)).text();
  return hits;
}

export const refused = (html: string) => REFUSAL.some((m) => html.slice(0, 20000).toLowerCase().includes(m));

/** Chrome or Edge on this machine. BROWSER_PATH overrides. */
function findBrowser(): string | undefined {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
  return [process.env.BROWSER_PATH, ...roots.flatMap((r) => r
    ? [join(r, "Google/Chrome/Application/chrome.exe"), join(r, "Microsoft/Edge/Application/msedge.exe")] : [])]
    .find((p) => p && existsSync(p));
}

/** The page's DOM after its scripts ran. */
async function render(browser: string, url: string): Promise<string> {
  // ponytail: one shared profile, so two searches at the same instant clash.
  // Fine for one person clicking "Find on Google"; a profile per call if not.
  const proc = Bun.spawn([browser, "--headless=new", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", `--user-data-dir=${join(dataDir(), "search-browser")}`,
    `--user-agent=${BROWSER_HEADERS["User-Agent"]}`, "--dump-dom", url],
    { stdout: "pipe", stderr: "ignore", timeout: 40_000 });
  const html = await new Response(proc.stdout).text();
  await proc.exited;
  return html;
}

/** Where a Google /goto link lands, read off its redirect. */
async function resolveGoto(hit: Hit): Promise<Hit | null> {
  if (!hit.url.startsWith(GOOGLE + "/goto?")) return hit;
  const resp = await fetch(hit.url, { redirect: "manual", headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const url = target(resp?.headers.get("location") ?? null);
  return url ? { ...hit, url } : null;
}

export async function googleSearch(query: string, limit = 20): Promise<Hit[]> {
  const browser = findBrowser();
  if (!browser) throw new SearchBlocked("Search needs Chrome or Edge installed, or BROWSER_PATH set.");
  let html: string;
  try {
    html = await render(browser, `${GOOGLE}/search?${new URLSearchParams({ q: query, hl: "en", gl: "au" })}`);
  } catch (err) {
    throw new SearchBlocked(`Couldn't start the browser for search: ${err instanceof Error ? err.message : err}`);
  }
  const hits = (await Promise.all((await parseResults(html)).slice(0, limit).map(resolveGoto)))
    .filter((h) => h != null);
  // Google's normal results page mentions "captcha" in its scripts, so only an
  // empty page counts as a refusal.
  if (!hits.length && refused(html)) {
    throw new SearchBlocked("Google blocked this search: it asked us to prove we're human. " +
      "Try again later, or paste competitor URLs by hand.");
  }
  return hits;
}

export type Candidate = {
  url: string; title: string; host: string; favicon_url: string | null;
  price: number | null; currency: string | null; in_stock: boolean | null;
  match_status: MatchStatus | null; already_tracked: boolean;
  suggested: boolean; // pre-ticked: priced, matches, not tracked yet
  error: string | null;
};

const nonRetail = (host: string) => NON_RETAIL.some((h) => host === h || host.endsWith("." + h));

/** Results worth probing: own store gone, non-shops gone, one per seller. */
export function shortlist(hits: Hit[], ownHosts: Set<string>, limit: number): Hit[] {
  const out: Hit[] = [], seen = new Set<string>();
  for (const hit of hits) {
    let url: string;
    try { url = cleanUrl(hit.url); } catch { continue; }
    const host = hostOf(url);
    if (!host || ownHosts.has(host) || seen.has(host) || nonRetail(host)) continue;
    seen.add(host);
    out.push({ url, title: hit.title });
    if (out.length >= limit) break;
  }
  return out;
}

export async function discover(
  name: string, sku: string | null, query: string, ownHosts: Set<string>,
  tracked: Set<string>, search = googleSearch,
): Promise<Candidate[]> {
  const picked = shortlist(await search(query, MAX_CANDIDATES * 2), ownHosts, MAX_CANDIDATES);
  const candidates = await Promise.all(picked.map(async ({ url, title }): Promise<Candidate> => {
    const base = { url, host: hostOf(url), already_tracked: tracked.has(url) };
    try {
      // One page load serves both detection and pricing. Shopify still needs
      // its JSON endpoint.
      const html = await fetchHtml(url);
      const cfg = await detectSource(url, (u) => (u === url ? Promise.resolve(html) : fetchHtml(u)));
      const r = cfg.source === "shopify" ? await fetchPrice(url, cfg) : await priceFromHtml(html, cfg.price_selector);
      const priced = r.status === "ok" && r.price != null;
      const match = matchStatus(name, sku, [r.sku, r.gtin, r.mpn], r.title || title);
      return {
        ...base, title: r.title || title, favicon_url: cfg.favicon_url,
        price: priced ? r.price : null, currency: priced ? r.currency : null,
        in_stock: priced ? r.in_stock : null, match_status: match,
        suggested: priced && !base.already_tracked && (match === "verified" || match === "likely"),
        error: priced ? null : r.error_reason || "no price found",
      };
    } catch (err) {
      return { ...base, title, favicon_url: null, price: null, currency: null,
               in_stock: null, match_status: null, suggested: false,
               error: `couldn't read this page (${err instanceof Error ? err.message : err})` };
    }
  }));
  // Pre-ticked first, then anything priced, then dead ends. Sort is stable,
  // so search rank holds within each group.
  const rank = (c: Candidate) => (c.suggested ? 0 : c.price != null ? 1 : 2);
  return candidates.sort((a, b) => rank(a) - rank(b));
}
