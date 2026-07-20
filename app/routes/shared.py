"""Helpers shared by more than one router."""
from __future__ import annotations
from collections import defaultdict
from decimal import Decimal
from urllib.parse import urlparse
import httpx2
from fastapi import HTTPException
from sqlalchemy import func
from sqlmodel import select
from app.analysis import CompetitorPrice
from app.models import AppSettings, Competitor, Mapping, PriceSnapshot
from app.sources.base import HEADERS


def money(v: Decimal | None) -> str | None:
    return str(v) if v is not None else None


def host_of(url: str) -> str:
    """Bare hostname for matching pasted URLs to competitors ("www." ignored)."""
    h = urlparse(url or "").netloc.lower()
    return h[4:] if h.startswith("www.") else h


def delete_mapping(s, mapping) -> None:
    """Delete a mapping and its price snapshots so no orphans remain."""
    for snap in s.exec(select(PriceSnapshot).where(
            PriceSnapshot.mapping_id == mapping.id)).all():
        s.delete(snap)
    s.delete(mapping)


def latest_prices_by_product(session, product_ids=None) -> dict[int, list[CompetitorPrice]]:
    """Every product's current competitor prices in one query.

    Ranking the snapshots in SQL replaces the per-product-per-mapping lookups
    the products list used to do, which was thousands of queries per page load
    on a real catalogue."""
    ranked = (select(PriceSnapshot.mapping_id, PriceSnapshot.price,
                     func.row_number().over(
                         partition_by=PriceSnapshot.mapping_id,
                         order_by=(PriceSnapshot.fetched_at.desc(),
                                   PriceSnapshot.id.desc())).label("rn"))
              .where(PriceSnapshot.status == "ok",
                     PriceSnapshot.price.is_not(None))
              .subquery())
    q = (select(Mapping.product_id, Competitor.name, ranked.c.price)
         .join(ranked, ranked.c.mapping_id == Mapping.id)
         .join(Competitor, Competitor.id == Mapping.competitor_id)
         .where(ranked.c.rn == 1))
    if product_ids is not None:
        q = q.where(Mapping.product_id.in_(list(product_ids)))
    out: dict[int, list[CompetitorPrice]] = defaultdict(list)
    for product_id, name, price in session.exec(q).all():
        out[product_id].append(CompetitorPrice(name, price))
    return out


def latest_prices(session, product) -> list[CompetitorPrice]:
    return latest_prices_by_product(session, [product.id]).get(product.id, [])


def get_setting(session, key, default=""):
    row = session.exec(select(AppSettings).where(AppSettings.key == key)).first()
    return row.value if row else default


def set_setting(session, key, value):
    row = session.exec(select(AppSettings).where(AppSettings.key == key)).first()
    if row:
        row.value = value
    else:
        row = AppSettings(key=key, value=value)
    session.add(row)


async def fetch_html(url: str) -> str:
    """Fetch a competitor page, turning fetch problems into clean HTTP errors —
    a mistyped or unreachable pasted URL must surface as a message, not a 500."""
    try:
        async with httpx2.AsyncClient(timeout=20, follow_redirects=True,
                                     headers=HEADERS) as client:
            resp = await client.get(url)
            if resp.status_code in (403, 429):
                raise HTTPException(status_code=502,
                    detail=f"Competitor page blocked our request (HTTP {resp.status_code})")
            resp.raise_for_status()
            return resp.text
    except httpx2.HTTPError as exc:
        raise HTTPException(status_code=502,
            detail=f"Couldn't fetch {url}: {exc}") from exc
