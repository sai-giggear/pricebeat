import json
from datetime import datetime, timezone
import httpx2
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import select
from app import db
from app.models import Mapping, Product
from app.routes.shared import delete_mapping, get_setting, set_setting
from app.woocommerce import WooCommerceConnector

router = APIRouter()


class SettingsIn(BaseModel):
    woo_base_url: str = ""
    woo_key: str = ""
    woo_secret: str = ""


class TrackingIn(BaseModel):
    brands: list[str] = []
    categories: list[str] = []
    # Optional finer filter: track only these product ids within the brand/
    # category selection. Empty -> track the whole brand/category pool.
    product_ids: list[int] = []


def _distinct(products, pick):
    return sorted({v for v in (pick(p) for p in products) if v})


@router.get("/api/settings")
def api_settings():
    # Never send stored key/secret to the browser; only report whether each is set.
    with db.get_session() as s:
        products = s.exec(select(Product)).all()
        return {"woo_base_url": get_setting(s, "woo_base_url"),
                "woo_key_set": bool(get_setting(s, "woo_key")),
                "woo_secret_set": bool(get_setting(s, "woo_secret")),
                "track_brands": json.loads(get_setting(s, "track_brands", "[]") or "[]"),
                "track_categories": json.loads(get_setting(s, "track_categories", "[]") or "[]"),
                "track_products": json.loads(get_setting(s, "track_products", "[]") or "[]"),
                "available_brands": _distinct(products, lambda p: p.brand),
                "available_categories": _distinct(products, lambda p: p.category),
                "available_products": [
                    {"id": p.id, "name": p.name, "sku": p.sku,
                     "brand": p.brand, "category": p.category}
                    for p in sorted(products, key=lambda p: p.name.lower())]}


@router.post("/api/settings/tracking")
def api_settings_tracking(body: TrackingIn):
    with db.get_session() as s:
        set_setting(s, "track_brands", json.dumps(body.brands))
        set_setting(s, "track_categories", json.dumps(body.categories))
        set_setting(s, "track_products", json.dumps(body.product_ids))
        s.commit()
    return {"ok": True}


@router.post("/api/settings")
def api_settings_save(body: SettingsIn):
    with db.get_session() as s:
        set_setting(s, "woo_base_url", body.woo_base_url)
        # Blank key/secret means "keep existing" so secrets never need re-entry.
        if body.woo_key:
            set_setting(s, "woo_key", body.woo_key)
        if body.woo_secret:
            set_setting(s, "woo_secret", body.woo_secret)
        s.commit()
    return {"ok": True}


def _prune_missing(s, seen_woo_ids: set[int]) -> int:
    """Delete products no longer in the store feed — items removed from the
    store, and variable-product parents now represented by their variations —
    cascading their mappings and price snapshots. Only call after a full fetch."""
    removed = 0
    for p in s.exec(select(Product)).all():
        if p.woo_id in seen_woo_ids:
            continue
        for m in s.exec(select(Mapping).where(Mapping.product_id == p.id)).all():
            delete_mapping(s, m)
        s.delete(p)
        removed += 1
    return removed


@router.post("/api/sync")
async def api_sync():
    with db.get_session() as s:
        base_url = get_setting(s, "woo_base_url").strip()
        if not base_url:
            raise HTTPException(status_code=400,
                detail="Connect your store first (set the URL and API keys in Settings)")
        conn = WooCommerceConnector(base_url,
                                    get_setting(s, "woo_key"), get_setting(s, "woo_secret"))
        seen: set[int] = set()
        # A full fetch either completes or raises before we prune, so a partial
        # network failure can never wipe the catalogue.
        try:
            fetched = await conn.fetch_products()
        except httpx2.HTTPError as exc:
            # Wrong URL, bad keys, store down — a message, not a 500.
            raise HTTPException(status_code=502,
                detail=f"Couldn't fetch products from the store: {exc}") from exc
        for wp in fetched:
            seen.add(wp.woo_id)
            existing = s.exec(select(Product).where(Product.woo_id == wp.woo_id)).first()
            if existing:
                existing.name, existing.sku, existing.own_price = wp.name, wp.sku, wp.price
                existing.regular_price = wp.regular_price
                existing.brand, existing.category = wp.brand, wp.category
                existing.permalink = wp.permalink
                existing.updated_at = datetime.now(timezone.utc)
            else:
                s.add(Product(woo_id=wp.woo_id, name=wp.name, sku=wp.sku,
                              own_price=wp.price, regular_price=wp.regular_price,
                              brand=wp.brand, category=wp.category,
                              permalink=wp.permalink,
                              updated_at=datetime.now(timezone.utc)))
        removed = _prune_missing(s, seen) if seen else 0
        s.commit()
    return {"synced": len(seen), "removed": removed}
