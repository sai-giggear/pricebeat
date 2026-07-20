from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app import db
from app.engine import run_tracking
from app.models import Mapping, Product
from app.routes.shared import create_mapping, delete_mapping

router = APIRouter()


class MappingIn(BaseModel):
    product_id: int
    competitor_id: int | None = None  # omitted -> inferred from the identifier URL
    identifier: str


class MappingEdit(BaseModel):
    product_id: int  # the store product this mapping should point at instead


@router.post("/api/mappings", status_code=201)
async def api_mapping_create(body: MappingIn):
    with db.get_session() as s:
        mapping_id = await create_mapping(s, body.product_id, body.identifier,
                                          body.competitor_id)
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
