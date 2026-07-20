"""Given a competitor URL, work out the best way to read its prices.

Returns a config the tracker understands plus a human-readable ``method`` label.
Detection is deliberately ordered from most-robust to most-generic:

  Shopify   -> per-product ``/products/*.js`` JSON (theme-proof)          [source=shopify]
  Woo / BC  -> JSON-LD structured data, with a platform CSS fallback      [source=auto]
  JSON-LD   -> structured data on the page, CSS fallback                  [source=auto]
  generic   -> a best-guess ``.price`` selector to tune by hand           [source=auto]
"""
from __future__ import annotations
import json
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse
from selectolax.parser import HTMLParser

# Query params worth keeping when a pasted URL is cleaned up: everything else
# (utm_*, ref, affiliate ids, ...) is tracking noise that would otherwise turn
# the same product into a "different" identifier on every paste. ``variant``
# is kept because ShopifySource needs it to price the exact variant.
_KEPT_QUERY_PARAMS = {"variant"}


def clean_url(url: str) -> str:
    """Strip tracking-parameter and fragment noise from a pasted product URL."""
    p = urlparse(url.strip())
    kept = [(k, v) for k, v in parse_qsl(p.query) if k in _KEPT_QUERY_PARAMS]
    return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(kept), ""))


def origin_of(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


def host_of(url: str) -> str:
    """Bare hostname for matching URLs to competitors ("www." ignored)."""
    h = urlparse(url or "").netloc.lower()
    return h[4:] if h.startswith("www.") else h


def resolve_favicon(html: str, origin: str) -> str:
    tree = HTMLParser(html)
    for link in tree.css("link"):
        rel = (link.attributes.get("rel") or "").lower()
        href = link.attributes.get("href")
        if href and "icon" in rel:
            return urljoin(origin, href)
    return urljoin(origin, "/favicon.ico")


async def detect_source(url: str, fetch) -> dict:
    origin = origin_of(url)
    html = await fetch(url)
    low = html.lower()
    base = {"site_url": origin, "favicon_url": resolve_favicon(html, origin)}

    # Shopify — confirm via the collection/products JSON so a stray "shopify"
    # mention (e.g. a buy-button embed) can't misclassify the whole store.
    if "cdn.shopify.com" in low or "/cdn/shop/" in low or "shopify" in low:
        try:
            data = json.loads(await fetch(origin + "/products.json?limit=1"))
            if isinstance(data.get("products"), list):
                return {**base, "source": "shopify", "price_selector": "",
                        "method": "Shopify — product JSON (/products/*.js)"}
        except Exception:
            pass

    if "bigcommerce" in low or "productview-price" in low or "/stencil/" in low:
        return {**base, "source": "auto",
                "price_selector": ".productView-price .price",
                "method": "BigCommerce — structured data / price CSS"}

    if "woocommerce" in low or "/wp-content/" in low:
        return {**base, "source": "auto",
                "price_selector": ".summary .price .amount, .price .amount, .price",
                "method": "WooCommerce — structured data / price CSS"}

    if "application/ld+json" in low:
        return {**base, "source": "auto", "price_selector": ".price",
                "method": "Structured data (JSON-LD), CSS fallback"}

    return {**base, "source": "auto", "price_selector": ".price",
            "method": "Generic CSS (.price) — verify it works"}
