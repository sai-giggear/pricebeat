import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import { api, type ProductRow, type TrackJob } from "../api";
import { belowRegularPct, discountPct, gapPct, money } from "../format";
import FetchIcon from "../components/FetchIcon";

type SortKey = "name" | "regular_price" | "own_price" | "lowest_price";
type PosFilter = "" | "lowest" | "beaten" | "untracked";

const NUM_COLS: SortKey[] = ["regular_price", "own_price", "lowest_price"];

export default function Products() {
  const [rows, { refetch }] = createResource(api.products);
  const [tracking, setTracking] = createSignal(false);
  const [job, setJob] = createSignal<TrackJob | null>(null);
  const [trackingId, setTrackingId] = createSignal<number | null>(null);
  const [query, setQuery] = createSignal("");
  const [brand, setBrand] = createSignal("");
  const [category, setCategory] = createSignal("");
  const [pos, setPos] = createSignal<PosFilter>("");
  const [sortKey, setSortKey] = createSignal<SortKey>("name");
  const [sortDir, setSortDir] = createSignal<"asc" | "desc">("asc");

  const matchesPos = (r: ProductRow, p: PosFilter) =>
    p === "" ||
    (p === "lowest" && r.has_data && r.is_lowest) ||
    (p === "beaten" && r.has_data && !r.is_lowest) ||
    (p === "untracked" && !r.has_data);

  // Clicking a tile filters the table to that slice; clicking it again clears.
  const togglePos = (p: PosFilter) => setPos(pos() === p ? "" : p);

  // Distinct, sorted filter options taken from whatever the data actually has —
  // so the brand dropdown simply won't appear for stores without brands.
  const distinct = (pick: (r: ProductRow) => string | null) =>
    createMemo(() =>
      [...new Set((rows() ?? []).map(pick).filter((v): v is string => !!v))].sort(),
    );
  const brands = distinct((r) => r.brand);
  const categories = distinct((r) => r.category);

  // At-a-glance counts across the whole catalogue (unaffected by filters).
  const stats = createMemo(() => {
    const all = rows() ?? [];
    const withData = all.filter((r) => r.has_data);
    return {
      total: all.length,
      winning: withData.filter((r) => r.is_lowest).length,
      beaten: withData.filter((r) => !r.is_lowest).length,
      untracked: all.filter((r) => !r.has_data).length,
    };
  });

  function toggleSort(key: SortKey) {
    if (sortKey() === key) {
      setSortDir(sortDir() === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  const arrow = (key: SortKey) =>
    sortKey() === key ? (sortDir() === "asc" ? "▲" : "▼") : "";

  // Reflect sort state to assistive tech on the <th> itself.
  const ariaSort = (key: SortKey): "ascending" | "descending" | "none" =>
    sortKey() === key ? (sortDir() === "asc" ? "ascending" : "descending") : "none";

  const visible = createMemo(() => {
    const q = query().trim().toLowerCase();
    const b = brand();
    const cat = category();
    let out = (rows() ?? []).filter((r) => {
      if (!matchesPos(r, pos())) return false;
      if (b && r.brand !== b) return false;
      if (cat && r.category !== cat) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) || (r.sku ?? "").toLowerCase().includes(q)
      );
    });

    const key = sortKey();
    const dir = sortDir() === "asc" ? 1 : -1;
    const numeric = NUM_COLS.includes(key);
    out = [...out].sort((a, b2) => {
      const av = a[key];
      const bv = b2[key];
      // Missing values always sink to the bottom regardless of direction.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = numeric
        ? Number(av) - Number(bv)
        : String(av).localeCompare(String(bv));
      return cmp * dir;
    });
    return out;
  });

  // A full run is a background job on the server, so the button follows its
  // progress by polling rather than holding one very long request open.
  async function followRun() {
    setTracking(true);
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const status = await api.trackStatus();
        setJob(status);
        if (status.state !== "running") break;
      }
      await refetch();
    } finally {
      setTracking(false);
    }
  }

  async function trackNow() {
    setTracking(true);
    setJob(null);
    try {
      setJob(await api.trackAll());
    } catch (err) {
      // 409 means a run (likely the hourly sweep) is already going — follow
      // that one instead of reporting a failure.
      const running = await api.trackStatus().catch(() => null);
      if (running?.state !== "running") {
        setJob({ state: "error", done: 0, total: 0, summary: null,
                 error: (err as Error).message });
        setTracking(false);
        return;
      }
    }
    await followRun();
  }

  // A run started before this page loaded (or by the scheduler) should still
  // show up here rather than looking idle.
  onMount(async () => {
    const status = await api.trackStatus().catch(() => null);
    if (status?.state === "running") {
      setJob(status);
      void followRun();
    }
  });

  const runLabel = () => {
    const j = job();
    if (!tracking()) return "Fetch all";
    return j && j.total ? `Fetching ${j.done}/${j.total}…` : "Fetching…";
  };

  async function trackOne(id: number) {
    setTrackingId(id);
    try {
      await api.trackProduct(id);
      await refetch();
    } finally {
      setTrackingId(null);
    }
  }

  // Download the table as CSV — exactly what's on screen, filters and sort
  // applied, so a filtered slice exports as that slice.
  function exportCsv() {
    const esc = (v: string | null | undefined) => {
      const s = v ?? "";
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      "Product", "SKU", "Brand", "Category", "Regular price", "Your price",
      "Lowest rival", "Lowest seller", "Gap to lowest", "Position", "Suggested price",
    ];
    const lines = visible().map((r) =>
      [
        r.name, r.sku, r.brand, r.category, r.regular_price, r.own_price,
        r.lowest_price, r.has_data ? r.lowest_seller : "", r.gap_to_lowest,
        r.has_data ? (r.is_lowest ? "lowest" : "beaten") : "no data",
        r.suggested_price,
      ].map(esc).join(","),
    );
    const csv = [header.map(esc).join(","), ...lines].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `pricebeat-products-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div class="page-head">
        <div>
          <h1>Products</h1>
          <div class="sub">Your catalogue and where it sits against competitors.</div>
        </div>
        <div class="head-actions">
          <button
            class="btn-ghost"
            disabled={visible().length === 0}
            title="Download the table below as CSV (current filters and sort applied)"
            onClick={exportCsv}
          >
            Export CSV
          </button>
          <button class="btn-primary" disabled={tracking()} onClick={trackNow}>
            <Show when={!tracking()}><FetchIcon /></Show>
            {runLabel()}
          </button>
        </div>
      </div>

      <Show when={!tracking() && job()?.state === "error"}>
        <div class="note err">{job()!.error ?? "Tracking run failed"}</div>
      </Show>
      <Show when={!tracking() && job()?.state === "done" && job()!.summary}>
        <div class="note" classList={{ ok: !job()!.summary!.failures,
                                       err: !!job()!.summary!.failures }}>
          Checked {job()!.summary!.snapshots} listing
          {job()!.summary!.snapshots === 1 ? "" : "s"} across{" "}
          {job()!.summary!.products} product
          {job()!.summary!.products === 1 ? "" : "s"}
          {job()!.summary!.failures ? `, ${job()!.summary!.failures} failed` : ""}.
        </div>
      </Show>

      {/* Each tile is a filter: click to see only that slice, click again to clear. */}
      <div class="statgrid">
        <button
          type="button"
          class="stat"
          classList={{ active: pos() === "" }}
          aria-pressed={pos() === ""}
          onClick={() => setPos("")}
        >
          <div class="stat-num">{stats().total}</div>
          <div class="stat-label">Products</div>
        </button>
        <button
          type="button"
          class="stat good"
          classList={{ active: pos() === "lowest" }}
          aria-pressed={pos() === "lowest"}
          onClick={() => togglePos("lowest")}
        >
          <div class="stat-num">{stats().winning}</div>
          <div class="stat-label">You're lowest</div>
        </button>
        <button
          type="button"
          class="stat bad"
          classList={{ active: pos() === "beaten" }}
          aria-pressed={pos() === "beaten"}
          onClick={() => togglePos("beaten")}
        >
          <div class="stat-num">{stats().beaten}</div>
          <div class="stat-label">Undercut by a rival</div>
        </button>
        <button
          type="button"
          class="stat"
          classList={{ active: pos() === "untracked" }}
          aria-pressed={pos() === "untracked"}
          onClick={() => togglePos("untracked")}
        >
          <div class="stat-num">{stats().untracked}</div>
          <div class="stat-label">No competitor data</div>
        </button>
      </div>

      <div class="filters">
        <div class="search">
          <input
            type="text"
            placeholder="Search products by name or SKU…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <Show when={brands().length > 0}>
          <div class="filter">
            <span class="filter-label">Brand</span>
            <select value={brand()} onInput={(e) => setBrand(e.currentTarget.value)}>
              <option value="">All brands</option>
              <For each={brands()}>{(b) => <option value={b}>{b}</option>}</For>
            </select>
          </div>
        </Show>
        <Show when={categories().length > 0}>
          <div class="filter">
            <span class="filter-label">Category</span>
            <select value={category()} onInput={(e) => setCategory(e.currentTarget.value)}>
              <option value="">All categories</option>
              <For each={categories()}>{(c) => <option value={c}>{c}</option>}</For>
            </select>
          </div>
        </Show>
      </div>

      <div class="card tight">
        <table class="products-table">
          <thead>
            <tr>
              <th class="sortable" aria-sort={ariaSort("name")}>
                <button type="button" class="sort-btn" onClick={() => toggleSort("name")}>
                  Product <span class="arrow" aria-hidden="true">{arrow("name")}</span>
                </button>
              </th>
              <th class="sortable num" aria-sort={ariaSort("regular_price")}>
                <button type="button" class="sort-btn" onClick={() => toggleSort("regular_price")}>
                  Regular <span class="arrow" aria-hidden="true">{arrow("regular_price")}</span>
                </button>
              </th>
              <th class="sortable num" aria-sort={ariaSort("own_price")}>
                <button type="button" class="sort-btn" onClick={() => toggleSort("own_price")}>
                  Your price <span class="arrow" aria-hidden="true">{arrow("own_price")}</span>
                </button>
              </th>
              <th class="sortable num" aria-sort={ariaSort("lowest_price")}>
                <button type="button" class="sort-btn" onClick={() => toggleSort("lowest_price")}>
                  Lowest rival <span class="arrow" aria-hidden="true">{arrow("lowest_price")}</span>
                </button>
              </th>
              <th class="num">Suggested</th>
              <th>Position</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <Show
              when={!rows.loading && visible().length > 0}
              fallback={
                <tr>
                  <td colspan="7">
                    <div class="empty">
                      <Show when={rows.loading} fallback={
                        <Show
                          when={(rows()?.length ?? 0) > 0}
                          fallback={
                            <>
                              <div class="big">No products yet</div>
                              Sync your catalogue from <A href="/settings">Settings</A> to get started.
                            </>
                          }
                        >
                          <div class="big">No matches</div>
                          Nothing matches your filters.
                        </Show>
                      }>
                        Loading…
                      </Show>
                    </div>
                  </td>
                </tr>
              }
            >
              <For each={visible()}>
                {(row) => {
                  const disc = discountPct(row.regular_price, row.own_price);
                  const gap = gapPct(row.own_price, row.lowest_price);
                  const rivalBelow = belowRegularPct(row.regular_price, row.lowest_price);
                  return (
                    <tr>
                      <td class="prod-name">
                        <A href={`/product/${row.id}`}>{row.name}</A>
                        <Show when={row.brand || row.sku}>
                          <div class="prod-sub">
                            {[row.brand, row.sku].filter(Boolean).join(" · ")}
                          </div>
                        </Show>
                      </td>
                      <td class="num">
                        <Show when={row.regular_price} fallback={<span class="muted">—</span>}>
                          <span class="strike muted">{money(row.regular_price)}</span>
                        </Show>
                      </td>
                      <td class="num">
                        <span class="price-now">{money(row.own_price)}</span>
                        <Show when={disc != null}>
                          <span class="chip sale">{disc}% off</span>
                        </Show>
                      </td>
                      <td class="num">
                        <Show when={row.has_data} fallback={<span class="muted">—</span>}>
                          {money(row.lowest_price)}
                          <div class="prod-sub num-sub">
                            {row.lowest_seller}
                            <Show when={rivalBelow != null}>
                              {" · "}
                              <span class="below-rrp">{rivalBelow}% below RRP</span>
                            </Show>
                          </div>
                        </Show>
                      </td>
                      <td class="num">
                        <Show
                          when={row.suggested_price}
                          fallback={<span class="muted">—</span>}
                        >
                          <span class="suggest" title="Undercuts the lowest rival by 1%">
                            {money(row.suggested_price)}
                          </span>
                        </Show>
                      </td>
                      <td>
                        <Show
                          when={row.has_data}
                          fallback={<span class="badge neutral">no data</span>}
                        >
                          <Show
                            when={row.is_lowest}
                            fallback={
                              <span class="badge bad">
                                <span class="dot" />
                                {gap != null ? `+${gap}% higher` : `−${row.gap_to_lowest}`}
                              </span>
                            }
                          >
                            <span class="badge good">
                              <span class="dot" />you're lowest
                            </span>
                          </Show>
                        </Show>
                      </td>
                      <td style={{ "text-align": "right" }}>
                        <button
                          class="btn-mini"
                          disabled={trackingId() === row.id}
                          title="Fetch this product's competitor prices now"
                          onClick={() => trackOne(row.id)}
                        >
                          <Show when={trackingId() !== row.id}><FetchIcon /></Show>
                          {trackingId() === row.id ? "Fetching…" : "Fetch"}
                        </button>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </Show>
          </tbody>
        </table>
      </div>
    </>
  );
}
