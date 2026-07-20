from pathlib import Path
from decimal import Decimal
import httpx2
from app.sources.scraper import AutoSource
from app.sources.base import PriceStatus

HTML = (Path(__file__).parent / "fixtures" / "scraper_simple.html").read_text()
JSONLD_HTML = (Path(__file__).parent / "fixtures" / "scraper_jsonld.html").read_text()


def _client(response: httpx2.Response) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(transport=httpx2.MockTransport(lambda req: response))


async def test_fetch_extracts_full_offer():
    src = AutoSource(client=_client(httpx2.Response(200, text=JSONLD_HTML)))
    r = await src.fetch("https://rival/pro")
    assert r.status == PriceStatus.OK and r.price == Decimal("149.00")
    assert r.title == "Acme Widget Pro 2000 (Black) AW-2000B"
    assert r.brand == "Acme" and r.sku == "ACME-AW2000B"
    assert r.gtin == "9312345678907" and r.mpn == "AW-2000B"
    assert r.shipping == Decimal("9.95")
    assert r.stock_status == "InStock" and r.condition == "NewCondition"
    assert r.in_stock is True


async def test_fetch_ok():
    src = AutoSource(price_selector="span.price",
                     client=_client(httpx2.Response(200, text=HTML)))
    r = await src.fetch("https://rival/widget")
    assert r.status == PriceStatus.OK and r.price == Decimal("18.50")


async def test_fetch_blocked():
    src = AutoSource(price_selector="span.price",
                     client=_client(httpx2.Response(403)))
    r = await src.fetch("https://rival/x")
    assert r.status == PriceStatus.BLOCKED


async def test_fetch_selector_missing():
    src = AutoSource(price_selector="span.price",
                     client=_client(httpx2.Response(200, text="<html></html>")))
    r = await src.fetch("https://rival/y")
    assert r.status == PriceStatus.FAILED
