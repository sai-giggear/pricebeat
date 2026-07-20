from dataclasses import asdict
from fastapi import APIRouter, HTTPException
from app import db, jobs
from app.engine import background_run, run_tracking
from app.models import Mapping, Product

router = APIRouter()


@router.post("/api/track", status_code=202)
async def api_track_all():
    """Start a full tracking run in the background and return its job status.

    A full run walks every mapping, which takes far longer than any sensible
    HTTP timeout — the client polls /api/track/status instead of waiting."""
    try:
        return jobs.start(background_run()).public()
    except jobs.AlreadyRunning as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/api/track/status")
def api_track_status():
    job = jobs.latest()
    return job.public() if job else {"state": "idle", "done": 0, "total": 0,
                                     "summary": None, "error": None}


@router.post("/api/products/{product_id}/track")
async def api_track_product(product_id: int):
    with db.get_session() as s:
        if s.get(Product, product_id) is None:
            raise HTTPException(status_code=404, detail="Product not found")
        summary = await run_tracking(s, product_ids=[product_id])
    return asdict(summary)


@router.post("/api/mappings/{mapping_id}/track")
async def api_track_mapping(mapping_id: int):
    """Refetch the price for a single competitor mapping."""
    with db.get_session() as s:
        if s.get(Mapping, mapping_id) is None:
            raise HTTPException(status_code=404, detail="Mapping not found")
        summary = await run_tracking(s, mapping_ids=[mapping_id])
    return asdict(summary)
