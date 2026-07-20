from decimal import Decimal
from datetime import datetime, timezone
from sqlalchemy import Index
from sqlmodel import SQLModel, Field

def _now() -> datetime:
    return datetime.now(timezone.utc)

class Product(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    woo_id: int = Field(index=True)
    name: str
    sku: str | None = None
    own_price: Decimal = Field(max_digits=12, decimal_places=2)
    # RRP / pre-sale price when the store sets one; None when there's no markdown.
    regular_price: Decimal | None = Field(default=None, max_digits=12, decimal_places=2)
    brand: str | None = None
    category: str | None = None
    permalink: str | None = None  # the product's page on the store site
    updated_at: datetime = Field(default_factory=_now)

class Competitor(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    config: str = "{}"  # JSON text: {"source": ..., "price_selector": ...}
    site_url: str | None = None  # origin, e.g. "https://www.tecart.com.au"
    favicon_url: str | None = None  # resolved absolute favicon URL

class Mapping(SQLModel, table=True):
    """A competitor's listing of one of our products — an "offer" in
    BuyWisely terms: the URL plus the seller's own metadata for it."""
    id: int | None = Field(default=None, primary_key=True)
    product_id: int = Field(foreign_key="product.id", index=True)
    competitor_id: int = Field(foreign_key="competitor.id", index=True)
    identifier: str  # the product's URL on the competitor site
    # The seller's own listing data, stamped on each successful fetch. The raw
    # title is kept verbatim (sellers name products differently); the
    # identifiers let us verify the match against our catalogue.
    title: str | None = None
    brand: str | None = None
    sku: str | None = None
    gtin: str | None = None
    mpn: str | None = None
    # "verified" (identifier match) | "likely" (title match) | "review"
    match_status: str | None = None
    created_at: datetime | None = Field(default_factory=_now)
    # Adaptive re-crawl: checked more often while the price moves, backed off
    # while it's stable. last_checked_at updates on every attempt (also
    # failures, so a dead URL isn't hammered).
    last_checked_at: datetime | None = None
    check_interval_hours: float = 24.0

class PriceSnapshot(SQLModel, table=True):
    # "the latest price for this mapping" is the hottest read in the app, and
    # it's always mapping_id + newest-first. The composite index serves that and
    # plain mapping_id lookups, so no separate index on the column.
    __table_args__ = (Index("ix_pricesnapshot_mapping_fetched",
                            "mapping_id", "fetched_at"),)

    id: int | None = Field(default=None, primary_key=True)
    mapping_id: int = Field(foreign_key="mapping.id")
    price: Decimal | None = Field(default=None, max_digits=12, decimal_places=2)
    currency: str = "AUD"
    in_stock: bool = True
    fetched_at: datetime = Field(default_factory=_now)
    status: str = "ok"  # "ok" | "failed" | "blocked"
    error_reason: str | None = None
    # Offer details captured with the price (when the source provides them).
    shipping: Decimal | None = Field(default=None, max_digits=12, decimal_places=2)
    stock_status: str | None = None  # raw availability, e.g. "InStock"
    condition: str | None = None

class AppSettings(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    key: str = Field(index=True, unique=True)
    value: str
