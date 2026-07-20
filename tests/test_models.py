from decimal import Decimal
from datetime import datetime, timezone
from app import db
from app.models import Product, Competitor, Mapping, PriceSnapshot

def test_persist_and_read(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    with db.get_session() as s:
        p = Product(woo_id=1, name="Widget", sku="W1",
                    own_price=Decimal("19.99"), updated_at=datetime.now(timezone.utc))
        c = Competitor(name="RivalCo", config="{}")
        s.add(p); s.add(c); s.commit(); s.refresh(p); s.refresh(c)
        m = Mapping(product_id=p.id, competitor_id=c.id,
                    identifier="https://rival/widget")
        s.add(m); s.commit(); s.refresh(m)
        snap = PriceSnapshot(mapping_id=m.id, price=Decimal("18.50"), currency="AUD",
                             in_stock=True, fetched_at=datetime.now(timezone.utc), status="ok")
        s.add(snap); s.commit()
        assert m.id is not None and snap.price == Decimal("18.50")
