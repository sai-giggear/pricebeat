"""Find competitors for a product with a Google search, then track the ones
the user picks. Two steps on purpose: the search returns a review list, and
only a second call turns chosen listings into tracked mappings."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import select
from app import db, discovery
from app.engine import run_tracking
from app.models import Mapping, Product
from app.routes.shared import create_mapping, get_setting, host_of, money

router = APIRouter()


class DiscoverIn(BaseModel):
    query: str = ""  # blank -> built from the product's name


class DiscoverAddIn(BaseModel):
    urls: list[str] = []


@router.post("/api/products/{product_id}/discover")
async def api_discover(product_id: int, body: DiscoverIn):
    with db.get_session() as s:
        product = s.get(Product, product_id)
        if product is None:
            raise HTTPException(status_code=404, detail="Product not found")
        # Everything the search needs is read out of the session up front: the
        # probing that follows takes seconds and holds no DB connection.
        name, sku = product.name, product.sku
        query = body.query.strip() or discovery.build_query(product.name)
        own_hosts = {h for h in (host_of(get_setting(s, "woo_base_url")),
                                 host_of(product.permalink or "")) if h}
        tracked = {m.identifier for m in s.exec(
            select(Mapping).where(Mapping.product_id == product_id)).all()}
    try:
        candidates = await discovery.discover(name, sku, query=query,
                                              own_hosts=own_hosts, tracked=tracked)
    except discovery.SearchBlocked as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"query": query,
            "candidates": [{"url": c.url, "title": c.title, "host": c.host,
                            "favicon_url": c.favicon_url, "price": money(c.price),
                            "currency": c.currency, "in_stock": c.in_stock,
                            "match_status": c.match_status,
                            "already_tracked": c.already_tracked,
                            "suggested": c.suggested, "error": c.error}
                           for c in candidates]}


@router.post("/api/products/{product_id}/discover/add")
async def api_discover_add(product_id: int, body: DiscoverAddIn):
    """Track the picked listings, then price them all in one run."""
    added: list[int] = []
    skipped: list[dict] = []
    with db.get_session() as s:
        if s.get(Product, product_id) is None:
            raise HTTPException(status_code=404, detail="Product not found")
        for url in body.urls:
            try:
                added.append(await create_mapping(s, product_id, url))
            except HTTPException as exc:
                # One unreachable site must not lose the others.
                skipped.append({"url": url, "reason": exc.detail})
    if added:
        with db.get_session() as s:
            await run_tracking(s, mapping_ids=added)
    return {"added": len(added), "mapping_ids": added, "skipped": skipped}
