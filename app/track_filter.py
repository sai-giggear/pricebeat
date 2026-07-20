"""Track-time catalogue filter.

Products stay synced in full, but the user chooses which brands/categories are
actually tracked, and can narrow further to specific products within that pool.
Empty selection = track everything. Nothing is deleted, so toggling something
back on is instant.
"""
from __future__ import annotations
import json
from sqlmodel import select
from app.models import AppSettings, Product


def _value(session, key: str) -> str:
    row = session.exec(select(AppSettings).where(AppSettings.key == key)).first()
    return row.value if row else "[]"


def track_selection(session) -> tuple[set[str], set[str]]:
    brands = set(json.loads(_value(session, "track_brands") or "[]"))
    cats = set(json.loads(_value(session, "track_categories") or "[]"))
    return brands, cats


def tracked_product_ids(session) -> set[int]:
    return set(json.loads(_value(session, "track_products") or "[]"))


def is_active(product: Product, brands: set[str], cats: set[str],
              product_ids: set[int]) -> bool:
    if brands and (product.brand or "") not in brands:
        return False
    if cats and (product.category or "") not in cats:
        return False
    # Product-level narrowing applies on top of the brand/category pool.
    if product_ids and product.id not in product_ids:
        return False
    return True


def filter_active(session, products: list[Product]) -> list[Product]:
    brands, cats = track_selection(session)
    product_ids = tracked_product_ids(session)
    if not brands and not cats and not product_ids:
        return products
    return [p for p in products if is_active(p, brands, cats, product_ids)]
