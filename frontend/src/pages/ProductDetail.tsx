import { createResource, createSignal, For, Show } from "solid-js";
import { A, useParams } from "@solidjs/router";
import { api } from "../api";
import { belowRegularPct, dateTime, discountPct, gapPct, money, num, pct1, timeAgo } from "../format";
import Favicon from "../components/Favicon";
import FetchIcon from "../components/FetchIcon";
import ProductPicker from "../components/ProductPicker";
import Sparkline from "../components/Sparkline";

export default function ProductDetail() {
  const params = useParams();
  const [detail, { refetch }] = createResource(() => params.id, api.product);
  const [products] = createResource(api.products);
  const [identifier, setIdentifier] = createSignal("");
  const [trackingAll, setTrackingAll] = createSignal(false);
  // Mapping id currently being refetched, if any (per-competitor track).
  const [trackingId, setTrackingId] = createSignal<number | null>(null);
  const [error, setError] = createSignal("");
  const [showAdd, setShowAdd] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  // Mapping id whose "move to another product" picker is open, if any.
  const [reassigning, setReassigning] = createSignal<number | null>(null);

  async function trackAll() {
    setTrackingAll(true);
    try {
      await api.trackProduct(detail()!.id);
      await refetch();
    } finally {
      setTrackingAll(false);
    }
  }

  async function trackOne(id: number) {
    setTrackingId(id);
    try {
      await api.trackMapping(id);
      await refetch();
    } finally {
      setTrackingId(null);
    }
  }

  async function addMapping(e: Event) {
    e.preventDefault();
    setError("");
    setAdding(true);
    try {
      // The competitor is inferred server-side from the URL's host, and
      // auto-added (with its extraction method detected) if it's new. The
      // price is fetched immediately, so this can take a few seconds.
      await api.createMapping({ product_id: detail()!.id, identifier: identifier() });
      setIdentifier("");
      setShowAdd(false);
      await refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function removeMapping(id: number) {
    await api.deleteMapping(id);
    await refetch();
  }

  async function reassign(mappingId: number, productId: number) {
    await api.reassignMapping(mappingId, productId);
    setReassigning(null);
    await refetch(); // the mapping now belongs to another product, so it leaves this list
  }

  function openReassign(mappingId: number) {
    setReassigning(reassigning() === mappingId ? null : mappingId);
    // The editor renders below the table; bring it into view on long pages.
    requestAnimationFrame(() =>
      document.querySelector(".reassign-panel")?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      }),
    );
  }

  return (
    <Show when={detail()} fallback={<div class="empty">Loading…</div>}>
      {(d) => {
        const disc = () => discountPct(d().regular_price, d().own_price);
        const gap = () => gapPct(d().own_price, d().lowest_price);
        // Latest-first snapshot rows for one mapping, as a chronological
        // number series for the trend sparkline (failed fetches excluded).
        // Keyed by mapping id — two links on the same competitor site must
        // not show each other's history.
        const seriesFor = (mappingId: number) => {
          const block = d().histories.find((h) => h.mapping_id === mappingId);
          return (block?.rows ?? [])
            .filter((r) => r.status === "ok" && num(r.price) != null)
            .map((r) => num(r.price)!)
            .reverse();
        };
        return (
          <>
            <div class="page-head">
              <div>
                <A href="/" class="crumb">
                  <svg
                    class="crumb-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Products
                </A>
                <h1>{d().name}</h1>
                <div class="sub">
                  <Show when={d().sku} fallback="No SKU">SKU {d().sku}</Show>
                  <Show when={d().permalink}>
                    {" · "}
                    <a
                      class="ext-link"
                      href={d().permalink!}
                      target="_blank"
                      rel="noreferrer"
                    >
                      view on your store ↗
                    </a>
                  </Show>
                </div>
              </div>
              <button class="btn-primary" disabled={trackingAll()} onClick={trackAll}>
                <Show when={!trackingAll()}><FetchIcon /></Show>
                {trackingAll() ? "Fetching…" : "Fetch all"}
              </button>
            </div>

            {/* Competitive position at a glance — no scrolling needed. */}
            <div class="summary card">
              <div class="summary-cell">
                <div class="summary-label">Your price</div>
                <div class="summary-val price-now">
                  {money(d().own_price)}
                  <Show when={disc() != null}>
                    <span class="chip sale">{disc()}% off</span>
                  </Show>
                </div>
                <Show when={d().regular_price}>
                  <div class="summary-sub">
                    regular <span class="strike">{money(d().regular_price)}</span>
                  </div>
                </Show>
              </div>
              <div class="summary-cell">
                <div class="summary-label">Lowest rival</div>
                <div class="summary-val">
                  <Show when={d().has_data} fallback={<span class="muted">—</span>}>
                    {money(d().lowest_price)}
                    <div class="summary-sub">
                      {d().lowest_seller}
                      <Show when={belowRegularPct(d().regular_price, d().lowest_price) != null}>
                        {" · "}
                        <span class="below-rrp">
                          {belowRegularPct(d().regular_price, d().lowest_price)}% below RRP
                        </span>
                      </Show>
                    </div>
                  </Show>
                </div>
              </div>
              <div class="summary-cell">
                <div class="summary-label">Position</div>
                <div class="summary-val">
                  <Show
                    when={d().has_data}
                    fallback={<span class="badge neutral">no data</span>}
                  >
                    <Show
                      when={d().is_lowest}
                      fallback={
                        <span class="badge bad">
                          <span class="dot" />
                          {gap() != null ? `+${gap()}% higher` : `−${d().gap_to_lowest}`}
                        </span>
                      }
                    >
                      <span class="badge good"><span class="dot" />you're lowest</span>
                    </Show>
                  </Show>
                </div>
              </div>
              <div class="summary-cell">
                <div class="summary-label">Suggested</div>
                <div class="summary-val">
                  <Show
                    when={d().suggested_price}
                    fallback={<span class="muted">—</span>}
                  >
                    <span class="suggest">{money(d().suggested_price)}</span>
                  </Show>
                </div>
                <div class="summary-sub">
                  {d().suggested_price
                    ? "undercuts the lowest rival by 1%"
                    : d().has_data
                      ? "you're already lowest"
                      : "no competitor data yet"}
                </div>
              </div>
            </div>

            {/* Tracked competitors — the page's main object, full width. The
                add form tucks behind a toggle: paste a URL, the site is
                inferred from its host. */}
            <div class="card tight">
              <div class="card-head">
                <div class="card-title">Tracked competitors</div>
                <button class="btn-mini" onClick={() => setShowAdd(!showAdd())}>
                  {showAdd() ? "Close" : "+ Add competitor product"}
                </button>
              </div>
              <Show when={showAdd()}>
                <form onSubmit={addMapping} class="add-inline">
                  <input
                    type="text"
                    required
                    aria-label="Competitor product URL"
                    placeholder="Paste a competitor product URL — the site and price are detected automatically"
                    value={identifier()}
                    onInput={(e) => setIdentifier(e.currentTarget.value)}
                    disabled={adding()}
                  />
                  <button type="submit" class="btn-primary" disabled={adding()}>
                    {adding() ? "Adding…" : "Add"}
                  </button>
                  <Show when={error()}>
                    <span class="badge bad">{error()}</span>
                  </Show>
                </form>
              </Show>
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Competitor</th>
                      <th class="num">Their price</th>
                      <th class="num">vs you</th>
                      <th>Trend</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    <Show
                      when={d().mappings.length > 0}
                      fallback={
                        <tr>
                          <td colspan="5">
                            <div class="empty">
                              <div class="big">Nothing tracked yet</div>
                              Add a competitor's product to start comparing prices.
                            </div>
                          </td>
                        </tr>
                      }
                    >
                      <For each={d().mappings}>
                        {(m) => {
                          const series = () => seriesFor(m.id);
                          const latest = () =>
                            series().length ? series()[series().length - 1] : null;
                          const deltaPct = () => {
                            const own = num(d().own_price);
                            const t = latest();
                            if (own == null || own === 0 || t == null) return null;
                            return ((t - own) / own) * 100;
                          };
                          return (
                            <>
                              <tr>
                                <td class="prod-name">
                                  <span class="with-favicon">
                                    <Favicon src={m.favicon_url} name={m.competitor_name} />
                                    {m.competitor_name}
                                    <Show when={m.match_status === "verified"}>
                                      <span
                                        class="badge neutral"
                                        title="Same product confirmed via the seller's SKU/GTIN"
                                      >
                                        ✓ verified
                                      </span>
                                    </Show>
                                    <Show when={m.match_status === "review"}>
                                      <span
                                        class="badge warn"
                                        title="The seller's listing title doesn't look like this product — check the link"
                                      >
                                        <span class="dot" />check match
                                      </span>
                                    </Show>
                                  </span>
                                  {/* Prefer the seller's own listing title (their
                                      naming differs from ours); URL as fallback. */}
                                  <Show when={m.identifier}>
                                    <div class="prod-sub truncate">
                                      <a
                                        class="ext-link"
                                        href={m.identifier}
                                        target="_blank"
                                        rel="noreferrer"
                                        title={m.offer_title ?? m.identifier}
                                      >
                                        {m.offer_title ?? m.identifier.replace(/^https?:\/\//, "")} ↗
                                      </a>
                                    </div>
                                  </Show>
                                </td>
                                <td class="num">
                                  <Show when={latest() != null} fallback={<span class="muted">—</span>}>
                                    <span class="price-now">${latest()!.toFixed(2)}</span>
                                    <Show when={(num(m.shipping) ?? 0) > 0}>
                                      <div class="prod-sub">+{money(m.shipping)} shipping</div>
                                    </Show>
                                    <Show when={m.in_stock === false}>
                                      <div class="prod-sub">out of stock</div>
                                    </Show>
                                  </Show>
                                </td>
                                <td class="num">
                                  <Show when={deltaPct() != null} fallback={<span class="muted">—</span>}>
                                    <span
                                      class="delta"
                                      classList={{
                                        good: deltaPct()! > 0,
                                        bad: deltaPct()! < 0,
                                      }}
                                    >
                                      {deltaPct()! > 0 ? "+" : ""}
                                      {pct1(deltaPct()!)}%
                                    </span>
                                  </Show>
                                </td>
                                <td>
                                  <Sparkline points={series()} />
                                  <Show when={timeAgo(m.last_checked_at)}>
                                    <div
                                      class="prod-sub"
                                      title={`Re-checked about every ${Math.round(m.check_interval_hours)}h while prices are stable`}
                                    >
                                      checked {timeAgo(m.last_checked_at)}
                                    </div>
                                  </Show>
                                </td>
                                <td style={{ "text-align": "right", "white-space": "nowrap" }}>
                                  <button
                                    class="btn-mini"
                                    disabled={trackingId() === m.id}
                                    title="Fetch this competitor's price now"
                                    onClick={() => trackOne(m.id)}
                                  >
                                    <Show when={trackingId() !== m.id}><FetchIcon /></Show>
                                    {trackingId() === m.id ? "Fetching…" : "Fetch"}
                                  </button>{" "}
                                  <button
                                    class="btn-mini"
                                    onClick={() => openReassign(m.id)}
                                  >
                                    Change match
                                  </button>{" "}
                                  <button class="btn-danger" onClick={() => removeMapping(m.id)}>
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            </>
                          );
                        }}
                      </For>
                    </Show>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Reassign editor lives outside the table card: the searchable
                picker's dropdown must never be clipped by the card's overflow
                or the table's scroll container. */}
            <Show when={d().mappings.find((m) => m.id === reassigning())}>
              {(m) => (
                <div class="card reassign-panel">
                  <div class="reassign-row">
                    <span class="muted">
                      Move the <b>{m().competitor_name}</b> link to:
                    </span>
                    <ProductPicker
                      products={products() ?? []}
                      value={d().id}
                      onChange={(pid) => reassign(m().id, pid)}
                    />
                    <button class="btn-ghost" onClick={() => setReassigning(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Show>

            <h2>Price history</h2>
            <Show
              when={d().histories.length > 0}
              fallback={
                <div class="card">
                  <div class="empty">
                    No price history yet. Use <b>Fetch</b> on a competitor above.
                  </div>
                </div>
              }
            >
              <div class="history-grid">
                <For each={d().histories}>
                  {(block) => (
                    <div class="card tight history-card">
                      <div class="card-head sticky">
                        <div class="card-title">{block.competitor_name}</div>
                      </div>
                      <div class="history-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>When</th>
                              <th class="num">Price</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={block.rows}>
                              {(h) => (
                                <tr>
                                  <td class="muted">{dateTime(h.fetched_at)}</td>
                                  <td class="num">{h.price ?? "—"}</td>
                                  <td>
                                    <Show
                                      when={h.status === "ok"}
                                      fallback={
                                        <Show
                                          when={h.status === "blocked"}
                                          fallback={
                                            <span class="badge bad">
                                              <span class="dot" />
                                              {h.status}
                                            </span>
                                          }
                                        >
                                          <span class="badge warn"><span class="dot" />blocked</span>
                                        </Show>
                                      }
                                    >
                                      <span class="badge good"><span class="dot" />ok</span>
                                    </Show>
                                  </td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </>
        );
      }}
    </Show>
  );
}
