"""Verify that a competitor listing really is the same product as ours.

Sellers name products differently and use their own SKUs, so matching is
identifier-first (the BuyWisely approach):

  1. GTIN/MPN/SKU from the seller's structured data equals our SKU -> verified.
     Identifiers are compared with punctuation stripped ("SM-S948B" == "sms948b").
  2. Otherwise score the seller's title against our product name. Tokens that
     carry digits (model codes like "sm-s948b", "fp-e50") are the strongest
     signal a title can give.
  3. Weak overlap -> "review": shown in the UI so a wrong link gets caught
     instead of silently driving a bad repricing suggestion.
"""
from __future__ import annotations
import re

VERIFIED = "verified"
LIKELY = "likely"
REVIEW = "review"

_STOP = {"the", "a", "an", "and", "with", "for", "of", "in", "to", "by", "new"}


def _norm_id(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _tokens(text: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", text.lower())
            if len(t) > 1 and t not in _STOP}


def match_status(product_name: str, product_sku: str | None,
                 offer_ids: list[str | None], offer_title: str | None) -> str | None:
    """None means "nothing to judge with" (no identifiers and no title)."""
    ids = {_norm_id(i) for i in offer_ids if i}
    if product_sku and _norm_id(product_sku) in ids:
        return VERIFIED
    if not offer_title:
        return None
    ours, theirs = _tokens(product_name), _tokens(offer_title)
    if not ours:
        return None
    # Model codes must agree when both sides have them: matching codes confirm,
    # disjoint codes are the classic wrong-variant mistake.
    our_codes = {t for t in ours if any(c.isdigit() for c in t)}
    their_codes = {t for t in theirs if any(c.isdigit() for c in t)}
    if our_codes and their_codes and not (our_codes & their_codes):
        return REVIEW
    overlap = len(ours & theirs) / len(ours)
    return LIKELY if overlap >= 0.45 or (our_codes & their_codes) else REVIEW
