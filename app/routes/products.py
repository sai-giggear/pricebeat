from fastapi import APIRouter, HTTPException
from sqlmodel import select
from app import db
from app.analysis import analyze, DEFAULT_RULE
from app.models import Product, Mapping, Competitor, PriceSnapshot
from app.routes.shared import latest_prices, latest_prices_by_product, money
from app.track_filter import filter_active

router = APIRouter()


@router.get("/api/products")
def api_products():
    with db.get_session() as s:
        rows = []
        products = filter_active(s, s.exec(select(Product)).all())
        prices = latest_prices_by_product(s, [p.id for p in products])
        for p in products:
            a = analyze(p.own_price, prices.get(p.id, []), DEFAULT_RULE)
            rows.append({
                "id": p.id, "name": p.name, "sku": p.sku,
                "brand": p.brand, "category": p.category,
                "own_price": money(p.own_price),
                "regular_price": money(p.regular_price),
                "lowest_price": money(a.lowest_price),
                "lowest_seller": a.lowest_seller,
                "gap_to_lowest": money(a.gap_to_lowest),
                "is_lowest": a.is_lowest,
                "suggested_price": money(a.suggested_price),
                "has_data": a.lowest_price is not None,
            })
    return rows


@router.get("/api/products/{product_id}")
def api_product_detail(product_id: int):
    with db.get_session() as s:
        product = s.get(Product, product_id)
        if product is None:
            raise HTTPException(status_code=404, detail="Product not found")
        histories, mappings = [], []
        for m in s.exec(select(Mapping).where(Mapping.product_id == product_id)).all():
            comp = s.get(Competitor, m.competitor_id)
            rows = s.exec(select(PriceSnapshot).where(PriceSnapshot.mapping_id == m.id)
                          .order_by(PriceSnapshot.fetched_at.desc()).limit(30)).all()
            latest_ok = next((r for r in rows if r.status == "ok"), None)
            mappings.append({"id": m.id, "competitor_name": comp.name,
                             "favicon_url": comp.favicon_url,
                             "identifier": m.identifier,
                             # The seller's own listing data + match verdict.
                             "offer_title": m.title,
                             "match_status": m.match_status,
                             "last_checked_at": m.last_checked_at.isoformat()
                             if m.last_checked_at else None,
                             "check_interval_hours": m.check_interval_hours,
                             "stock_status": latest_ok.stock_status if latest_ok else None,
                             "in_stock": latest_ok.in_stock if latest_ok else None,
                             "shipping": money(latest_ok.shipping) if latest_ok else None})
            # Keyed by mapping id: two mappings on the same competitor must not
            # share one history block.
            histories.append({"mapping_id": m.id, "competitor_name": comp.name, "rows": [
                {"fetched_at": r.fetched_at.isoformat() if r.fetched_at else None,
                 "price": money(r.price), "status": r.status} for r in rows]})
        competitors = [{"id": c.id, "name": c.name, "favicon_url": c.favicon_url}
                       for c in s.exec(select(Competitor)).all()]
        a = analyze(product.own_price, latest_prices(s, product), DEFAULT_RULE)
    return {"id": product.id, "name": product.name, "sku": product.sku,
            "permalink": product.permalink,
            "own_price": money(product.own_price),
            "regular_price": money(product.regular_price),
            "lowest_price": money(a.lowest_price), "lowest_seller": a.lowest_seller,
            "gap_to_lowest": money(a.gap_to_lowest), "is_lowest": a.is_lowest,
            "suggested_price": money(a.suggested_price),
            "has_data": a.lowest_price is not None,
            "mappings": mappings, "histories": histories, "competitors": competitors}
