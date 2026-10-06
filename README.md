# PriceBeat

WooCommerce competitor price tracker. It syncs your catalogue, reads rival
stores' prices on a schedule, and shows where each product stands: lowest,
beaten (and by how much), or no data yet.

Version 2 is a rewrite in TypeScript on Bun. One language and one toolchain
for the server, the web UI and the desktop app.

| Part | What it is |
|---|---|
| `server/` | HTTP API on `Bun.serve`, SQLite through `bun:sqlite`, scraping with Bun's built-in `HTMLRewriter` |
| `web/` | SolidJS single-page app, built with Vite |
| `desktop.ts` | The same server on a random localhost port, shown in a native WebView2 window (`@webviewjs/webview`) |
| `test/` | `bun test` suites |

## Setup

Needs [Bun](https://bun.sh) 1.4 or later.

```bash
bun install
```

## Running

| Command | What it does |
|---|---|
| `bun run dev` | API with auto-restart on :8000, plus Vite with hot reload. Open the URL Vite prints. |
| `bun run build && bun run start` | Built UI and API from one process on <http://127.0.0.1:8000> |
| `bun run desktop` | Desktop window from a checkout (run `bun run build` first) |
| `bun run package` | Portable app: `dist/PriceBeat/PriceBeat.exe` plus `dist/PriceBeat-<version>.zip` |
| `bun test` | Tests |
| `bun run typecheck` | TypeScript check across server, web and tests |

The packaged app is unsigned, so Windows SmartScreen warns on first run.
WebView2 ships with Windows 11.

## Your data

The database lives at `%LOCALAPPDATA%\PriceBeat\price_tracker.db`, the same
file version 1 used. Version 2 keeps the exact same tables, so it opens a 1.x
database as-is: products, competitors, tracked listings, history and store
keys all carry over. Set `DATABASE_PATH` to use a different file.

Store URL and WooCommerce API keys are entered in **Settings**. The keys stay
in the local database and the UI never shows them again once saved.

## How tracking works

- **Reading a price.** Shopify stores are read from their `/products/<handle>.js`
  JSON, which survives theme changes. Everything else is read from the page's
  schema.org JSON-LD, with a CSS selector as fallback. The method is detected
  when a store is first added (`server/scrape.ts`).
- **Match check.** Each listing is graded against your product: the seller's
  GTIN/MPN/SKU equal to your SKU is "verified", a close title is "likely", and
  anything else is flagged "check match" in the UI (`server/pricing.ts`).
- **Schedule.** An hourly sweep fetches only the listings that are due. Each
  listing's interval halves (down to 6h) when its price moves and grows 1.5x
  (up to 72h) while it holds. The desktop app also sweeps on launch, since it
  only runs while its window is open.
- **Politeness.** Different sites are fetched in parallel (8 at a time), but
  requests to the same site go one at a time with a 1 second gap.
- **History.** Snapshots older than 180 days are pruned. The newest one per
  listing is always kept.

## Finding competitors

**Find on Google** on a product page searches for shops selling it, reads each
one's price, and grades every listing. You review a list with prices filled
in; only the ones you tick become tracked. Your own store, social sites and
review sites are left out. Marketplaces stay in, since their sellers are who
you price against.

No API key is needed. Google returns an empty JavaScript shell to plain HTTP
clients, so the query goes through Startpage, which runs it against Google and
returns plain HTML. Two consequences:

- Results follow the region of the machine running PriceBeat. There is no
  region setting.
- Heavy use eventually meets a CAPTCHA. The UI then says the search was
  blocked, rather than showing an empty list.

Swapping in a keyed search API later means rewriting `googleSearch()` in
`server/discovery.ts`. Nothing else talks to the search engine.

## Configuration

Copy `.env.example` to `.env` to change defaults (database path, scrape delay,
parallelism, retention, port). Bun reads `.env` from the working directory;
plain environment variables work too.

## Update notifications

Nothing self-updates. On load the UI asks `/api/version`, which checks the
latest GitHub release of `sai-giggear/pricebeat` against `version` in
`package.json`. If a newer one exists, a badge in the top bar links to the
download. Offline, rate-limited, or no release published yet all count as
"no update", never as an error. Answers are cached for 6 hours (5 minutes
after a failure).

## Releasing

1. Bump `version` in `package.json`. It's the only copy: the server, the zip
   name and the update check all read it.
2. `bun run package`
3. Publish with the same tag:

   ```powershell
   gh release create v2.0.0 dist\PriceBeat-2.0.0.zip --notes "What changed"
   ```

## Brand assets

`assets/pricebeat.svg` is the mark: a white shop awning on an indigo tile. The
favicon is the same file at `web/public/icon.svg`. `assets/pricebeat.ico` (exe
icon) and `assets/icon.png` (window icon) are rendered from it and committed,
so building needs no image tools.
