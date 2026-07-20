import re
from decimal import Decimal, InvalidOperation

# Match a full run of digits/commas, preferring one with a decimal part.
# Ordered so "1234.56" and "1500" are matched whole (not truncated to the
# first 1-3 digits, which the old grouped pattern did for comma-less >= 1000).
_PRICE_RE = re.compile(r"\d[\d,]*\.\d+|\d[\d,]*")

def parse_price(text: str) -> Decimal | None:
    if not text:
        return None
    match = _PRICE_RE.search(text.replace("\xa0", " "))
    if not match:
        return None
    try:
        return Decimal(match.group(0).replace(",", ""))
    except InvalidOperation:
        return None
