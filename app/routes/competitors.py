import json
from urllib.parse import urlparse
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import delete, select
from app import db
from app.models import Competitor, Mapping, PriceSnapshot
from app.routes.shared import delete_mapping, fetch_html, money
from app.sources.detect import clean_url, detect_source
from app.sources.scraper import AutoSource, ShopifySource

router = APIRouter()


class CompetitorIn(BaseModel):
    name: str = ""
    url: str = ""              # when set, the best price method is auto-detected
    price_selector: str = ""   # legacy/manual path when no url is given


class DetectIn(BaseModel):
    url: str


class CompetitorEdit(BaseModel):
    name: str
    price_selector: str = ""
    site_url: str | None = None


def _config_summary(competitor) -> str:
    cfg = json.loads(competitor.config or "{}")
    sel = cfg.get("price_selector", "")
    if cfg.get("source") == "shopify":
        return "Shopify JSON (.js)"
    if cfg.get("source") == "auto":
        return f"JSON-LD · {sel}" if sel else "JSON-LD"
    return sel


def _competitor_config(existing_config, price_selector) -> str:
    # The name alone can't locate a price; a scraper needs its selector.
    if not price_selector.strip():
        raise HTTPException(status_code=400, detail="Price CSS selector is required")
    cfg = json.loads(existing_config or "{}")
    cfg["price_selector"] = price_selector
    return json.dumps(cfg)


async def _sample_price(url: str, cfg: dict):
    """Best-effort: read one price from ``url`` with the detected method, so the
    UI can show 'we found $X here' when a product URL is pasted."""
    src = (ShopifySource(cfg["price_selector"]) if cfg["source"] == "shopify"
           else AutoSource(cfg["price_selector"]))
    try:
        return (await src.fetch(url)).price
    except Exception:
        return None


@router.get("/api/competitors")
def api_competitors():
    with db.get_session() as s:
        return [{"id": c.id, "name": c.name, "config_summary": _config_summary(c),
                 "price_selector": json.loads(c.config or "{}").get("price_selector", ""),
                 "site_url": c.site_url, "favicon_url": c.favicon_url}
                for c in s.exec(select(Competitor)).all()]


@router.post("/api/competitors/detect")
async def api_competitor_detect(body: DetectIn):
    url = clean_url(body.url)
    cfg = await detect_source(url, fetch_html)
    return {**cfg, "sample_price": money(await _sample_price(url, cfg))}


@router.post("/api/competitors", status_code=201)
async def api_competitor_create(body: CompetitorIn):
    with db.get_session() as s:
        if body.url:
            url = clean_url(body.url)
            cfg = await detect_source(url, fetch_html)
            config = json.dumps({"source": cfg["source"],
                                 "price_selector": cfg["price_selector"]})
            name = body.name.strip() or urlparse(url).netloc.replace("www.", "")
            c = Competitor(name=name, config=config,
                           site_url=cfg["site_url"], favicon_url=cfg["favicon_url"])
        else:
            c = Competitor(name=body.name, config=_competitor_config("{}", body.price_selector))
        s.add(c); s.commit(); s.refresh(c)
        return {"id": c.id}


@router.patch("/api/competitors/{competitor_id}")
def api_competitor_update(competitor_id: int, body: CompetitorEdit):
    with db.get_session() as s:
        comp = s.get(Competitor, competitor_id)
        if comp is None:
            raise HTTPException(status_code=404, detail="Competitor not found")
        comp.name = body.name
        if body.site_url is not None:
            comp.site_url = body.site_url.strip() or None
        # The CSS selector is an optional fallback now (the source/JSON-LD drives
        # extraction), so only update it when one is supplied.
        if body.price_selector.strip():
            cfg = json.loads(comp.config or "{}")
            cfg["price_selector"] = body.price_selector
            comp.config = json.dumps(cfg)
        s.add(comp); s.commit()
    return {"ok": True}


@router.delete("/api/competitors/{competitor_id}")
def api_competitor_delete(competitor_id: int):
    with db.get_session() as s:
        comp = s.get(Competitor, competitor_id)
        if comp is None:
            raise HTTPException(status_code=404, detail="Competitor not found")
        for m in s.exec(select(Mapping).where(Mapping.competitor_id == competitor_id)).all():
            delete_mapping(s, m)
        s.delete(comp)
        s.commit()
    return {"ok": True}


@router.post("/api/reset")
def api_reset():
    """Wipe all competitor/tracking data (competitors, mappings, price history).
    The synced product catalogue and settings are kept."""
    with db.get_session() as s:
        counts = {}
        for label, model in (("snapshots", PriceSnapshot), ("mappings", Mapping),
                             ("competitors", Competitor)):
            counts[label] = s.exec(select(func.count()).select_from(model)).one()
            s.execute(delete(model))
        s.commit()
    return counts
