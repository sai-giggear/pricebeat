from __future__ import annotations
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.parse import urlparse, parse_qs
import httpx2
from selectolax.parser import HTMLParser
from app.money import parse_price
from app.sources.base import HEADERS, PriceResult, PriceStatus


def _client(client):
    return client or httpx2.AsyncClient(timeout=20, follow_redirects=True,
                                       headers=HEADERS)


# ---- JSON-LD offer extraction (works across most modern storefronts) --------
# Retailer pages carry a schema.org Product node with far more than a price:
# the seller's own title, brand, SKU/GTIN/MPN identifiers, availability,
# condition and shipping. We capture the whole offer, BuyWisely-style — the
# identifiers make cross-retailer matching verifiable, and the extra fields
# become first-class data on each snapshot.

@dataclass
class OfferData:
    price: Decimal | None = None
    currency: str | None = None
    title: str | None = None
    brand: str | None = None
    sku: str | None = None
    gtin: str | None = None
    mpn: str | None = None
    shipping: Decimal | None = None
    availability: str | None = None  # e.g. "InStock", "OutOfStock"
    condition: str | None = None     # e.g. "NewCondition"


def _enum_tail(value) -> str | None:
    """'https://schema.org/InStock' -> 'InStock' (also accepts bare values)."""
    if isinstance(value, str) and value:
        return value.rstrip("/").rsplit("/", 1)[-1]
    return None


def _brand_name(value) -> str | None:
    if isinstance(value, dict):
        value = value.get("name")
    return value if isinstance(value, str) and value else None


def _shipping_rate(offer: dict) -> Decimal | None:
    details = offer.get("shippingDetails")
    if isinstance(details, list):
        details = details[0] if details else None
    if isinstance(details, dict):
        rate = details.get("shippingRate")
        if isinstance(rate, dict) and rate.get("value") is not None:
            return parse_price(str(rate["value"]))
    return None


def _pick_offer(offers) -> dict | None:
    """The first priced offer from a JSON-LD ``offers`` value (dict or list).
    AggregateOffer carries lowPrice instead of price."""
    if isinstance(offers, list):
        for o in offers:
            picked = _pick_offer(o)
            if picked is not None:
                return picked
        return None
    if isinstance(offers, dict):
        if offers.get("price") is not None or offers.get("lowPrice") is not None:
            return offers
        # AggregateOffer sometimes nests the real offers.
        return _pick_offer(offers.get("offers"))
    return None


def _offer_from_product(node: dict) -> OfferData | None:
    o = _pick_offer(node.get("offers"))
    if o is None:
        return None
    raw = o.get("price") if o.get("price") is not None else o.get("lowPrice")
    price = parse_price(str(raw)) if raw is not None else None
    if price is None:
        return None
    gtin = next((str(node[k]) for k in
                 ("gtin13", "gtin", "gtin12", "gtin14", "gtin8")
                 if node.get(k)), None)
    return OfferData(
        price=price,
        currency=o.get("priceCurrency") if isinstance(o.get("priceCurrency"), str) else None,
        title=node.get("name") if isinstance(node.get("name"), str) else None,
        brand=_brand_name(node.get("brand")),
        sku=str(node["sku"]) if node.get("sku") else None,
        gtin=gtin,
        mpn=str(node["mpn"]) if node.get("mpn") else None,
        shipping=_shipping_rate(o),
        availability=_enum_tail(o.get("availability")),
        condition=_enum_tail(o.get("itemCondition")))


def _find_offer(node) -> OfferData | None:
    """Recursively hunt for a priced Product/Offer in a JSON-LD tree."""
    if isinstance(node, list):
        for n in node:
            found = _find_offer(n)
            if found is not None:
                return found
        return None
    if not isinstance(node, dict):
        return None
    if "offers" in node:
        found = _offer_from_product(node)
        if found is not None:
            return found
    for key in ("@graph", "itemListElement", "item", "mainEntity"):
        if key in node:
            found = _find_offer(node[key])
            if found is not None:
                return found
    return None


def jsonld_offer(html: str) -> OfferData | None:
    for tag in HTMLParser(html).css('script[type="application/ld+json"]'):
        try:
            data = json.loads(tag.text())
        except (json.JSONDecodeError, ValueError):
            continue
        found = _find_offer(data)
        if found is not None:
            return found
    return None


def jsonld_price(html: str) -> Decimal | None:
    offer = jsonld_offer(html)
    return offer.price if offer else None


# ---- Price sources ---------------------------------------------------------

# schema.org availability values that mean "you can't buy it right now".
_UNAVAILABLE = {"OutOfStock", "SoldOut", "Discontinued"}


class AutoSource:
    """Try structured data (JSON-LD Product/Offer) first, then fall back
    to a CSS selector. Robust across WooCommerce, BigCommerce and most themes."""

    def __init__(self, price_selector: str = "", client: httpx2.AsyncClient | None = None):
        self.price_selector = price_selector
        self._client = client

    async def fetch(self, identifier: str) -> PriceResult:
        now = datetime.now(timezone.utc)
        client = _client(self._client)
        try:
            resp = await client.get(identifier)
            if resp.status_code in (403, 429):
                return PriceResult(None, "AUD", False, now, PriceStatus.BLOCKED,
                                   f"HTTP {resp.status_code}")
            resp.raise_for_status()
            offer = jsonld_offer(resp.text)
            if offer is not None:
                return PriceResult(
                    offer.price, offer.currency or "AUD",
                    offer.availability not in _UNAVAILABLE, now, PriceStatus.OK,
                    title=offer.title, brand=offer.brand, sku=offer.sku,
                    gtin=offer.gtin, mpn=offer.mpn, shipping=offer.shipping,
                    stock_status=offer.availability, condition=offer.condition)
            if self.price_selector:
                node = HTMLParser(resp.text).css_first(self.price_selector)
                price = parse_price(node.text()) if node else None
                if price is not None:
                    return PriceResult(price, "AUD", True, now, PriceStatus.OK)
            return PriceResult(None, "AUD", False, now, PriceStatus.FAILED,
                               "no JSON-LD or selector price found")
        except httpx2.HTTPError as exc:
            return PriceResult(None, "AUD", False, now, PriceStatus.FAILED, str(exc))
        finally:
            if self._client is None:
                await client.aclose()


class ShopifySource:
    """Theme-proof Shopify pricing via the product ``.js`` JSON endpoint, using
    the exact variant when the URL carries ``?variant=``. Falls back to
    JSON-LD/CSS (AutoSource) if the JSON endpoint is unavailable."""

    def __init__(self, price_selector: str = "", client: httpx2.AsyncClient | None = None):
        self.price_selector = price_selector
        self._client = client

    @staticmethod
    def _js_url(identifier: str) -> str | None:
        p = urlparse(identifier)
        parts = [seg for seg in p.path.split("/") if seg]
        if "products" in parts:
            i = parts.index("products")
            if i + 1 < len(parts):
                return f"{p.scheme}://{p.netloc}/products/{parts[i + 1]}.js"
        return None

    async def fetch(self, identifier: str) -> PriceResult:
        now = datetime.now(timezone.utc)
        client = _client(self._client)
        try:
            js_url = self._js_url(identifier)
            if js_url:
                resp = await client.get(js_url)
                if resp.status_code == 200:
                    try:
                        result = self._result_from_js(resp.json(), identifier, now)
                    except (json.JSONDecodeError, ValueError, InvalidOperation):
                        result = None
                    if result is not None:
                        return result
            # Fall back to structured data / selector on the HTML page.
            return await AutoSource(self.price_selector, client).fetch(identifier)
        except httpx2.HTTPError as exc:
            return PriceResult(None, "AUD", False, now, PriceStatus.FAILED, str(exc))
        finally:
            if self._client is None:
                await client.aclose()

    @staticmethod
    def _result_from_js(data: dict, identifier: str, now: datetime) -> PriceResult | None:
        # Prices are integer cents. Prefer the exact variant from the URL.
        variant_id = parse_qs(urlparse(identifier).query).get("variant", [None])[0]
        variant = None
        if variant_id:
            variant = next((v for v in data.get("variants", [])
                            if str(v.get("id")) == str(variant_id)), None)
        cents = variant.get("price") if variant else data.get("price")
        if not isinstance(cents, (int, float)):
            return None
        available = variant.get("available") if variant else data.get("available")
        return PriceResult(
            Decimal(cents) / 100, "AUD",
            True if available is None else bool(available), now, PriceStatus.OK,
            title=data.get("title"), brand=data.get("vendor"),
            sku=(variant or {}).get("sku") or None,
            stock_status=None if available is None else
            ("InStock" if available else "OutOfStock"))
