"""Turn a Google search for one of our products into competitor candidates.

Every organic result is probed exactly the way a hand-pasted URL is: work out
how the site prices its pages, read one price from it, then grade the listing
against our product with the matcher. What comes back is a *review list* —
seller, price, verdict — not new mappings, so a blog post or the wrong variant
can never land in price history unseen.

The store's own site is dropped (it isn't a competitor), as are sites that
can't be a storefront. Marketplaces are deliberately kept: eBay and Amazon
sellers are exactly who we're pricing against.
"""
from __future__ import annotations
import asyncio
from dataclasses import dataclass
from decimal import Decimal
import httpx2
from app.matcher import LIKELY, VERIFIED, match_status
from app.sources.base import HEADERS, PriceStatus
from app.sources.detect import clean_url, detect_source, host_of
from app.sources.scraper import AutoSource, ShopifySource
from app.sources.search import SearchBlocked, google_search  # noqa: F401  (re-exported)

# How many listings a search offers for review. Google is asked for more than
# this, since the store's own site and the non-retail hosts come out first.
MAX_CANDIDATES = 10

# Sites a product search always turns up that never sell the product: social,
# video, reference, and the review/comparison sites. Marketplaces are
# deliberately absent — eBay and Amazon sellers are exactly who we price
# against.
_NON_RETAIL = ("facebook.com", "instagram.com", "tiktok.com", "x.com",
               "twitter.com", "reddit.com", "pinterest.com", "wikipedia.org",
               "quora.com", "linkedin.com", "medium.com", "blogspot.com",
               "youtube.com", "vimeo.com", "productreview.com.au",
               "trustpilot.com", "choice.com.au", "whirlpool.net.au")


@dataclass
class Candidate:
    url: str
    title: str                 # the seller's own listing title, else Google's
    host: str
    favicon_url: str | None
    price: Decimal | None
    currency: str | None
    in_stock: bool | None
    match_status: str | None   # verified | likely | review | None
    already_tracked: bool
    error: str | None          # why no price came back, when none did

    @property
    def suggested(self) -> bool:
        """Pre-ticked in the review list: a real price, and the matcher agrees
        it's the same product. "review" verdicts are shown but never assumed."""
        return (self.price is not None and not self.already_tracked
                and self.match_status in (VERIFIED, LIKELY))


def build_query(name: str) -> str:
    """What a shopper would type: the product name alone. The brand is left out
    because Woo product names already carry it, and adding it again only
    narrows the results. SKUs are left out too — store SKUs are usually
    internal codes that no other retailer publishes."""
    return (name or "").strip()


def _non_retail(host: str) -> bool:
    return any(host == h or host.endswith("." + h) for h in _NON_RETAIL)


async def _probe(url: str, client: httpx2.AsyncClient):
    """Detect the site's pricing method and read one price from ``url``."""
    async def fetch(target: str) -> str:
        resp = await client.get(target)
        resp.raise_for_status()
        return resp.text

    cfg = await detect_source(url, fetch)
    source = (ShopifySource(cfg["price_selector"], client=client)
              if cfg["source"] == "shopify"
              else AutoSource(cfg["price_selector"], client=client))
    return cfg, await source.fetch(url)


def _shortlist(hits, own_hosts: set[str], limit: int) -> list[tuple[str, str, str]]:
    """(url, host, title) for the results worth probing: our own store gone,
    non-storefronts gone, one listing per seller."""
    picked, seen = [], set()
    for hit in hits:
        url = clean_url(hit.url)
        host = host_of(url)
        if not host or host in own_hosts or host in seen or _non_retail(host):
            continue
        seen.add(host)
        picked.append((url, host, hit.title))
        if len(picked) >= limit:
            break
    return picked


async def discover(name: str, sku: str | None, query: str, own_hosts: set[str],
                   tracked: set[str], limit: int = MAX_CANDIDATES) -> list[Candidate]:
    """Search, then price and grade every candidate listing concurrently.

    Raises ``SearchBlocked`` when the search engine refuses; a single listing
    that fails to load is reported on its own row instead, so one dead site
    can't cost you the other nine.
    """
    hits = await google_search(query, limit=limit * 2)
    shortlist = _shortlist(hits, own_hosts, limit)
    if not shortlist:
        return []
    async with httpx2.AsyncClient(
            timeout=20, follow_redirects=True, headers=HEADERS,
            limits=httpx2.Limits(max_connections=len(shortlist))) as client:
        probes = await asyncio.gather(
            *(_probe(url, client) for url, _, _ in shortlist),
            return_exceptions=True)

    candidates = []
    for (url, host, search_title), probe in zip(shortlist, probes):
        common = {"url": url, "host": host, "already_tracked": url in tracked}
        if isinstance(probe, BaseException):
            candidates.append(Candidate(
                title=search_title, favicon_url=None, price=None, currency=None,
                in_stock=None, match_status=None,
                error=f"couldn't read this page ({probe})", **common))
            continue
        cfg, result = probe
        priced = result.status == PriceStatus.OK and result.price is not None
        candidates.append(Candidate(
            title=result.title or search_title,
            favicon_url=cfg.get("favicon_url"),
            price=result.price if priced else None,
            currency=result.currency if priced else None,
            in_stock=result.in_stock if priced else None,
            match_status=match_status(name, sku,
                                      [result.sku, result.gtin, result.mpn],
                                      result.title or search_title),
            error=None if priced else (result.error_reason or "no price found"),
            **common))
    # Best first: the ones we'd tick, then anything that at least priced, then
    # the dead ends — search rank is kept within each group. Category pages and
    # unreachable sites sink to the bottom instead of burying real sellers.
    return sorted(candidates,
                  key=lambda c: 0 if c.suggested else 1 if c.price is not None else 2)
