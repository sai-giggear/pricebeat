from decimal import Decimal
from app.money import parse_price

def test_parse_plain():
    assert parse_price("$1,299.00") == Decimal("1299.00")

def test_parse_with_label():
    assert parse_price("Now only AUD 49.95 inc GST") == Decimal("49.95")

def test_parse_thousands_without_comma():
    # Regression: prices >= 1000 with no comma separator must not be truncated.
    assert parse_price("$1500") == Decimal("1500")
    assert parse_price("$1234.56") == Decimal("1234.56")
    assert parse_price("1099") == Decimal("1099")

def test_parse_none():
    assert parse_price("Out of stock") is None
