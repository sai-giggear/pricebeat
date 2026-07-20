from decimal import Decimal
from app.analysis import analyze, SuggestionRule, CompetitorPrice as CP

RULE = SuggestionRule(mode="undercut", amount=Decimal("1"),
                      amount_type="percent", floor=Decimal("15.00"))

def test_you_are_lowest():
    a = analyze(Decimal("10.00"), [CP("Rival", Decimal("12.00"))], RULE)
    assert a.is_lowest and a.lowest_seller == "you" and a.gap_to_lowest == Decimal("0")

def test_competitor_lowest_and_suggestion_undercuts():
    a = analyze(Decimal("20.00"), [CP("Rival", Decimal("18.00"))], RULE)
    assert not a.is_lowest and a.lowest_seller == "Rival"
    assert a.gap_to_lowest == Decimal("2.00")
    assert a.suggested_price == Decimal("17.82")  # 18.00 - 1%

def test_suggestion_respects_floor():
    # 15.10 - 1% = 14.949, below the 15.00 floor, so the floor clamps it up.
    a = analyze(Decimal("20.00"), [CP("Rival", Decimal("15.10"))], RULE)
    assert a.suggested_price == Decimal("15.00")  # floor binds, not 14.949

def test_no_competitors():
    a = analyze(Decimal("20.00"), [], RULE)
    assert a.lowest_price is None and a.is_lowest and a.suggested_price is None
