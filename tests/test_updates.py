import httpx2
import pytest
from app import updates


@pytest.fixture(autouse=True)
def _clear_cache():
    """The cached answer is module-global, so one test's release would
    otherwise be served to the next."""
    updates.reset_cache()
    yield
    updates.reset_cache()


def _client(response: httpx2.Response) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(
        transport=httpx2.MockTransport(lambda request: response))


def _release(tag: str, **extra) -> dict:
    return {"tag_name": tag, "html_url": "https://github.com/o/r/releases/v",
            "assets": [{"browser_download_url": f"https://x/PriceBeat-{tag}.zip"}],
            **extra}


@pytest.mark.parametrize("latest,current,expected", [
    ("0.2.0", "0.1.0", True),
    ("v0.2.0", "0.1.0", True),      # tags carry a "v" prefix
    ("0.1.0", "0.1.0", False),      # same version is not an update
    ("0.1.0", "0.2.0", False),      # never advertise a downgrade
    ("0.2", "0.1.9", True),         # different component counts
    ("0.2.1", "0.2", True),
    ("0.10.0", "0.9.0", True),      # numeric, not lexicographic
    ("nightly", "0.1.0", False),    # unparseable tag is ignored, not crashed on
    ("", "0.1.0", False),
])
def test_is_newer(latest, current, expected):
    assert updates.is_newer(latest, current) is expected


async def test_status_reports_available_update(monkeypatch):
    monkeypatch.setattr(updates, "__version__", "0.1.0")
    client = _client(httpx2.Response(200, json=_release("v0.3.0", body="Notes here")))
    result = await updates.status(client=client)
    assert result.update_available is True
    assert result.latest == "0.3.0" and result.current == "0.1.0"
    assert result.url == "https://x/PriceBeat-v0.3.0.zip"
    assert result.notes == "Notes here"


async def test_status_silent_when_up_to_date(monkeypatch):
    monkeypatch.setattr(updates, "__version__", "0.3.0")
    result = await updates.status(client=_client(
        httpx2.Response(200, json=_release("v0.3.0"))))
    assert result.update_available is False and result.notes == ""


async def test_status_falls_back_to_release_page_without_a_zip(monkeypatch):
    """A release published without its build attached still has to lead
    somewhere the user can act on."""
    monkeypatch.setattr(updates, "__version__", "0.1.0")
    release = _release("v0.2.0")
    release["assets"] = [{"browser_download_url": "https://x/notes.txt"}]
    result = await updates.status(client=_client(httpx2.Response(200, json=release)))
    assert result.url == "https://github.com/o/r/releases/v"


@pytest.mark.parametrize("response", [
    httpx2.Response(404, json={"message": "Not Found"}),   # no release published yet
    httpx2.Response(403, json={"message": "rate limit"}),
    httpx2.Response(200, text="<html>not json</html>"),    # captive portal
    httpx2.Response(200, json=["unexpected shape"]),
])
async def test_status_reports_no_update_on_any_failure(response):
    """A failed check must never reach the user — their prices still work."""
    result = await updates.status(client=_client(response))
    assert result.update_available is False and result.latest is None
    assert result.current == updates.__version__


async def test_status_survives_a_dead_network():
    def explode(request):
        raise httpx2.ConnectError("no route to host")
    client = httpx2.AsyncClient(transport=httpx2.MockTransport(explode))
    result = await updates.status(client=client)
    assert result.update_available is False


async def test_status_caches_so_launches_dont_hammer_github(monkeypatch):
    monkeypatch.setattr(updates, "__version__", "0.1.0")
    calls = []

    def handler(request):
        calls.append(request)
        return httpx2.Response(200, json=_release("v0.2.0"))

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    first = await updates.status(client=client)
    second = await updates.status(client=client)
    assert len(calls) == 1
    assert first == second
