from datetime import datetime, timezone
from decimal import Decimal
import pytest
from app import discovery
from app.sources.base import PriceResult, PriceStatus
from app.sources.search import SearchHit

NOW = datetime.now(timezone.utc)


def _hit(url, title="Widget"):
    return SearchHit(url, title)


def _priced(price="18.00", **kw):
    return PriceResult(Decimal(price), "AUD", True, NOW, PriceStatus.OK, **kw)


def test_query_is_the_product_name_alone():
    # The Woo product name already carries the brand, so nothing is prepended.
    assert discovery.build_query("Acme Widget 3000") == "Acme Widget 3000"
    assert discovery.build_query("  Widget 3000  ") == "Widget 3000"


def test_shortlist_drops_own_store_socials_and_duplicate_sellers():
    hits = [_hit("https://mystore.example/p/widget"),      # ours
            _hit("https://www.mystore.example/p/other"),   # ours, www
            _hit("https://reddit.com/r/widgets/abc"),      # not a storefront
            _hit("https://www.youtube.com/watch?v=x"),     # not a storefront
            _hit("https://productreview.com.au/p/widget"), # reviews, not sales
            _hit("https://rival.example/widget?utm_source=g"),
            _hit("https://rival.example/widget-again"),    # same seller
            _hit("https://shop2.example/w")]
    picked = discovery._shortlist(hits, {"mystore.example"}, limit=10)
    assert [url for url, _, _ in picked] == ["https://rival.example/widget",
                                             "https://shop2.example/w"]


def test_shortlist_stops_at_the_limit():
    hits = [_hit(f"https://shop{i}.example/w") for i in range(20)]
    assert len(discovery._shortlist(hits, set(), limit=10)) == 10


def _stub_search(monkeypatch, hits):
    async def fake(query, limit=20):
        return hits
    monkeypatch.setattr("app.discovery.google_search", fake)


async def test_discover_prices_and_grades_each_listing(monkeypatch):
    _stub_search(monkeypatch, [_hit("https://rival.example/widget", "Rival's title")])

    async def fake_probe(url, client):
        return ({"favicon_url": "https://rival.example/f.png"},
                _priced(title="Acme Widget 3000", sku="W1"))
    monkeypatch.setattr("app.discovery._probe", fake_probe)

    (c,) = await discovery.discover("Acme Widget 3000", "W1", query="widget",
                                    own_hosts=set(), tracked=set())
    assert c.host == "rival.example" and c.price == Decimal("18.00")
    # The seller's own SKU matches ours, so the match is verified, not guessed.
    assert c.match_status == "verified" and c.suggested is True
    # The seller's listing title wins over Google's snippet title.
    assert c.title == "Acme Widget 3000"
    assert c.favicon_url == "https://rival.example/f.png"


async def test_discover_reports_an_unreadable_listing_instead_of_failing(monkeypatch):
    _stub_search(monkeypatch, [_hit("https://dead.example/w"),
                               _hit("https://rival.example/w")])

    async def fake_probe(url, client):
        if "dead" in url:
            raise RuntimeError("timeout")
        return ({}, _priced(title="Widget"))
    monkeypatch.setattr("app.discovery._probe", fake_probe)

    # Priced results sort ahead of dead ends, so one unreachable site can't
    # bury the sellers worth looking at.
    alive, dead = await discovery.discover("Widget", None, query="widget",
                                           own_hosts=set(), tracked=set())
    assert dead.host == "dead.example"
    assert dead.price is None and "timeout" in dead.error and dead.suggested is False
    assert alive.price == Decimal("18.00")


async def test_already_tracked_listings_are_shown_but_never_pre_ticked(monkeypatch):
    _stub_search(monkeypatch, [_hit("https://rival.example/w")])

    async def fake_probe(url, client):
        return ({}, _priced(title="Widget", sku="W1"))
    monkeypatch.setattr("app.discovery._probe", fake_probe)

    (c,) = await discovery.discover("Widget", "W1", query="widget", own_hosts=set(),
                                    tracked={"https://rival.example/w"})
    assert c.already_tracked is True and c.suggested is False


async def test_a_listing_with_no_price_is_never_pre_ticked(monkeypatch):
    _stub_search(monkeypatch, [_hit("https://blogless.example/w")])

    async def fake_probe(url, client):
        return ({}, PriceResult(None, "AUD", False, NOW, PriceStatus.FAILED,
                                "no JSON-LD or selector price found"))
    monkeypatch.setattr("app.discovery._probe", fake_probe)

    (c,) = await discovery.discover("Widget", "W1", query="widget", own_hosts=set(),
                                    tracked=set())
    assert c.price is None and c.suggested is False
    assert c.error == "no JSON-LD or selector price found"


async def test_no_usable_results_returns_an_empty_list(monkeypatch):
    _stub_search(monkeypatch, [_hit("https://mystore.example/w")])

    async def fake_probe(url, client):
        raise AssertionError("own store must never be probed")
    monkeypatch.setattr("app.discovery._probe", fake_probe)

    assert await discovery.discover("Widget", None, query="widget",
                                    own_hosts={"mystore.example"},
                                    tracked=set()) == []
