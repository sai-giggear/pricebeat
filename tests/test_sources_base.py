from decimal import Decimal
from datetime import datetime, timezone
from app.sources.base import PriceResult, PriceStatus

def test_price_result_ok():
    r = PriceResult(price=Decimal("9.99"), currency="AUD", in_stock=True,
                    fetched_at=datetime.now(timezone.utc), status=PriceStatus.OK)
    assert r.status == "ok" and r.error_reason is None

def test_price_result_failed():
    r = PriceResult(price=None, currency="AUD", in_stock=False,
                    fetched_at=datetime.now(timezone.utc),
                    status=PriceStatus.FAILED, error_reason="timeout")
    assert r.price is None and r.error_reason == "timeout"
