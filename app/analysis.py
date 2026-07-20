from __future__ import annotations
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP

@dataclass
class SuggestionRule:
    mode: str            # "match" | "undercut"
    amount: Decimal
    amount_type: str     # "percent" | "fixed"
    floor: Decimal

@dataclass
class CompetitorPrice:
    name: str
    price: Decimal

# Single source of truth for the v1 default suggestion rule (undercut lowest by
# 1%, floor 0.01). Settings-driven per-product rules can override this later.
DEFAULT_RULE = SuggestionRule(mode="undercut", amount=Decimal("1"),
                              amount_type="percent", floor=Decimal("0.01"))

@dataclass
class ProductAnalysis:
    own_price: Decimal
    lowest_price: Decimal | None
    lowest_seller: str
    gap_to_lowest: Decimal | None
    is_lowest: bool
    suggested_price: Decimal | None

def _q(v: Decimal) -> Decimal:
    return v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

def _suggest(comp_lowest: Decimal, rule: SuggestionRule) -> Decimal:
    if rule.mode == "match":
        target = comp_lowest
    elif rule.amount_type == "percent":
        target = comp_lowest * (Decimal("1") - rule.amount / Decimal("100"))
    else:
        target = comp_lowest - rule.amount
    return _q(max(target, rule.floor))

def analyze(own_price, competitors, rule) -> ProductAnalysis:
    if not competitors:
        return ProductAnalysis(own_price, None, "you", None, True, None)
    comp_lowest = min(c.price for c in competitors)
    if own_price <= comp_lowest:
        return ProductAnalysis(own_price, own_price, "you", Decimal("0"), True, None)
    winner = min(competitors, key=lambda c: c.price)
    return ProductAnalysis(
        own_price, comp_lowest, winner.name,
        _q(own_price - comp_lowest), False, _suggest(comp_lowest, rule))
