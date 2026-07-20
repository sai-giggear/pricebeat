from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Protocol

USER_AGENT = "PriceTrackerBot/1.0"
HEADERS = {"User-Agent": USER_AGENT}

class PriceStatus:
    OK = "ok"
    FAILED = "failed"
    BLOCKED = "blocked"

@dataclass
class PriceResult:
    price: Decimal | None
    currency: str
    in_stock: bool
    fetched_at: datetime
    status: str
    error_reason: str | None = None
    # Offer metadata scraped alongside the price (all optional; JSON-LD and
    # Shopify JSON provide most of them, a bare CSS-selector fetch none).
    title: str | None = None         # the seller's own product title
    brand: str | None = None
    sku: str | None = None           # seller identifiers, used to verify matches
    gtin: str | None = None
    mpn: str | None = None
    shipping: Decimal | None = None
    stock_status: str | None = None  # raw availability, e.g. "InStock"
    condition: str | None = None     # e.g. "NewCondition"

class PriceSource(Protocol):
    async def fetch(self, identifier: str) -> PriceResult: ...

def build_source(competitor, client=None) -> PriceSource:
    """``client`` lets a tracking run share one connection pool across every
    fetch instead of opening a fresh one per request."""
    import json
    from app.sources.scraper import AutoSource, ShopifySource
    config = json.loads(competitor.config or "{}")
    selector = config.get("price_selector", "")
    if config.get("source") == "shopify":
        return ShopifySource(price_selector=selector, client=client)
    # Everything else uses structured-data-first extraction with a CSS fallback.
    return AutoSource(price_selector=selector, client=client)
