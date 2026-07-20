import pytest
from app.sources.search import (SearchBlocked, _refused, google_search,
                                parse_results)

# The results layout: each organic hit is an <a class="result-title"> whose
# heading carries the seller's page title. Trimmed from a live response.
RESULTS = """
<html><body>
  <div class="result">
    <a class="result-title" href="https://rival.example/product/widget?srsltid=AfmB0x">
      <h2>Widget 3000 — Rival</h2></a>
    <a class="favicon-link" href="https://rival.example/product/widget"></a>
  </div>
  <div class="result">
    <a class="result-title" href="https://shop2.example/w"><h2>Widget | Shop2</h2></a>
  </div>
  <a href="https://www.startpage.com/do/settings">Settings</a>
  <div class="result">
    <a class="result-title" href="https://rival.example/product/widget?srsltid=AfmB0x">
      <h2>Widget 3000 — Rival</h2></a>
  </div>
</body></html>
"""

# A markup change that drops the result-title class still parses via headings.
UNCLASSED = """
<html><body>
  <div><a href="https://rival.example/w"><h3>Widget — Rival</h3></a></div>
  <div><a href="https://shop2.example/w"><h3>Widget | Shop2</h3></a></div>
</body></html>
"""


def test_parses_results_and_drops_the_engines_own_links():
    hits = parse_results(RESULTS)
    # The duplicate third result collapses into the first.
    assert [h.url for h in hits] == [
        "https://rival.example/product/widget?srsltid=AfmB0x",
        "https://shop2.example/w"]
    assert hits[0].title == "Widget 3000 — Rival"


def test_falls_back_to_heading_links_when_the_markup_changes():
    hits = parse_results(UNCLASSED)
    assert [h.url for h in hits] == ["https://rival.example/w",
                                     "https://shop2.example/w"]
    assert hits[1].title == "Widget | Shop2"


def test_parses_nothing_from_an_empty_page():
    assert parse_results("<html><body>no results</body></html>") == []


@pytest.mark.parametrize("status, html", [
    (429, "<html>slow down</html>"),
    (503, "<html></html>"),
    (403, "<html></html>"),
    (200, "<html><body>Our systems have detected unusual traffic</body></html>"),
    (200, "<html><body>Our system thinks you might be a robot</body></html>"),
])
def test_recognises_a_refusal(status, html):
    assert _refused(status, html) is True


def test_a_normal_results_page_is_not_a_refusal():
    assert _refused(200, RESULTS) is False


async def test_blocked_search_raises_rather_than_returning_nothing(monkeypatch):
    # "Google said no" and "nobody sells this" must never look the same.
    class FakeResponse:
        status_code = 429
        text = "<html>sorry</html>"

    class FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def get(self, *a, **kw): return FakeResponse()

    monkeypatch.setattr("httpx2.AsyncClient", lambda *a, **kw: FakeClient())
    with pytest.raises(SearchBlocked):
        await google_search("widget")
