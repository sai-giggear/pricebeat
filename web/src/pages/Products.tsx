// Split view: the catalogue on the left, the selected product on the right.
import { A, useParams } from "@solidjs/router";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api, dataVersion, job, running, type ProductRow } from "../api";
import { gapPct, money, num, pct1, plural } from "../format";
import { DownloadIcon, SearchIcon } from "../components/ui";
import Detail from "./Detail";

type Pos = "" | "lowest" | "beaten" | "nodata";
type Sort = "name" | "gap" | "price";

const posOf = (r: ProductRow): Pos => (!r.has_data ? "nodata" : r.is_lowest ? "lowest" : "beaten");

export default function Products() {
  const params = useParams();
  const [rows, { refetch }] = createResource(dataVersion, () => api.products());
  const [q, setQ] = createSignal("");
  const [pos, setPos] = createSignal<Pos>("");
  const [brand, setBrand] = createSignal("");
  const [category, setCategory] = createSignal("");
  const [sort, setSort] = createSignal<Sort>("name");

  const all = () => rows() ?? [];
  const counts = createMemo(() => {
    const c = { "": all().length, lowest: 0, beaten: 0, nodata: 0 };
    for (const r of all()) c[posOf(r)]++;
    return c;
  });
  const distinct = (pick: (r: ProductRow) => string | null) =>
    createMemo(() => [...new Set(all().map(pick).filter(Boolean) as string[])].sort());
  const brands = distinct((r) => r.brand);
  const categories = distinct((r) => r.category);

  const visible = createMemo(() => {
    const s = q().trim().toLowerCase();
    const out = all().filter((r) =>
      (!pos() || posOf(r) === pos()) &&
      (!brand() || r.brand === brand()) &&
      (!category() || r.category === category()) &&
      (!s || r.name.toLowerCase().includes(s) || (r.sku ?? "").toLowerCase().includes(s)));
    const gap = (r: ProductRow) => gapPct(r.own_price, r.lowest_price) ?? -Infinity;
    return out.sort(
      sort() === "gap" ? (a, b) => gap(b) - gap(a)
      : sort() === "price" ? (a, b) => num(b.own_price)! - num(a.own_price)!
      : (a, b) => a.name.localeCompare(b.name));
  });

  // Exactly what's on screen, filters and sort applied.
  function exportCsv() {
    const esc = (v: string | null | undefined) => {
      const s = v ?? "";
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ["Product", "SKU", "Brand", "Category", "Regular price", "Your price", "Lowest rival",
                  "Lowest seller", "Gap to lowest", "Position", "Suggested price"];
    const lines = visible().map((r) => [r.name, r.sku, r.brand, r.category, r.regular_price, r.own_price,
      r.has_data ? r.lowest_price : null, r.has_data ? r.lowest_seller : null, r.gap_to_lowest,
      { lowest: "lowest", beaten: "beaten", nodata: "no data", "": "" }[posOf(r)], r.suggested_price].map(esc).join(","));
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `pricebeat-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  }

  const chip = (value: Pos, label: string, dot?: string) => (
    <button type="button" class="chip" aria-pressed={pos() === value}
      onClick={() => setPos(pos() === value ? "" : value)}>
      <Show when={dot}><span class={`dot ${dot}`} /></Show>{label} <b>{counts()[value]}</b>
    </button>
  );

  const runNote = () => {
    const j = job();
    if (running() || !j) return null;
    if (j.state === "error") return { err: true, text: j.error ?? "Tracking run failed" };
    if (j.state === "done" && j.summary) {
      const s = j.summary;
      return { err: !!s.failures, text: `Checked ${plural(s.snapshots, "listing")}${s.failures ? `, ${s.failures} failed` : ""}` };
    }
    return null;
  };

  return (
    <div class="split" classList={{ "has-detail": !!params.id }}>
      <aside class="list-pane" aria-label="Products">
        <div class="list-tools">
          <div class="search">
            <SearchIcon />
            <input class="input" type="search" placeholder="Search name or SKU" aria-label="Search products"
              value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
          </div>
          <div class="chips" role="group" aria-label="Filter by position">
            {chip("", "All")}
            {chip("beaten", "Beaten", "bad")}
            {chip("lowest", "Lowest", "good")}
            {chip("nodata", "No data")}
          </div>
          <div class="list-filters">
            <Show when={brands().length > 1}>
              <select class="input" aria-label="Brand" value={brand()} onInput={(e) => setBrand(e.currentTarget.value)}>
                <option value="">All brands</option>
                <For each={brands()}>{(b) => <option>{b}</option>}</For>
              </select>
            </Show>
            <Show when={categories().length > 1}>
              <select class="input" aria-label="Category" value={category()} onInput={(e) => setCategory(e.currentTarget.value)}>
                <option value="">All categories</option>
                <For each={categories()}>{(c) => <option>{c}</option>}</For>
              </select>
            </Show>
            <select class="input" aria-label="Sort" value={sort()} onInput={(e) => setSort(e.currentTarget.value as Sort)}>
              <option value="name">A to Z</option>
              <option value="gap">Biggest gap</option>
              <option value="price">Highest price</option>
            </select>
          </div>
        </div>

        <ul class="list">
          <Show when={!rows.loading || rows()} fallback={<li class="empty">Loading…</li>}>
            <For each={visible()} fallback={
              <li class="empty">
                <Show when={all().length} fallback={<><div class="big">No products yet</div>Connect your store in <A href="/settings">Settings</A>.</>}>
                  Nothing matches these filters.
                </Show>
              </li>}>
              {(r) => {
                const gap = () => gapPct(r.own_price, r.lowest_price);
                return (
                  <li>
                    <A href={`/p/${r.id}`} class="item" classList={{ active: params.id === String(r.id) }}>
                      <span class={`dot ${r.has_data ? (r.is_lowest ? "good" : "bad") : ""}`}
                        title={r.has_data ? (r.is_lowest ? "You're lowest" : "A rival is cheaper") : "No rival prices yet"} />
                      <span class="name">{r.name}</span>
                      <span class="price num">{money(r.own_price)}</span>
                      <span class="meta">{[r.brand, r.sku].filter(Boolean).join(" · ") || " "}</span>
                      <span class="pos num" classList={{ good: r.has_data && r.is_lowest, bad: r.has_data && !r.is_lowest }}>
                        {!r.has_data ? <span class="muted">no data</span>
                          : r.is_lowest ? "lowest" : `+${pct1(gap() ?? 0)}%`}
                      </span>
                    </A>
                  </li>
                );
              }}
            </For>
          </Show>
        </ul>

        <div class="list-foot">
          <Show when={runNote()} fallback={<span>{plural(visible().length, "product")}</span>}>
            {(n) => <span style={{ color: n().err ? "var(--bad-ink)" : "var(--good-ink)" }}>{n().text}</span>}
          </Show>
          <span class="spacer" />
          <button class="btn quiet small" disabled={!visible().length} onClick={exportCsv}
            title="Download this list as CSV, with current filters and sort">
            <DownloadIcon />CSV
          </button>
        </div>
      </aside>

      <section class="detail-pane">
        <Show when={params.id} keyed fallback={<Overview rows={all()} counts={counts()} pick={(p) => setPos(p)} />}>
          {(id) => <Detail id={Number(id)} products={all()} onChange={refetch} />}
        </Show>
      </section>
    </div>
  );
}

function Overview(props: { rows: ProductRow[]; counts: Record<Pos, number>; pick: (p: Pos) => void }) {
  const worst = createMemo(() => props.rows.filter((r) => r.has_data && !r.is_lowest)
    .sort((a, b) => (gapPct(b.own_price, b.lowest_price) ?? 0) - (gapPct(a.own_price, a.lowest_price) ?? 0))
    .slice(0, 6));
  return (
    <div class="overview">
      <h1>Where your prices stand</h1>
      <p class="muted">Pick a product on the left to see its rivals and price history.</p>
      <div class="tiles">
        <button class="card tile button" onClick={() => props.pick("beaten")}>
          <div class="tile-label">A rival is cheaper</div>
          <div class="tile-value num" style={{ color: "var(--bad-ink)" }}>{props.counts.beaten}</div>
        </button>
        <button class="card tile button" onClick={() => props.pick("lowest")}>
          <div class="tile-label">You're the lowest</div>
          <div class="tile-value num" style={{ color: "var(--good-ink)" }}>{props.counts.lowest}</div>
        </button>
        <button class="card tile button" onClick={() => props.pick("nodata")}>
          <div class="tile-label">No rival prices yet</div>
          <div class="tile-value num">{props.counts.nodata}</div>
        </button>
      </div>
      <Show when={worst().length}>
        <div class="card">
          <div class="card-head"><h2>Biggest gaps</h2></div>
          <table>
            <thead><tr><th>Product</th><th class="num">You</th><th class="num">Lowest rival</th><th class="num">Gap</th></tr></thead>
            <tbody>
              <For each={worst()}>{(r) => (
                <tr>
                  <td><A href={`/p/${r.id}`} class="cell-title" style={{ "text-decoration": "none" }}>{r.name}</A>
                    <div class="cell-sub">{r.lowest_seller}</div></td>
                  <td class="num">{money(r.own_price)}</td>
                  <td class="num">{money(r.lowest_price)}</td>
                  <td class="num delta bad">+{pct1(gapPct(r.own_price, r.lowest_price) ?? 0)}%</td>
                </tr>
              )}</For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}
