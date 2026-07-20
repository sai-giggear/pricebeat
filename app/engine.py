from __future__ import annotations
import asyncio
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
import httpx2
from sqlalchemy import delete, func
from sqlmodel import select
from app.config import settings
from app.matcher import match_status
from app.models import Product, Competitor, Mapping, PriceSnapshot
from app.sources.base import HEADERS, build_source, PriceResult, PriceStatus
from app.track_filter import filter_active

# Adaptive re-crawl bounds: halve the interval while the price is moving,
# back off 1.5x while it's stable (BuyWisely-style freshness model).
MIN_INTERVAL_HOURS = 6.0
MAX_INTERVAL_HOURS = 72.0

# Results are committed in batches: often enough that a crash mid-run keeps
# nearly everything, rarely enough that commits aren't the bottleneck.
COMMIT_EVERY = 25

@dataclass
class RunSummary:
    products: int   # products that had at least one mapping fetched
    snapshots: int
    failures: int

def _is_due(m: Mapping, now: datetime) -> bool:
    if m.last_checked_at is None:
        return True
    last = m.last_checked_at
    if last.tzinfo is None:  # SQLite returns naive datetimes
        last = last.replace(tzinfo=timezone.utc)
    return now >= last + timedelta(hours=m.check_interval_hours or 24.0)

def _latest_ok_price(session, mapping_id):
    snap = session.exec(
        select(PriceSnapshot)
        .where(PriceSnapshot.mapping_id == mapping_id, PriceSnapshot.status == "ok")
        .order_by(PriceSnapshot.fetched_at.desc(), PriceSnapshot.id.desc())).first()
    return snap.price if snap else None

def _apply_result(session, product: Product, m: Mapping, result: PriceResult) -> None:
    """Record the snapshot and update the mapping's offer metadata, match
    verdict and next-check interval."""
    prev_price = _latest_ok_price(session, m.id)
    session.add(PriceSnapshot(
        mapping_id=m.id, price=result.price, currency=result.currency,
        in_stock=result.in_stock, fetched_at=result.fetched_at,
        status=result.status, error_reason=result.error_reason,
        shipping=result.shipping, stock_status=result.stock_status,
        condition=result.condition))
    m.last_checked_at = result.fetched_at
    if result.status != PriceStatus.OK or result.price is None:
        session.add(m)
        return
    # Keep the seller's own listing data on the mapping (only overwrite with
    # real values, so a selector-only fetch doesn't blank JSON-LD fields).
    for field in ("title", "brand", "sku", "gtin", "mpn"):
        value = getattr(result, field)
        if value:
            setattr(m, field, value)
    m.match_status = match_status(product.name, product.sku,
                                  [m.sku, m.gtin, m.mpn], m.title)
    interval = m.check_interval_hours or 24.0
    if prev_price is not None:
        m.check_interval_hours = (
            max(MIN_INTERVAL_HOURS, interval / 2) if result.price != prev_price
            else min(MAX_INTERVAL_HOURS, interval * 1.5))
    session.add(m)

# ---- planning --------------------------------------------------------------

def _host(url: str) -> str:
    return urlparse(url or "").netloc.lower()

def _collect(session, product_ids, mapping_ids, due_only) -> list[tuple[Product, Mapping]]:
    """The (product, mapping) pairs this run should fetch. Narrowed in SQL, so
    a single-product or single-mapping run doesn't load the whole catalogue."""
    q = select(Product, Mapping).join(Mapping, Mapping.product_id == Product.id)
    if mapping_ids is not None:
        q = q.where(Mapping.id.in_(list(mapping_ids)))
    elif product_ids is not None:
        q = q.where(Product.id.in_(list(product_ids)))
    pairs = list(session.exec(q).all())
    if mapping_ids is None and product_ids is None:
        # Bulk runs only track the brands/categories the user has kept active.
        active = {p.id for p in filter_active(session, [p for p, _ in pairs])}
        pairs = [(p, m) for p, m in pairs if p.id in active]
    if due_only:
        # Scheduled runs skip anything checked recently; each mapping's own
        # interval (tight for volatile prices, long for stable ones) decides.
        now = datetime.now(timezone.utc)
        pairs = [(p, m) for p, m in pairs if _is_due(m, now)]
    return pairs

def _plan(session, pairs):
    """Group the work by competitor host, resolving everything the fetchers
    need up front so no DB access happens while requests are in flight."""
    by_host: dict[str, list] = defaultdict(list)
    competitors: dict[int, Competitor] = {}
    for product, mapping in pairs:
        if mapping.competitor_id not in competitors:
            competitors[mapping.competitor_id] = session.get(
                Competitor, mapping.competitor_id)
        by_host[_host(mapping.identifier)].append(
            (product.id, mapping.id, mapping.identifier, mapping.competitor_id))
    return by_host, competitors

# ---- run -------------------------------------------------------------------

async def _consume(session, queue, total, progress) -> tuple[int, int]:
    """The only coroutine that touches the session: applies fetched results in
    arrival order and commits in batches."""
    snapshots = failures = 0
    while True:
        item = await queue.get()
        if item is None:  # producers finished
            break
        product_id, mapping_id, result = item
        product = session.get(Product, product_id)
        mapping = session.get(Mapping, mapping_id)
        if product is None or mapping is None:
            continue  # deleted while the run was in flight
        try:
            _apply_result(session, product, mapping, result)
        except Exception:
            session.rollback()  # drop this batch, keep the run going
            continue
        snapshots += 1
        if result.status != PriceStatus.OK or result.price is None:
            failures += 1
        if snapshots % COMMIT_EVERY == 0:
            session.commit()
        if progress is not None:
            progress(snapshots, total)
    session.commit()
    return snapshots, failures

async def run_tracking(session, source_factory=build_source, product_ids=None,
                       mapping_ids=None, due_only=False, progress=None) -> RunSummary:
    """Fetch competitor prices and record a snapshot per mapping.

    Hosts are fetched in parallel while each host's own URLs go one at a time
    with ``scrape_delay_seconds`` between them — so being polite to one
    competitor no longer throttles every other competitor in the run. Every
    fetch shares one connection pool, and a single consumer applies the results
    to the session (which is neither async nor thread-safe).

    ``progress(done, total)`` is called after each applied result, if given.
    """
    pairs = _collect(session, product_ids, mapping_ids, due_only)
    product_count = len({p.id for p, _ in pairs})
    if not pairs:
        return RunSummary(product_count, 0, 0)
    by_host, competitors = _plan(session, pairs)

    total = len(pairs)
    if progress is not None:
        progress(0, total)  # report the total before the first fetch lands
    hosts = max(1, settings.max_concurrent_hosts)
    delay = max(0.0, settings.scrape_delay_seconds)
    queue: asyncio.Queue = asyncio.Queue(maxsize=COMMIT_EVERY * 2)
    limit = asyncio.Semaphore(hosts)

    async with httpx2.AsyncClient(
            timeout=20, follow_redirects=True, headers=HEADERS,
            limits=httpx2.Limits(max_connections=hosts * 2)) as client:
        # One source per competitor, built before any fetching starts: the
        # fetchers then never touch an ORM object (whose attributes would
        # expire on the consumer's commits).
        sources = {cid: source_factory(comp, client=client)
                   for cid, comp in competitors.items()}

        async def fetch_host(items):
            async with limit:
                for i, (product_id, mapping_id, identifier, cid) in enumerate(items):
                    if i and delay:
                        await asyncio.sleep(delay)
                    try:
                        result = await sources[cid].fetch(identifier)
                    except Exception as exc:  # isolate any source failure
                        result = PriceResult(None, "AUD", False,
                                             datetime.now(timezone.utc),
                                             PriceStatus.FAILED, str(exc))
                    await queue.put((product_id, mapping_id, result))

        async def produce():
            """Fetch everything, then close the queue with a sentinel so the
            consumer stops even if fewer results arrived than planned."""
            try:
                await asyncio.gather(*(fetch_host(i) for i in by_host.values()))
            except asyncio.CancelledError:
                # The consumer is already gone, so nothing will drain the queue
                # — a sentinel here would block on it forever.
                raise
            except BaseException:
                await queue.put(None)  # let the consumer finish, then report
                raise
            else:
                await queue.put(None)

        producers = asyncio.ensure_future(produce())
        try:
            snapshots, failures = await _consume(session, queue, total, progress)
        except BaseException:
            # Nothing will drain the queue now, so the fetchers would block on
            # it forever; stop them before propagating.
            producers.cancel()
            await asyncio.gather(producers, return_exceptions=True)
            raise
        await producers  # surface producer errors once results are saved
    return RunSummary(product_count, snapshots, failures)

# ---- retention -------------------------------------------------------------

def prune_snapshots(session, retention_days: int | None = None) -> int:
    """Drop price history older than the retention window. The newest snapshot
    per mapping — and the newest successful one, which drives current prices —
    is always kept, however old it is. Returns the number of rows deleted."""
    days = settings.snapshot_retention_days if retention_days is None else retention_days
    if days <= 0:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    newest = (select(func.max(PriceSnapshot.id))
              .group_by(PriceSnapshot.mapping_id).scalar_subquery())
    newest_ok = (select(func.max(PriceSnapshot.id))
                 .where(PriceSnapshot.status == "ok")
                 .group_by(PriceSnapshot.mapping_id).scalar_subquery())
    result = session.execute(
        delete(PriceSnapshot).where(PriceSnapshot.fetched_at < cutoff,
                                    PriceSnapshot.id.not_in(newest),
                                    PriceSnapshot.id.not_in(newest_ok)))
    session.commit()
    return result.rowcount or 0

# ---- background runs -------------------------------------------------------

def background_run(due_only: bool = False):
    """Build the ``run(progress)`` callable ``jobs.start`` expects: a full sweep
    plus a prune, on its own session. Used by the /api/track route and by the
    catch-up sweep the desktop app fires at launch."""
    from app import db  # deferred: app.db imports the models this module defines against

    async def run(progress):
        with db.get_session() as session:
            summary = await run_tracking(session, due_only=due_only, progress=progress)
            prune_snapshots(session)
        return asdict(summary)
    return run
