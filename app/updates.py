"""Notice when a newer PriceBeat has been released.

The app ships as a zip the user unpacks, so nothing here updates anything — it
only spots a newer release and points at the download. The swap stays manual.

Everything in this module is best-effort: a user with no internet, a rate limit,
a renamed repo and a malformed tag all have to end up as "no update known",
never as an error the user sees. An update check failing is not a problem with
their price tracking.
"""
from __future__ import annotations
import re
import time
from dataclasses import dataclass
import httpx2
from app import __version__

OWNER_REPO = "sai-giggear/pricebeat"
LATEST_RELEASE_API = f"https://api.github.com/repos/{OWNER_REPO}/releases/latest"
RELEASES_PAGE = f"https://github.com/{OWNER_REPO}/releases/latest"

TIMEOUT_SECONDS = 6.0
# Unauthenticated GitHub allows 60 requests/hour/IP. One check per launch is
# already well under that; the cache covers dev reloads and page refreshes.
CACHE_SECONDS = 6 * 3600
# Being offline is the ordinary case for a shop laptop, not an anomaly worth
# retrying hard — but short enough that reconnecting doesn't need a restart.
FAILURE_CACHE_SECONDS = 300


@dataclass(frozen=True)
class UpdateStatus:
    """What the UI needs to render (or, usually, not render) the badge."""
    current: str
    latest: str | None
    update_available: bool
    url: str
    notes: str


def _parts(text: str) -> tuple[int, ...]:
    """The numeric core of a version: "v1.2.0" and "1.2" become (1, 2, 0) and
    (1, 2). Anything after the digits is dropped rather than ranked — we don't
    publish prereleases, and inventing an ordering for tags we never make would
    be guessing. Unparseable returns () , which compares as "not newer".
    """
    match = re.match(r"v?(\d+(?:\.\d+)*)", text.strip())
    return tuple(int(n) for n in match.group(1).split(".")) if match else ()


def is_newer(latest: str, current: str) -> bool:
    """True only when `latest` is a version we can read and it beats `current`."""
    latest_parts = _parts(latest)
    return bool(latest_parts) and latest_parts > _parts(current)


def _download_url(release: dict) -> str:
    """The zip attached to the release, else the release page.

    A release published without its build attached should still send the user
    somewhere useful instead of nowhere.
    """
    for asset in release.get("assets") or []:
        url = asset.get("browser_download_url") or ""
        if url.endswith(".zip"):
            return url
    return release.get("html_url") or RELEASES_PAGE


async def _fetch_latest(client: httpx2.AsyncClient | None) -> dict | None:
    owned = client is None
    client = client or httpx2.AsyncClient(timeout=TIMEOUT_SECONDS,
                                          follow_redirects=True)
    try:
        response = await client.get(LATEST_RELEASE_API,
                                    headers={"Accept": "application/vnd.github+json"})
        response.raise_for_status()
        release = response.json()
        return release if isinstance(release, dict) else None
    except Exception:
        # Offline, DNS failure, rate limit, 404 before the first release is
        # published, HTML error page where JSON was expected — all the same
        # answer, and none of them worth a traceback in a price tracker.
        return None
    finally:
        if owned:
            await client.aclose()


def _no_update() -> UpdateStatus:
    return UpdateStatus(current=__version__, latest=None, update_available=False,
                        url=RELEASES_PAGE, notes="")


_cached: UpdateStatus | None = None
_cached_at: float = 0.0


def _cache_valid(now: float) -> bool:
    ttl = CACHE_SECONDS if _cached and _cached.latest else FAILURE_CACHE_SECONDS
    return _cached is not None and now - _cached_at < ttl


async def status(client: httpx2.AsyncClient | None = None) -> UpdateStatus:
    """Current version, and the newer one if there is a newer one."""
    global _cached, _cached_at
    now = time.monotonic()
    if _cache_valid(now):
        return _cached

    release = await _fetch_latest(client)
    if release is None:
        result = _no_update()
    else:
        tag = (release.get("tag_name") or "").strip()
        newer = bool(tag) and is_newer(tag, __version__)
        result = UpdateStatus(
            current=__version__,
            latest=tag.lstrip("v") or None,
            update_available=newer,
            url=_download_url(release) if newer else RELEASES_PAGE,
            notes=(release.get("body") or "").strip() if newer else "")
    _cached, _cached_at = result, now
    return result


def reset_cache() -> None:
    """Drop the cached answer. For tests — the module-level cache would
    otherwise leak one test's mocked release into the next."""
    global _cached, _cached_at
    _cached, _cached_at = None, 0.0
