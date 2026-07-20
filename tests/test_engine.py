import asyncio
import time
import pytest
from decimal import Decimal
from datetime import datetime, timedelta, timezone
from sqlmodel import select
from app import db
from app import engine as engine_mod
from app.models import Product, Competitor, Mapping, PriceSnapshot
from app.engine import prune_snapshots, run_tracking
from app.sources.base import PriceResult, PriceStatus

class FakeSource:
    def __init__(self, result): self.result = result
    async def fetch(self, identifier): return self.result

def _seed(s):
    p = Product(woo_id=1, name="Widget", sku="W1", own_price=Decimal("20.00"),
                updated_at=datetime.now(timezone.utc))
    c = Competitor(name="Rival", config="{}")
    s.add(p); s.add(c); s.commit(); s.refresh(p); s.refresh(c)
    s.add(Mapping(product_id=p.id, competitor_id=c.id,
                  identifier="https://r/w"))
    s.commit()

async def test_run_records_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    ok = PriceResult(Decimal("18.00"), "AUD", True, datetime.now(timezone.utc), PriceStatus.OK)
    with db.get_session() as s:
        _seed(s)
        summary = await run_tracking(s, source_factory=lambda comp, client=None: FakeSource(ok))
        assert summary.snapshots == 1 and summary.products == 1
        assert len(s.exec(select(PriceSnapshot)).all()) == 1

async def test_offer_metadata_and_match_stamped_on_mapping(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    ok = PriceResult(Decimal("18.00"), "AUD", True, datetime.now(timezone.utc),
                     PriceStatus.OK, title="Rival Widget W1 Deluxe", sku="W1",
                     shipping=Decimal("5.00"), stock_status="InStock")
    with db.get_session() as s:
        _seed(s)
        await run_tracking(s, source_factory=lambda comp, client=None: FakeSource(ok))
        m = s.exec(select(Mapping)).one()
        assert m.title == "Rival Widget W1 Deluxe"
        assert m.match_status == "verified"  # our SKU W1 == their SKU
        assert m.last_checked_at is not None
        snap = s.exec(select(PriceSnapshot)).one()
        assert snap.shipping == Decimal("5.00") and snap.stock_status == "InStock"

async def test_adaptive_interval_and_due_only(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    now = datetime.now(timezone.utc)
    with db.get_session() as s:
        _seed(s)
        # First fetch: no previous price, interval stays at the 24h default.
        r1 = PriceResult(Decimal("18.00"), "AUD", True, now, PriceStatus.OK)
        await run_tracking(s, source_factory=lambda comp, client=None: FakeSource(r1))
        m = s.exec(select(Mapping)).one()
        assert m.check_interval_hours == 24.0
        # Just checked -> a due-only sweep (the scheduler's mode) skips it.
        summary = await run_tracking(s, source_factory=lambda comp, client=None: FakeSource(r1),
                                     due_only=True)
        assert summary.snapshots == 0
        # Price moved -> the interval tightens; stable -> it backs off.
        r2 = PriceResult(Decimal("17.00"), "AUD", True, now, PriceStatus.OK)
        await run_tracking(s, source_factory=lambda comp, client=None: FakeSource(r2))
        m = s.exec(select(Mapping)).one()
        assert m.check_interval_hours == 12.0
        await run_tracking(s, source_factory=lambda comp, client=None: FakeSource(r2))
        m = s.exec(select(Mapping)).one()
        assert m.check_interval_hours == 18.0

async def test_source_failure_is_isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    class Boom:
        async def fetch(self, identifier): raise RuntimeError("network dead")
    with db.get_session() as s:
        _seed(s)
        summary = await run_tracking(s, source_factory=lambda comp, client=None: Boom())
        assert summary.failures == 1
        snap = s.exec(select(PriceSnapshot)).one()
        assert snap.status == PriceStatus.FAILED

async def test_hosts_are_fetched_in_parallel(tmp_path, monkeypatch):
    """Two competitors on different hosts must not wait on each other's delay."""
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    monkeypatch.setattr(engine_mod.settings, "scrape_delay_seconds", 0.2)
    db.init_db()

    class Slow:
        async def fetch(self, identifier):
            await asyncio.sleep(0.2)
            return PriceResult(Decimal("18.00"), "AUD", True,
                               datetime.now(timezone.utc), PriceStatus.OK)

    with db.get_session() as s:
        p = Product(woo_id=1, name="Widget", sku="W1", own_price=Decimal("20.00"),
                    updated_at=datetime.now(timezone.utc))
        s.add(p); s.commit(); s.refresh(p)
        for host in ("a.example", "b.example", "c.example", "d.example"):
            c = Competitor(name=host, config="{}")
            s.add(c); s.commit(); s.refresh(c)
            s.add(Mapping(product_id=p.id, competitor_id=c.id,
                          identifier=f"https://{host}/w"))
        s.commit()

        started = time.monotonic()
        summary = await run_tracking(s, source_factory=lambda comp, client=None: Slow())
        elapsed = time.monotonic() - started

    assert summary.snapshots == 4
    # Serially this would be 4 × 0.2s of fetching plus three 0.2s delays; run in
    # parallel the hosts overlap and none of them delays another.
    assert elapsed < 0.6

async def test_same_host_requests_are_spaced_out(tmp_path, monkeypatch):
    """Politeness still applies within a host: its URLs go one at a time."""
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    monkeypatch.setattr(engine_mod.settings, "scrape_delay_seconds", 0.2)
    db.init_db()
    ok = PriceResult(Decimal("18.00"), "AUD", True, datetime.now(timezone.utc),
                     PriceStatus.OK)
    with db.get_session() as s:
        p = Product(woo_id=1, name="Widget", sku="W1", own_price=Decimal("20.00"),
                    updated_at=datetime.now(timezone.utc))
        c = Competitor(name="Rival", config="{}")
        s.add(p); s.add(c); s.commit(); s.refresh(p); s.refresh(c)
        for n in range(3):
            s.add(Mapping(product_id=p.id, competitor_id=c.id,
                          identifier=f"https://rival.example/w{n}"))
        s.commit()

        started = time.monotonic()
        summary = await run_tracking(
            s, source_factory=lambda comp, client=None: FakeSource(ok))
        elapsed = time.monotonic() - started

    assert summary.snapshots == 3
    assert elapsed >= 0.4  # two gaps between three same-host requests

async def test_consumer_failure_does_not_hang_the_run(tmp_path, monkeypatch):
    """A dead consumer must stop the fetchers, not leave them blocked on a
    queue nobody drains."""
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    ok = PriceResult(Decimal("18.00"), "AUD", True, datetime.now(timezone.utc),
                     PriceStatus.OK)

    async def boom(session, queue, total, progress):
        # Die only after the fetchers are running and have filled the queue —
        # that's the state where an un-cancelled producer blocks forever.
        while not queue.full():
            await asyncio.sleep(0.01)
        raise RuntimeError("consumer died")
    monkeypatch.setattr(engine_mod, "_consume", boom)

    with db.get_session() as s:
        p = Product(woo_id=1, name="Widget", sku="W1", own_price=Decimal("20.00"),
                    updated_at=datetime.now(timezone.utc))
        c = Competitor(name="Rival", config="{}")
        s.add(p); s.add(c); s.commit(); s.refresh(p); s.refresh(c)
        # More mappings than the queue holds, so producers would fill and block.
        for n in range(engine_mod.COMMIT_EVERY * 3):
            s.add(Mapping(product_id=p.id, competitor_id=c.id,
                          identifier=f"https://a{n}.example/w"))
        s.commit()

        with pytest.raises(RuntimeError, match="consumer died"):
            # A hang here (rather than the error surfacing) is the bug.
            await asyncio.wait_for(
                run_tracking(s, source_factory=lambda comp, client=None: FakeSource(ok)),
                timeout=3)

async def test_progress_is_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    ok = PriceResult(Decimal("18.00"), "AUD", True, datetime.now(timezone.utc),
                     PriceStatus.OK)
    seen = []
    with db.get_session() as s:
        _seed(s)
        await run_tracking(s, source_factory=lambda comp, client=None: FakeSource(ok),
                           progress=lambda done, total: seen.append((done, total)))
    # The total is reported before the first fetch so the UI can show 0/N
    # immediately, then once per applied result.
    assert seen == [(0, 1), (1, 1)]

async def test_prune_keeps_newest_snapshot_per_mapping(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    now = datetime.now(timezone.utc)
    with db.get_session() as s:
        _seed(s)
        m = s.exec(select(Mapping)).one()
        # All three are past the retention window. The oldest is the only
        # successful one, so it has to survive as the mapping's current price,
        # and the newest survives as its last known state.
        s.add(PriceSnapshot(mapping_id=m.id, price=Decimal("9.00"), currency="AUD",
                            in_stock=True, fetched_at=now - timedelta(days=400),
                            status="ok"))
        s.add(PriceSnapshot(mapping_id=m.id, price=None, currency="AUD",
                            in_stock=False, fetched_at=now - timedelta(days=390),
                            status="failed"))
        s.add(PriceSnapshot(mapping_id=m.id, price=None, currency="AUD",
                            in_stock=False, fetched_at=now - timedelta(days=200),
                            status="failed"))
        s.commit()

        removed = prune_snapshots(s, retention_days=180)
        kept = s.exec(select(PriceSnapshot)).all()

    assert removed == 1  # only the middle failed row is expendable
    assert sorted(k.status for k in kept) == ["failed", "ok"]

async def test_prune_disabled_by_zero_retention(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    with db.get_session() as s:
        _seed(s)
        m = s.exec(select(Mapping)).one()
        s.add(PriceSnapshot(mapping_id=m.id, price=Decimal("9.00"), currency="AUD",
                            in_stock=True,
                            fetched_at=datetime.now(timezone.utc) - timedelta(days=999),
                            status="ok"))
        s.commit()
        assert prune_snapshots(s, retention_days=0) == 0
        assert len(s.exec(select(PriceSnapshot)).all()) == 1
