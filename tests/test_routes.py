import asyncio
import json
import threading
import time
from decimal import Decimal
from datetime import datetime, timezone
from fastapi.testclient import TestClient
from sqlmodel import select
from app import db
from app.models import Product, Competitor, Mapping, PriceSnapshot, AppSettings

def _client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    with db.get_session() as s:
        s.add(Product(woo_id=1, name="Widget", sku="W1", own_price=Decimal("20.00"),
                      updated_at=datetime.now(timezone.utc)))
        s.commit()
    from app.main import app
    return TestClient(app)

def _pid():
    with db.get_session() as s:
        return s.exec(select(Product)).first().id

def test_products_api_lists_product(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.get("/api/products")
    assert r.status_code == 200
    body = r.json()
    assert body[0]["name"] == "Widget" and body[0]["own_price"] == "20.00"

def test_products_api_includes_brand_and_category(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    with db.get_session() as s:
        p = s.exec(select(Product)).first()
        p.brand, p.category = "Acme", "Widgets"
        s.add(p); s.commit()
    row = c.get("/api/products").json()[0]
    assert row["brand"] == "Acme" and row["category"] == "Widgets"

def _await_run(c, tries=200):
    """Poll the background tracking job until it stops running."""
    for _ in range(tries):
        job = c.get("/api/track/status").json()
        if job["state"] != "running":
            return job
        time.sleep(0.01)
    raise AssertionError("tracking job never finished")

def test_track_all_runs_in_background_and_reports_summary(tmp_path, monkeypatch):
    # Entered as a context manager so the app's event loop lives across
    # requests — the background job runs on it.
    with _client(tmp_path, monkeypatch) as c:
        r = c.post("/api/track")
        # 202: the run is started, not finished — the client polls for it.
        assert r.status_code == 202 and r.json()["state"] == "running"
        job = _await_run(c)
        assert job["state"] == "done" and "snapshots" in job["summary"]

def test_track_status_is_idle_before_any_run(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.get("/api/track/status").json()["state"] == "idle"

def test_track_all_rejects_a_second_concurrent_run(tmp_path, monkeypatch):
    started = threading.Event()
    release = threading.Event()

    async def slow_run(session, *args, **kwargs):
        from app.engine import RunSummary
        started.set()
        await asyncio.get_running_loop().run_in_executor(None, release.wait)
        return RunSummary(0, 0, 0)

    with _client(tmp_path, monkeypatch) as c:
        # Patched on app.engine, not the route module: the route delegates to
        # engine.background_run(), whose closure looks the name up there.
        monkeypatch.setattr("app.engine.run_tracking", slow_run)
        assert c.post("/api/track").status_code == 202
        assert started.wait(5)
        try:
            # Overlapping runs would double-write snapshots and fight over the
            # SQLite write lock, so the second one is refused outright.
            assert c.post("/api/track").status_code == 409
        finally:
            release.set()
        _await_run(c)

def test_track_single_product(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    pid = _pid()
    assert c.post(f"/api/products/{pid}/track").status_code == 200
    assert c.post("/api/products/9999/track").status_code == 404

def test_competitor_create_and_list(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.post("/api/competitors", json={"name": "Rival", "price_selector": ".price"})
    assert r.status_code == 201
    with db.get_session() as s:
        comp = s.exec(select(Competitor)).first()
        assert comp.name == "Rival" and json.loads(comp.config)["price_selector"] == ".price"
    listed = c.get("/api/competitors").json()
    assert listed[0]["name"] == "Rival" and listed[0]["config_summary"] == ".price"
    assert "favicon_url" in listed[0] and "site_url" in listed[0]

def test_competitor_requires_config(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.post("/api/competitors", json={"name": "X",
        "price_selector": ""}).status_code == 400

def test_competitor_update_changes_name_and_config(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    c.post("/api/competitors", json={"name": "Rival", "price_selector": ".price"})
    with db.get_session() as s:
        cid = s.exec(select(Competitor)).first().id
    r = c.patch(f"/api/competitors/{cid}", json={"name": "Rival Renamed",
        "price_selector": ".new-price"})
    assert r.status_code == 200
    with db.get_session() as s:
        comp = s.get(Competitor, cid)
        assert comp.name == "Rival Renamed"
        assert json.loads(comp.config)["price_selector"] == ".new-price"

def test_competitor_update_allows_empty_selector(tmp_path, monkeypatch):
    # The selector is an optional fallback now; an empty one keeps the existing
    # config (so you can rename a Shopify/JSON competitor that has no selector).
    c = _client(tmp_path, monkeypatch)
    c.post("/api/competitors", json={"name": "Rival", "price_selector": ".price"})
    with db.get_session() as s:
        cid = s.exec(select(Competitor)).first().id
    r = c.patch(f"/api/competitors/{cid}", json={"name": "Renamed", "price_selector": ""})
    assert r.status_code == 200
    with db.get_session() as s:
        comp = s.get(Competitor, cid)
        assert comp.name == "Renamed"
        assert json.loads(comp.config)["price_selector"] == ".price"


def test_reset_wipes_tracking_data_keeps_products(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    with db.get_session() as s:
        p = s.exec(select(Product)).first()
        comp = Competitor(name="Rival", config="{}")
        s.add(comp); s.commit(); s.refresh(comp)
        m = Mapping(product_id=p.id, competitor_id=comp.id, identifier="u")
        s.add(m); s.commit(); s.refresh(m)
        s.add(PriceSnapshot(mapping_id=m.id, price=Decimal("1.00"), currency="AUD",
              in_stock=True, fetched_at=datetime.now(timezone.utc), status="ok"))
        s.commit()
    body = c.post("/api/reset").json()
    assert body["competitors"] == 1 and body["mappings"] == 1 and body["snapshots"] == 1
    with db.get_session() as s:
        assert s.exec(select(Competitor)).all() == []
        assert s.exec(select(Mapping)).all() == []
        assert s.exec(select(PriceSnapshot)).all() == []
        assert len(s.exec(select(Product)).all()) == 1  # catalogue kept

def test_competitor_update_missing_404(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.patch("/api/competitors/9999",
        json={"name": "X", "price_selector": ".p"}).status_code == 404

def test_competitor_delete_cascades(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    with db.get_session() as s:
        p = s.exec(select(Product)).first()
        comp = Competitor(name="Rival", config="{}")
        s.add(comp); s.commit(); s.refresh(comp)
        m = Mapping(product_id=p.id, competitor_id=comp.id, identifier="u")
        s.add(m); s.commit(); s.refresh(m)
        s.add(PriceSnapshot(mapping_id=m.id, price=Decimal("1.00"), currency="AUD",
              in_stock=True, fetched_at=datetime.now(timezone.utc), status="ok"))
        s.commit()
        cid = comp.id
    assert c.delete(f"/api/competitors/{cid}").status_code == 200
    with db.get_session() as s:
        assert s.exec(select(Competitor)).all() == []
        assert s.exec(select(Mapping)).all() == []
        assert s.exec(select(PriceSnapshot)).all() == []

def test_mapping_create(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    with db.get_session() as s:
        p = s.exec(select(Product)).first()
        comp = Competitor(name="Rival", config="{}")
        s.add(comp); s.commit(); s.refresh(comp)
        pid, cid = p.id, comp.id
    r = c.post("/api/mappings", json={"product_id": pid, "competitor_id": cid,
        "identifier": "https://r/w"})
    assert r.status_code == 201
    with db.get_session() as s:
        assert s.exec(select(Mapping)).first().identifier == "https://r/w"

def test_mapping_delete_removes_snapshots(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    with db.get_session() as s:
        p = s.exec(select(Product)).first()
        comp = Competitor(name="Rival", config="{}")
        s.add(comp); s.commit(); s.refresh(comp)
        m = Mapping(product_id=p.id, competitor_id=comp.id, identifier="u")
        s.add(m); s.commit(); s.refresh(m)
        s.add(PriceSnapshot(mapping_id=m.id, price=Decimal("1.00"), currency="AUD",
              in_stock=True, fetched_at=datetime.now(timezone.utc), status="ok"))
        s.commit()
        mid = m.id
    assert c.delete(f"/api/mappings/{mid}").status_code == 200
    with db.get_session() as s:
        assert s.exec(select(Mapping)).all() == []
        assert s.exec(select(PriceSnapshot)).all() == []

def test_mapping_create_infers_competitor_from_url(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    with db.get_session() as s:
        pid = s.exec(select(Product)).first().id
        comp = Competitor(name="Rival", config="{}",
                          site_url="https://www.rival.example")
        s.add(comp); s.commit(); s.refresh(comp)
        cid = comp.id
    r = c.post("/api/mappings", json={"product_id": pid,
        "identifier": "https://rival.example/product/widget/"})
    assert r.status_code == 201
    with db.get_session() as s:
        assert s.exec(select(Mapping)).first().competitor_id == cid

def test_mapping_create_without_host_is_rejected(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    pid = _pid()
    r = c.post("/api/mappings", json={"product_id": pid, "identifier": "not-a-url"})
    assert r.status_code == 400

def test_mapping_create_auto_adds_unknown_competitor(tmp_path, monkeypatch):
    # Pasting a URL for a site with no matching Competitor row auto-adds one,
    # detecting its price-extraction method, then fetches the price.
    c = _client(tmp_path, monkeypatch)
    pid = _pid()

    async def fake_fetch_html(url):
        return '<html><head><link rel="icon" href="/f.png"></head>' \
               '<body class="woocommerce"></body></html>'

    tracked_mapping_ids = []
    async def fake_run_tracking(session, *args, **kwargs):
        from app.engine import RunSummary
        tracked_mapping_ids.extend(kwargs.get("mapping_ids") or [])
        return RunSummary(0, 0, 0)

    monkeypatch.setattr("app.routes.mappings.fetch_html", fake_fetch_html)
    monkeypatch.setattr("app.routes.mappings.run_tracking", fake_run_tracking)

    r = c.post("/api/mappings", json={"product_id": pid,
        "identifier": "https://someone-else.example/product/widget/?utm_source=x&ref=y"})
    assert r.status_code == 201
    with db.get_session() as s:
        comp = s.exec(select(Competitor)).first()
        assert comp.name == "someone-else.example"
        assert comp.site_url == "https://someone-else.example"
        assert json.loads(comp.config)["source"] == "auto"
        m = s.exec(select(Mapping)).first()
        assert m.competitor_id == comp.id
        # Tracking params stripped; no variant to keep here.
        assert m.identifier == "https://someone-else.example/product/widget/"
        assert tracked_mapping_ids == [m.id]

def test_mapping_create_strips_tracking_params_but_keeps_variant(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    with db.get_session() as s:
        pid = s.exec(select(Product)).first().id
        comp = Competitor(name="Rival", config="{}", site_url="https://rival.example")
        s.add(comp); s.commit()

    async def fake_run_tracking(session, *args, **kwargs):
        from app.engine import RunSummary
        return RunSummary(0, 0, 0)
    monkeypatch.setattr("app.routes.mappings.run_tracking", fake_run_tracking)

    r = c.post("/api/mappings", json={"product_id": pid,
        "identifier": "https://rival.example/products/widget?variant=123&utm_source=x"})
    assert r.status_code == 201
    with db.get_session() as s:
        assert s.exec(select(Mapping)).first().identifier == \
            "https://rival.example/products/widget?variant=123"

def test_mapping_reassign_moves_to_other_product(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    with db.get_session() as s:
        p = s.exec(select(Product)).first()
        other = Product(woo_id=2, name="Gadget", own_price=Decimal("30.00"),
                        updated_at=datetime.now(timezone.utc))
        comp = Competitor(name="Rival", config="{}")
        s.add(other); s.add(comp); s.commit(); s.refresh(other); s.refresh(comp)
        m = Mapping(product_id=p.id, competitor_id=comp.id, identifier="u")
        s.add(m); s.commit(); s.refresh(m)
        mid, other_id = m.id, other.id
    assert c.patch(f"/api/mappings/{mid}", json={"product_id": other_id}).status_code == 200
    with db.get_session() as s:
        assert s.get(Mapping, mid).product_id == other_id
    assert c.patch(f"/api/mappings/{mid}", json={"product_id": 9999}).status_code == 404
    assert c.patch("/api/mappings/9999", json={"product_id": other_id}).status_code == 404

def test_sync_prunes_products_missing_from_feed(tmp_path, monkeypatch):
    from decimal import Decimal as D
    from app.woocommerce import WooProduct
    c = _client(tmp_path, monkeypatch)
    # DB has Widget (woo_id 1). Add a stale variable-parent row (woo_id 99) that
    # the new feed no longer emits (its variations replace it).
    with db.get_session() as s:
        s.add(Product(woo_id=99, name="Old Parent", own_price=D("5.00"),
                      updated_at=datetime.now(timezone.utc)))
        s.add(AppSettings(key="woo_base_url", value="https://shop.example"))
        s.commit()

    async def fake_fetch(self):
        return [WooProduct(1, "Widget", "W1", D("20.00"))]  # feed only has woo_id 1
    monkeypatch.setattr("app.woocommerce.WooCommerceConnector.fetch_products", fake_fetch)

    body = c.post("/api/sync").json()
    assert body["synced"] == 1 and body["removed"] == 1
    with db.get_session() as s:
        assert {p.woo_id for p in s.exec(select(Product)).all()} == {1}


def test_settings_save_and_read(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.post("/api/settings", json={"woo_base_url": "https://shop.example",
        "woo_key": "ck", "woo_secret": "cs"})
    assert r.status_code == 200
    got = c.get("/api/settings").json()
    assert got["woo_base_url"] == "https://shop.example"
    # Secrets are never returned, only whether they're set.
    assert got["woo_key_set"] is True and "woo_key" not in got

def test_product_detail_shows_history(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    with db.get_session() as s:
        p = s.exec(select(Product)).first()
        comp = Competitor(name="Rival", config="{}")
        s.add(comp); s.commit(); s.refresh(comp)
        m = Mapping(product_id=p.id, competitor_id=comp.id,
                    identifier="https://r/w")
        s.add(m); s.commit(); s.refresh(m)
        s.add(PriceSnapshot(mapping_id=m.id, price=Decimal("18.00"), currency="AUD",
              in_stock=True, fetched_at=datetime.now(timezone.utc), status="ok"))
        s.commit()
        pid = p.id
    body = c.get(f"/api/products/{pid}").json()
    assert body["name"] == "Widget"
    assert body["histories"][0]["competitor_name"] == "Rival"
    assert body["histories"][0]["rows"][0]["price"] == "18.00"
    # Blocks are keyed by mapping id so two links to the same competitor
    # can't show each other's history.
    assert body["histories"][0]["mapping_id"] == body["mappings"][0]["id"]

def test_mapping_create_rejects_duplicate_url(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    with db.get_session() as s:
        pid = s.exec(select(Product)).first().id
        comp = Competitor(name="Rival", config="{}", site_url="https://rival.example")
        s.add(comp); s.commit()

    async def fake_run_tracking(session, *args, **kwargs):
        from app.engine import RunSummary
        return RunSummary(0, 0, 0)
    monkeypatch.setattr("app.routes.mappings.run_tracking", fake_run_tracking)

    body = {"product_id": pid, "identifier": "https://rival.example/products/widget"}
    assert c.post("/api/mappings", json=body).status_code == 201
    # Pasting the same URL again must not silently create a second row.
    assert c.post("/api/mappings", json=body).status_code == 409
    with db.get_session() as s:
        assert len(s.exec(select(Mapping)).all()) == 1


def test_sync_without_connected_store_is_a_clean_400(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.post("/api/sync")
    assert r.status_code == 400
    assert "Connect your store" in r.json()["detail"]


def test_spa_catch_all(tmp_path, monkeypatch):
    # The catch-all serves the built SPA when present; otherwise it returns a
    # 404 that explains how to build the frontend.
    from pathlib import Path
    c = _client(tmp_path, monkeypatch)
    r = c.get("/")
    dist_index = Path(__file__).resolve().parent.parent / "frontend" / "dist" / "index.html"
    if dist_index.is_file():
        assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    else:
        assert r.status_code == 404 and "bun run build" in r.json()["detail"]


def test_spa_never_serves_files_outside_dist():
    # A "../" path (which arrives URL-encoded past client normalisation) must
    # fall back to the SPA index, never leak files like the SQLite database.
    from fastapi import HTTPException
    from pathlib import Path
    from app.main import spa
    try:
        resp = spa("../pyproject.toml")
    except HTTPException as exc:
        assert exc.status_code == 404  # frontend not built — nothing leaks either
        return
    assert Path(resp.path).name == "index.html"
