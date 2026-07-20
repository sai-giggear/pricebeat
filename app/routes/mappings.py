import json
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import select
from app import db
from app.engine import run_tracking
from app.models import Competitor, Mapping, Product
from app.routes.shared import delete_mapping, fetch_html, host_of
from app.sources.detect import clean_url, detect_source

router = APIRouter()


class MappingIn(BaseModel):
    product_id: int
    competitor_id: int | None = None  # omitted -> inferred from the identifier URL
    identifier: str


class MappingEdit(BaseModel):
    product_id: int  # the store product this mapping should point at instead


@router.post("/api/mappings", status_code=201)
async def api_mapping_create(body: MappingIn):
    identifier = clean_url(body.identifier)
    with db.get_session() as s:
        if s.get(Product, body.product_id) is None:
            raise HTTPException(status_code=404, detail="Product not found")
        if s.exec(select(Mapping).where(Mapping.product_id == body.product_id,
                                        Mapping.identifier == identifier)).first():
            raise HTTPException(status_code=409,
                detail="This URL is already tracked for this product")
        if body.competitor_id is not None:
            comp = s.get(Competitor, body.competitor_id)
            if comp is None:
                raise HTTPException(status_code=404, detail="Competitor not found")
        else:
            # Infer the competitor from the pasted URL's host, so the UI is a
            # single paste-the-link field. site_url is stamped when the
            # competitor is added by URL.
            h = host_of(identifier)
            if not h:
                raise HTTPException(status_code=400,
                    detail="Enter a full competitor product URL (including https://)")
            comp = next((c for c in s.exec(select(Competitor)).all()
                         if c.site_url and host_of(c.site_url) == h), None)
            if comp is None:
                # No competitor's site matches this host yet — add one
                # automatically, detecting its price extraction method from
                # this same URL, so a single paste is all it takes.
                cfg = await detect_source(identifier, fetch_html)
                config = json.dumps({"source": cfg["source"],
                                     "price_selector": cfg["price_selector"]})
                comp = Competitor(name=h, config=config,
                                  site_url=cfg["site_url"], favicon_url=cfg["favicon_url"])
                s.add(comp); s.commit(); s.refresh(comp)
        m = Mapping(product_id=body.product_id, competitor_id=comp.id,
                    identifier=identifier)
        s.add(m); s.commit(); s.refresh(m)
        mapping_id = m.id
    # Fetch its price right away so the row isn't empty until the next
    # scheduled run — the whole point of pasting a link is to see the price.
    with db.get_session() as s:
        await run_tracking(s, mapping_ids=[mapping_id])
    return {"id": mapping_id}


@router.delete("/api/mappings/{mapping_id}")
def api_mapping_delete(mapping_id: int):
    with db.get_session() as s:
        m = s.get(Mapping, mapping_id)
        if m is None:
            raise HTTPException(status_code=404, detail="Mapping not found")
        delete_mapping(s, m)
        s.commit()
    return {"ok": True}


@router.patch("/api/mappings/{mapping_id}")
def api_mapping_reassign(mapping_id: int, body: MappingEdit):
    """Point a mapping at a different store product — the fix for a wrong
    auto-match. Price history rides along since snapshots hang off the mapping."""
    with db.get_session() as s:
        m = s.get(Mapping, mapping_id)
        if m is None:
            raise HTTPException(status_code=404, detail="Mapping not found")
        if s.get(Product, body.product_id) is None:
            raise HTTPException(status_code=404, detail="Product not found")
        m.product_id = body.product_id
        s.add(m); s.commit()
    return {"ok": True}
