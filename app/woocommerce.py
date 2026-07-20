from __future__ import annotations
import html
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import httpx2

@dataclass
class WooProduct:
    woo_id: int
    name: str
    sku: str | None
    price: Decimal
    regular_price: Decimal | None = None
    brand: str | None = None
    category: str | None = None
    permalink: str | None = None


def _decimal_or_none(raw) -> Decimal | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return Decimal(raw)
    except InvalidOperation:
        return None


def _first_name(items) -> str | None:
    # Woo returns categories/brands as [{"id", "name", "slug"}, ...]; use the
    # first entry's name as the single value we filter on. Absent taxonomy
    # (e.g. stores with no brands plugin) yields an empty list -> None.
    if isinstance(items, list) and items:
        name = (items[0] or {}).get("name")
        # Woo returns taxonomy names HTML-encoded (e.g. "Bags &amp; Cases").
        return html.unescape(name) if name else None
    return None

class WooCommerceConnector:
    def __init__(self, base_url: str, consumer_key: str, consumer_secret: str,
                 client: httpx2.AsyncClient | None = None):
        self.base_url = base_url.rstrip("/")
        self.auth = (consumer_key, consumer_secret)
        self._client = client

    @staticmethod
    def _build(row, brand, category, name_override=None, sku_fallback=None,
               permalink_fallback=None) -> WooProduct | None:
        raw = (row.get("price") or "").strip()
        if not raw:
            return None  # no active price -> nothing to track
        try:
            price = Decimal(raw)
        except InvalidOperation:
            return None  # skip a single malformed price, keep syncing
        # Keep regular_price only when it's a genuine markdown above the active
        # price; equal/absent means "no sale" -> None.
        regular = _decimal_or_none(row.get("regular_price"))
        if regular is not None and regular <= price:
            regular = None
        return WooProduct(int(row["id"]),
                          html.unescape(name_override or row.get("name", "")),
                          row.get("sku") or sku_fallback or None, price,
                          regular_price=regular, brand=brand, category=category,
                          permalink=row.get("permalink") or permalink_fallback)

    async def _fetch_variations(self, client, parent, brand, category) -> list[WooProduct]:
        # Each variation is tracked as its own simple product: unique variation
        # id, price/SKU, and a name suffixed with the variation's attributes.
        url = f"{self.base_url}/wp-json/wc/v3/products/{parent['id']}/variations"
        out, page = [], 1
        while True:
            resp = await client.get(url, params={"per_page": 100, "page": page}, auth=self.auth)
            resp.raise_for_status()
            rows = resp.json()
            if not rows:
                break
            for v in rows:
                attrs = ", ".join(a.get("option", "") for a in (v.get("attributes") or [])
                                  if a.get("option"))
                name = f"{parent.get('name', '')} - {attrs}" if attrs else parent.get("name", "")
                p = self._build(v, brand, category, name_override=name,
                                sku_fallback=parent.get("sku"),
                                permalink_fallback=parent.get("permalink"))
                if p:
                    out.append(p)
            page += 1
        return out

    async def fetch_products(self) -> list[WooProduct]:
        client = self._client or httpx2.AsyncClient(timeout=30)
        url = f"{self.base_url}/wp-json/wc/v3/products"
        out: list[WooProduct] = []
        try:
            page = 1
            while True:
                resp = await client.get(url, params={"per_page": 100, "page": page},
                                        auth=self.auth)
                resp.raise_for_status()
                rows = resp.json()
                if not rows:
                    break
                for r in rows:
                    brand = _first_name(r.get("brands"))
                    category = _first_name(r.get("categories"))
                    if r.get("type") == "variable" and r.get("variations"):
                        out.extend(await self._fetch_variations(client, r, brand, category))
                    else:
                        p = self._build(r, brand, category)
                        if p:
                            out.append(p)
                page += 1
            return out
        finally:
            if self._client is None:
                await client.aclose()
