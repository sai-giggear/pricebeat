// Find shops selling one of our products, price each listing, and grade it.
//
// Search runs Google in this computer's own Chrome or Edge, headless.
// google.com/search returns an empty JS shell to plain HTTP clients; a real
// browser runs that JS and gets real results. gl=au pins them to Australia.
// The browser keeps its own profile (cookies, consent) in the data folder, so
// Google sees a returning visitor rather than a fresh one every search.
//
// No Chrome or Edge installed: fall back to Startpage over plain HTTP, which
// serves Google results as HTML but follows this machine's IP region.
//
// Either way, heavy use meets a CAPTCHA. That surfaces as SearchBlocked, so the
// UI says "blocked" instead of the misleading "no competitors found".
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config";
import { matchStatus, type MatchStatus } from "./pricing";
import { BROWSER_HEADERS, cleanUrl, detectSource, fetchPrice, hostOf } from "./scrape";

const GOOGLE = "https://www.google.com";
const STARTPAGE_URL = "https://www.startpage.com/sp/search";
const MAX_CANDIDATES = 10;

const ENGINE_HOST = /(^|\.)(startpage\.com|google\.[a-z.]+|googleusercontent\.com|gstatic\.com)$/;
// "anubis": Startpage's proof-of-work challenge page, served with HTTP 200.
const REFUSAL = ["captcha", "unusual traffic", "might be a robot", "detected suspicious", "anubis_challenge"];

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
  // Some layouts wrap results in a redirect with the real URL in ?q=.
  if (href.startsWith("/")) href = new URL(href, "https://x").searchParams.get("q") ?? "";
  if (!/^https?:\/\//.test(href)) return null;
  try { return ENGINE_HOST.test(new URL(href).hostname.toLowerCase()) ? null : href; }
  catch { return null; }
}

/** Organic results in order, de-duplicated. Startpage: an <a class="result-title">
 *  holding a heading. Google, or if that markup changes: any link wrapping a
 *  heading. */
export async function parseResults(html: string): Promise<Hit[]> {
  const collect = async (link: string, heading: string) => {
    const hits: Hit[] = [];
    let href: string | null = null, title = "", inHeading = false;
    await new HTMLRewriter()
      .on(link, {
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
      .on(heading.split(",").map((h) => `${link} ${h.trim()}`).join(", "), {
        element(el) { inHeading = true; el.onEndTag(() => { inHeading = false; }); },
        text(t) { if (inHeading && href) title += t.text; },
      })
      .transform(new Response(html)).text();
    return hits;
  };
  const hits = await collect("a.result-title", "h1, h2, h3");
  return hits.length ? hits : collect("a", "h2, h3");
}

export const refused = (status: number, html: string) =>
  [403, 429, 503].includes(status) ||
  REFUSAL.some((m) => html.slice(0, 20000).toLowerCase().includes(m));

const blocked = () => new SearchBlocked("The search engine blocked this request: it asked us to " +
  "prove we're human. Try again later, or paste competitor URLs by hand.");

/** Chrome or Edge on this machine. BROWSER_PATH overrides. */
function findBrowser(): string | null {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
  const paths = [process.env.BROWSER_PATH, ...roots.flatMap((r) => r
    ? [join(r, "Google/Chrome/Application/chrome.exe"), join(r, "Microsoft/Edge/Application/msedge.exe")] : [])];
  return paths.find((p) => p && existsSync(p))
    ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? Bun.which("microsoft-edge");
}

/** The page's DOM after its scripts ran. */
async function render(browser: string, url: string): Promise<string> {
  // ponytail: one shared profile, so two searches at the same instant clash.
  // Fine for one person clicking "Find on Google"; a profile per call if not.
  const proc = Bun.spawn([browser, "--headless=new", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", `--user-data-dir=${join(dataDir(), "search-browser")}`,
    `--user-agent=${BROWSER_HEADERS["User-Agent"]}`, "--virtual-time-budget=5000", "--dump-dom", url],
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

async function browserSearch(browser: string, query: string, limit: number): Promise<Hit[]> {
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
  if (!hits.length && refused(200, html)) throw blocked();
  return hits;
}

async function startpageSearch(query: string, limit: number): Promise<Hit[]> {
  let resp: Response, html: string;
  try {
    resp = await fetch(`${STARTPAGE_URL}?${new URLSearchParams({ query })}`,
      { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(25_000) });
    html = await resp.text();
  } catch (err) {
    throw new SearchBlocked(`Couldn't reach the search engine: ${err instanceof Error ? err.message : err}`);
  }
  if (refused(resp.status, html)) throw blocked();
  return (await parseResults(html)).slice(0, limit);
}

export async function googleSearch(query: string, limit = 20): Promise<Hit[]> {
  const browser = findBrowser();
  return browser ? browserSearch(browser, query, limit) : startpageSearch(query, limit);
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
      const cfg = await detectSource(url);
      const r = await fetchPrice(url, cfg);
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
