# PriceBeat

WooCommerce competitor price tracker. Python (FastAPI) backend + SolidJS SPA frontend.

- **Backend** (`app/`) — JSON API, price scraping, WooCommerce sync,
  price analysis, scheduler. SQLite storage.
- **Frontend** (`frontend/`) — SolidJS single-page app built with Bun + Vite,
  talking to the API under `/api`.

## Finding competitors

A product page's **Find on Google** button searches the web for shops selling
that product, reads each one's price, and grades every listing against your
product (SKU/GTIN first, title second — see `app/matcher.py`). You get a review
list with prices already filled in; ticking rows and confirming is what turns
them into tracked competitors. Your own store is excluded automatically, as are
social, video and review sites.

It needs no API key. Two things follow from that, both in `app/sources/search.py`:

- google.com/search renders results with JavaScript and returns an empty shell
  to any plain HTTP client, so the query goes through Startpage, which runs it
  against Google and returns server-rendered HTML. The results are Google's.
- Startpage geolocates by the requesting IP and ignores region parameters, so
  results are for wherever the app runs — there's no country setting to change.
  Heavy use eventually meets a CAPTCHA, which surfaces in the UI as a blocked
  search rather than an empty result list.

Swapping in a keyed SERP API (Serper.dev, SerpAPI) later means rewriting
`google_search()` in that one module; nothing else talks to the search engine.

## First-time setup

```bash
# Backend deps (into the venv)
.venv/Scripts/python -m pip install -e ".[dev]"

# Frontend deps
cd frontend && bun install
```

## Running

### Development (recommended)

```powershell
.\dev.ps1
```

Starts the API (uvicorn, auto-reload) and the Vite dev server together.
Open <http://localhost:5173> — edits to the SolidJS app hot-reload instantly.

### Single process (no hot reload)

```bash
cd frontend && bun run build && cd ..
.venv/Scripts/python -m uvicorn app.main:app
```

Serves the built UI + API from one process on <http://localhost:8000>.

### Desktop app

```powershell
.\build.ps1
```

Builds the frontend, packages everything with PyInstaller, and produces
`dist\PriceBeat\` (double-click `PriceBeat.exe`) plus a zip of the same folder.
Needs the desktop extra once: `.venv/Scripts/python -m pip install -e ".[desktop]"`.

The packaged app is the same FastAPI service in a background thread, shown in a
native window (WebView2, which ships with Windows 11). It binds a random
localhost port, so it never collides with a dev server.

To run it unpackaged: `.venv/Scripts/python -m app.desktop`.

It's a launch-and-check app — there's no background process while it's closed,
so on startup it sweeps whatever competitor prices came due since last time
(`CATCH_UP_ON_LAUNCH=1`, which `app/desktop.py` sets for you). Progress shows in
the UI like any other tracking run.

The build is unsigned, so Windows SmartScreen warns on first run.

### Update notifications

Nothing self-updates — the app is a folder you unpack, so the swap is manual.
What it does do is *notice*: on load the UI calls `/api/version`, which asks
GitHub for the latest release of `sai-giggear/pricebeat` and compares the tag
against `app/__init__.py`. If a newer one exists, a small badge appears in the
top bar linking to the download. Otherwise nothing is shown.

The check is best-effort by design (see `app/updates.py`): offline, rate-limited,
404 before the first release is published, and a malformed tag all resolve to
"no update", never to an error. A failed update check must not look like a
problem with price tracking. Answers are cached for 6 hours (5 minutes after a
failure), so repeated launches stay well under GitHub's 60-requests/hour limit
for unauthenticated callers.

## Releasing

1. Bump `__version__` in `app/__init__.py` — the only place the version lives.
   `pyproject.toml` reads it, `build.ps1` names the zip from it, and the update
   check compares against it.
2. `.\build.ps1` → `dist\PriceBeat-<version>.zip`.
3. Publish it, tagged with the same version:

   ```powershell
   gh release create v0.2.0 dist\PriceBeat-0.2.0.zip --notes "What changed"
   ```

The tag drives everything: existing installs compare it against their own
version, and the attached `.zip` is what the badge links to. A release with no
zip attached still works — the badge falls back to the release page.

The app icon is `assets/pricebeat.ico`, built from `assets/pricebeat.svg` — the
same swing-tag mark as the favicon in `frontend/index.html`. It's committed as a
source asset, so no SVG rasterizer is needed to build. To change the mark, edit
the SVG, render it to PNGs, and repack them into the `.ico` (Pillow's
`Image.save(..., format="ICO", sizes=[...])` does the packing).

## Configuration

Copy `.env.example` to `.env` to override defaults (database URL, scrape delay).
WooCommerce store URL and API keys are set in the app's **Settings** page.

The background scheduler runs an hourly sweep of due mappings. Set
`DISABLE_SCHEDULER=1` to turn it off (useful in dev).

### Where data lives

The database and the packaged app's `.env` default to `%LOCALAPPDATA%\PriceBeat\`
(`~/.local/share/PriceBeat` elsewhere) — an installed app can't write next to its
executable, and its working directory is wherever the shortcut points. Run from a
checkout, `.env` is still read from the repo root. `DATABASE_URL` overrides the
location either way.

## Tests

```bash
.venv/Scripts/python -m pytest
```
