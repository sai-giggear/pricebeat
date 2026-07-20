"""Ask Google which shops sell one of our products.

No API key and no paid service — but not google.com either: google.com/search
now renders its results with JavaScript and returns an empty shell to any
plain HTTP client, whatever user-agent it claims. The results here are still
Google's; they come through Startpage, which runs the query against Google and
returns server-rendered HTML.

Two consequences worth knowing:

* **Region follows this machine.** Startpage geolocates by the requesting IP
  and ignores every region parameter, so the results are the ones a shopper
  sitting where the app runs would see. That is what we want, but it can't be
  overridden from Settings.
* **It is best-effort.** Automated traffic eventually meets a CAPTCHA. That
  surfaces as ``SearchBlocked``, so the UI can say "the search was blocked"
  instead of the far more misleading "no competitors found".

Everything else in the app talks to this module through ``google_search``, so
swapping in a keyed SERP API later is a change to this file alone.
"""
from __future__ import annotations
import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse
import httpx2
from selectolax.parser import HTMLParser

SEARCH_URL = "https://www.startpage.com/sp/search"

# A browser's headers: the PriceTrackerBot UA the price scraper uses is refused
# outright, and the accept/language headers are part of looking ordinary.
BROWSER_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-AU,en;q=0.9",
}

# Hosts that are the search engine itself, not a result.
_ENGINE_HOST = re.compile(r"(^|\.)(startpage\.com|google\.[a-z.]+|"
                          r"googleusercontent\.com|gstatic\.com)$")

# Markers of a "prove you're human" page, which is served with HTTP 200.
_REFUSAL_MARKERS = ("captcha", "unusual traffic", "might be a robot",
                    "detected suspicious")


class SearchBlocked(RuntimeError):
    """The search engine refused the request — CAPTCHA or rate limit."""


@dataclass(frozen=True)
class SearchHit:
    url: str
    title: str


def _target(href: str | None) -> str | None:
    """The destination of a result link, or None if it isn't one."""
    if not href:
        return None
    # Some layouts wrap results in a redirect carrying the real URL in ?q=.
    if href.startswith("/"):
        href = (parse_qs(urlparse(href).query).get("q") or [""])[0]
    if not href.startswith(("http://", "https://")):
        return None
    if _ENGINE_HOST.search(urlparse(href).netloc.lower()):
        return None
    return href


def parse_results(html: str) -> list[SearchHit]:
    """Organic results, in Google's own order, de-duplicated by URL."""
    tree = HTMLParser(html)
    hits: list[SearchHit] = []
    seen: set[str] = set()

    def add(url: str, title: str) -> None:
        if url not in seen and title:
            seen.add(url)
            hits.append(SearchHit(url, title))

    # Each organic result is an <a class="result-title"> whose heading holds
    # the seller's page title.
    for a in tree.css("a.result-title"):
        url = _target(a.attributes.get("href"))
        if url:
            heading = a.css_first("h1, h2, h3")
            add(url, (heading or a).text(strip=True))
    if hits:
        return hits
    # Fallback for a markup change: any external link wrapping a heading.
    for a in tree.css("a"):
        url = _target(a.attributes.get("href"))
        heading = a.css_first("h2, h3") if url else None
        if url and heading is not None:
            add(url, heading.text(strip=True))
    return hits


def _refused(status_code: int, html: str) -> bool:
    if status_code in (403, 429, 503):
        return True
    return any(marker in html[:20000].lower() for marker in _REFUSAL_MARKERS)


async def google_search(query: str, limit: int = 20) -> list[SearchHit]:
    """The top ``limit`` organic Google results for ``query``, in this
    machine's region. Raises ``SearchBlocked`` if the engine refuses."""
    try:
        async with httpx2.AsyncClient(timeout=25, follow_redirects=True,
                                      headers=BROWSER_HEADERS) as client:
            resp = await client.get(SEARCH_URL, params={"query": query})
    except httpx2.HTTPError as exc:
        raise SearchBlocked(f"Couldn't reach the search engine: {exc}") from exc
    if _refused(resp.status_code, resp.text):
        raise SearchBlocked(
            "The search was blocked (automated searches are asked to prove "
            "they're human). Wait a few minutes and try again, or paste the "
            "competitor URLs by hand.")
    return parse_results(resp.text)[:limit]
