from app.matcher import match_status, VERIFIED, LIKELY, REVIEW

def test_identifier_match_is_verified():
    # Punctuation/case differences in identifiers don't matter.
    assert match_status("Galaxy S26 Ultra 256GB", "SM-S948B",
                        ["sms948b", None, None], "whatever") == VERIFIED

def test_title_overlap_is_likely():
    assert match_status("Shure SM58 Vocal Microphone", None, [None],
                        "Shure SM58 Dynamic Vocal Mic") == LIKELY

def test_disjoint_model_codes_need_review():
    # Same family, wrong variant — the classic mismatch.
    assert match_status("Shure SM58 Vocal Microphone", None, [None],
                        "Shure SM57 Instrument Microphone") == REVIEW

def test_unrelated_title_needs_review():
    assert match_status("Fender Stratocaster Electric Guitar", None, [None],
                        "Yamaha P-125 Digital Piano") == REVIEW

def test_no_title_or_ids_is_unknown():
    assert match_status("Anything", "SKU1", [None, None, None], None) is None
