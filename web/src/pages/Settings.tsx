// A slim store strip (connect once, sync now and then), then the page belongs
// to choosing what to track: filters on the left, the product table on the
// right, a save bar along the bottom.
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api, bumpData, type Settings as SettingsData, type TrackProduct } from "../api";
import { money, num, plural, timeAgo } from "../format";
import { RefreshIcon, SearchIcon } from "../components/ui";

type Note = { text: string; ok: boolean } | null;

export default function Settings() {
  const [s, { refetch }] = createResource(api.settings);
  const synced = () => (s()?.available_products.length ?? 0) > 0;

  return (
    <main class="settings-page">
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <div class="sub">Your store, and which of its products PriceBeat watches.</div>
        </div>
      </div>
      <Show when={s()} fallback={<div class="empty">Loading…</div>}>
        <Store settings={s()!} onChange={refetch} />
        <Show when={synced()}>
          <Track settings={s()!} onSaved={refetch} />
        </Show>
      </Show>
    </main>
  );
}

const NoteLine = (p: { note: Note }) => (
  <Show when={p.note}>{(n) => <div class="note" classList={{ ok: n().ok, err: !n().ok }}>{n().text}</div>}</Show>
);

const bareHost = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");

function Store(props: { settings: SettingsData; onChange: () => void }) {
  const st = () => props.settings;
  const connected = () => !!st().woo_base_url && st().woo_key_set && st().woo_secret_set;
  const count = () => st().available_products.length;
  const [editing, setEditing] = createSignal(!connected());
  const [url, setUrl] = createSignal(st().woo_base_url);
  const [others, setOthers] = createSignal(st().own_stores);
  const [key, setKey] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const [busy, setBusy] = createSignal<"" | "save" | "sync">("");
  const [note, setNote] = createSignal<Note>(null);

  async function act(kind: "save" | "sync", run: () => Promise<string>) {
    setBusy(kind);
    setNote(null);
    try {
      setNote({ text: await run(), ok: true });
    } catch (err) {
      setNote({ text: (err as Error).message, ok: false });
    } finally {
      setBusy("");
    }
  }

  const save = (e: Event) => {
    e.preventDefault();
    void act("save", async () => {
      await api.saveConnection({ woo_base_url: url(), woo_key: key(), woo_secret: secret(), own_stores: others() });
      setKey(""); setSecret("");
      props.onChange();
      setEditing(false);
      return count() ? "Store saved." : "Store saved. Sync to pull in your products.";
    });
  };

  const sync = () => act("sync", async () => {
    const r = await api.sync();
    props.onChange();
    bumpData();
    return `Synced ${plural(r.synced, "product")}${r.removed ? `, removed ${r.removed} no longer in the store` : ""}.`;
  });

  return (
    <div class="card store">
      <div class="store-strip">
        <span class="dot" classList={{ good: connected() }} />
        <div class="store-name">
          <b>{connected() ? bareHost(st().woo_base_url) : "No store connected"}</b>
          <span class="hint">
            {connected()
              ? count() ? `${plural(count(), "product")} · synced ${timeAgo(st().last_synced) ?? "never"}` : "Not synced yet"
              : "Add your WooCommerce store to get started"}
          </span>
        </div>
        <span class="spacer" />
        <Show when={connected()}>
          <button class="btn small" classList={{ primary: !count(), quiet: !!count() }} disabled={!!busy()} onClick={sync}>
            <RefreshIcon spinning={busy() === "sync"} />{busy() === "sync" ? "Syncing…" : "Sync now"}
          </button>
          <button class="btn quiet small" onClick={() => setEditing(!editing())}>{editing() ? "Close" : "Edit store"}</button>
        </Show>
      </div>

      <Show when={editing()}>
        <form class="store-form" onSubmit={save}>
          <div class="field"><label for="woo-url">Store URL</label>
            <input id="woo-url" class="input" type="url" required placeholder="https://yourstore.com.au"
              value={url()} onInput={(e) => setUrl(e.currentTarget.value)} /></div>
          <div class="row">
            <div class="field grow"><label for="woo-key">Consumer key</label>
              <input id="woo-key" class="input mono" type="password" autocomplete="off"
                placeholder={st().woo_key_set ? "Saved. Leave blank to keep" : "ck_…"} value={key()} onInput={(e) => setKey(e.currentTarget.value)} /></div>
            <div class="field grow"><label for="woo-secret">Consumer secret</label>
              <input id="woo-secret" class="input mono" type="password" autocomplete="off"
                placeholder={st().woo_secret_set ? "Saved. Leave blank to keep" : "cs_…"} value={secret()} onInput={(e) => setSecret(e.currentTarget.value)} /></div>
          </div>
          <p class="hint" style={{ "margin-top": 0 }}>
            WooCommerce → Settings → Advanced → REST API. Read access is enough. Saved keys stay on this computer and are never shown again.
          </p>
          <div class="field"><label for="own-stores">Your other stores <span class="muted">(optional)</span></label>
            <input id="own-stores" class="input" placeholder="giggear.com.au, another.com.au"
              value={others()} onInput={(e) => setOthers(e.currentTarget.value)} />
            <span class="hint">Find on Google leaves these out, like your own store.</span></div>
          <button class="btn primary" disabled={!!busy()}>{busy() === "save" ? "Saving…" : connected() ? "Save store" : "Connect"}</button>
        </form>
      </Show>

      <Show when={note()}><div class="store-note"><NoteLine note={note()} /></div></Show>
    </div>
  );
}


const PERIODS: [number, string][] = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "12 months"], [730, "2 years"]];
const periodLabel = (d: number) => PERIODS.find(([x]) => x === d)?.[1] ?? `${d} days`;

type Sort = "name" | "price" | "sold";
type View = "all" | "ticked" | "stopped";

function Track(props: { settings: SettingsData; onSaved: () => void }) {
  const st = props.settings;
  const [cats, setCats] = createSignal<string[]>(st.track_categories);
  const [brands, setBrands] = createSignal<string[]>(st.track_brands);
  const [prods, setProds] = createSignal<number[]>(st.track_products);
  // Stopped from a product's page (or here): never tracked, whatever is ticked.
  const [stopped, setStopped] = createSignal<number[]>(st.track_excluded);
  // Every row asks "is this ticked?"; a Set answers without a scan.
  const picked = createMemo(() => new Set(prods()));
  const off = createMemo(() => new Set(stopped()));
  const [q, setQ] = createSignal("");
  const [view, setView] = createSignal<View>("all");
  const [sort, setSort] = createSignal<Sort>("name");
  const [saving, setSaving] = createSignal(false);
  const [note, setNote] = createSignal<Note>(null);
  // Units sold per product id, once a top-seller pick has run.
  const [sold, setSold] = createSignal<Map<number, number> | null>(null);
  const [soldDays, setSoldDays] = createSignal(0);
  const [topN, setTopN] = createSignal(25);
  const [days, setDays] = createSignal(90);
  const [picking, setPicking] = createSignal(false);

  const same = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x) => b.includes(x));
  const dirty = () => !same(cats(), props.settings.track_categories) ||
    !same(brands(), props.settings.track_brands) || !same(prods(), props.settings.track_products) ||
    !same(stopped(), props.settings.track_excluded);

  const countBy = (pick: (p: TrackProduct) => string | null) => {
    const m = new Map<string, number>();
    for (const p of st.available_products) { const v = pick(p); if (v) m.set(v, (m.get(v) ?? 0) + 1); }
    return m;
  };
  const catCounts = countBy((p) => p.category), brandCounts = countBy((p) => p.brand);

  // Mirrors the server: brand/category pool, then product-level narrowing.
  const pool = createMemo(() => {
    const c = new Set(cats()), b = new Set(brands());
    return st.available_products.filter((p) =>
      (!c.size || c.has(p.category ?? "")) && (!b.size || b.has(p.brand ?? "")));
  });
  const pickedInPool = createMemo(() => pool().filter((p) => picked().has(p.id) && !off().has(p.id)).length);
  const stoppedInPool = createMemo(() => pool().filter((p) => off().has(p.id)).length);
  const tracked = () => (prods().length ? pickedInPool() : pool().length - stoppedInPool());
  const isOn = (id: number) => picked().has(id) && !off().has(id);

  const rows = createMemo(() => {
    const s = q().trim().toLowerCase();
    const v = view();
    const out = pool().filter((p) => (v === "all" || (v === "ticked" ? isOn(p.id) : off().has(p.id))) &&
      (!s || p.name.toLowerCase().includes(s) || (p.sku ?? "").toLowerCase().includes(s)));
    const n = sold();
    return out.sort(
      sort() === "sold" && n ? (a, b) => (n.get(b.id) ?? 0) - (n.get(a.id) ?? 0) || a.name.localeCompare(b.name)
      : sort() === "price" ? (a, b) => (num(b.price) ?? 0) - (num(a.price) ?? 0)
      : (a, b) => a.name.localeCompare(b.name));
  });
  const allOn = () => rows().length > 0 && rows().every((p) => isOn(p.id));
  const someOn = () => !allOn() && rows().some((p) => isOn(p.id));

  // Ticking a stopped product restores it; if you hand-pick, it gets ticked too.
  function toggleProduct(id: number) {
    if (off().has(id)) {
      setStopped(stopped().filter((x) => x !== id));
      if (prods().length && !picked().has(id)) setProds([...prods(), id]);
    } else {
      setProds(picked().has(id) ? prods().filter((x) => x !== id) : [...prods(), id]);
    }
  }

  function toggleAll() {
    const ids = new Set(rows().map((p) => p.id));
    if (allOn()) return setProds(prods().filter((id) => !ids.has(id)));
    setStopped(stopped().filter((id) => !ids.has(id)));
    setProds([...new Set([...prods(), ...ids])]);
  }

  // Ranks within the current category/brand pool, so "top 25 in Cases" works.
  async function pickTop() {
    setPicking(true);
    setNote(null);
    try {
      const sales = await api.sales(days());
      setSold(new Map(sales.map((r) => [r.id, r.sold])));
      setSoldDays(days());
      const inPool = new Set(pool().filter((p) => !off().has(p.id)).map((p) => p.id));
      const top = sales.filter((r) => inPool.has(r.id)).slice(0, topN()).map((r) => r.id);
      const when = periodLabel(days());
      if (!top.length) {
        setNote({ text: `Nothing here sold in the last ${when}. Selection unchanged.`, ok: false });
        return;
      }
      setProds(top);
      setSort("sold");
      setNote({ text: top.length < topN()
        ? `Only ${plural(top.length, "product")} sold in the last ${when}. Ticked all of them.`
        : `Ticked the top ${top.length} sellers from the last ${when}.`, ok: true });
    } catch (err) {
      setNote({ text: (err as Error).message, ok: false });
    } finally {
      setPicking(false);
    }
  }

  async function save() {
    setSaving(true);
    setNote(null);
    try {
      await api.saveTracking({ brands: brands(), categories: cats(), product_ids: prods(), excluded: stopped() });
      props.onSaved();
      bumpData();
      setNote({ text: "Saved. The product list now shows only what you track.", ok: true });
    } catch (err) {
      setNote({ text: (err as Error).message, ok: false });
    } finally {
      setSaving(false);
    }
  }

  function reset(c: string[], b: string[], p: number[], x: number[]) {
    setCats(c); setBrands(b); setProds(p); setStopped(x);
    setNote(null);
  }

  // "Cases · Pelican · 25 ticked"
  const scope = () => [
    cats().length && (cats().length === 1 ? cats()[0] : `${cats().length} categories`),
    brands().length && (brands().length === 1 ? brands()[0] : `${brands().length} brands`),
    prods().length && `${pickedInPool()} ticked`,
    stoppedInPool() && `${stoppedInPool()} stopped`,
  ].filter(Boolean).join(" · ") || "everything";

  const SortTh = (p: { key: Sort; label: string; num?: boolean }) => (
    <th class={p.num ? "num" : ""} aria-sort={sort() === p.key ? (p.key === "name" ? "ascending" : "descending") : undefined}>
      <button type="button" class="th-sort" classList={{ on: sort() === p.key }} onClick={() => setSort(p.key)}>{p.label}</button>
    </th>
  );

  return (
    <div class="card track">
      <div class="track-main">
        <aside class="track-filters" aria-label="Filters">
          <section class="quick-pick">
            <h3>Top sellers</h3>
            <div class="quick-row">
              <select class="input" aria-label="How many top sellers" value={topN()} onInput={(e) => setTopN(Number(e.currentTarget.value))}>
                <For each={[10, 25, 50, 100]}>{(n) => <option value={n}>Top {n}</option>}</For>
              </select>
              <select class="input" aria-label="Sales period" value={days()} onInput={(e) => setDays(Number(e.currentTarget.value))}>
                <For each={PERIODS}>{([d, label]) => <option value={d}>{label}</option>}</For>
              </select>
            </div>
            <button type="button" class="btn primary small" disabled={picking()} onClick={pickTop}>
              {picking() ? "Reading orders…" : "Tick top sellers"}
            </button>
            <span class="hint">Ranks the products in the table by units sold. Narrow with the filters below first if you like.</span>
          </section>

          <Show when={st.available_categories.length}>
            <Facet title="Categories" all={st.available_categories} get={cats} set={setCats} counts={catCounts} />
          </Show>
          <Show when={st.available_brands.length}>
            <Facet title="Brands" all={st.available_brands} get={brands} set={setBrands} counts={brandCounts} />
          </Show>
        </aside>

        <section class="track-table" aria-label="Products">
          <div class="track-toolbar">
            <div class="search">
              <SearchIcon />
              <input class="input" type="search" placeholder="Search name or SKU" aria-label="Search products"
                value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
            </div>
            <div class="chips" role="group" aria-label="Show">
              <button type="button" class="chip" aria-pressed={view() === "all"} onClick={() => setView("all")}>
                In filters <b>{pool().length}</b>
              </button>
              <button type="button" class="chip" aria-pressed={view() === "ticked"} onClick={() => setView("ticked")}>
                Ticked <b>{pickedInPool()}</b>
              </button>
              <Show when={stoppedInPool() || view() === "stopped"}>
                <button type="button" class="chip" aria-pressed={view() === "stopped"} onClick={() => setView("stopped")}>
                  Stopped <b>{stoppedInPool()}</b>
                </button>
              </Show>
            </div>
            <span class="spacer" />
            <Show when={prods().length}><button type="button" class="link-btn" onClick={() => setProds([])}>Untick all</button></Show>
          </div>

          <Show when={!prods().length && pool().length}>
            <div class="track-banner">
              Nothing ticked, so all {plural(pool().length - stoppedInPool(), "product")}{cats().length || brands().length ? " in these filters" : ""} are
              tracked. Tick products to track only those.
            </div>
          </Show>

          <div class="track-scroll">
            <table class="track-grid">
              <thead>
                <tr>
                  <th class="tick">
                    <input type="checkbox" aria-label="Tick all shown" checked={allOn()} ref={(el) => createEffect(() => { el.indeterminate = someOn(); })}
                      disabled={!rows().length} onChange={toggleAll} />
                  </th>
                  <SortTh key="name" label="Product" />
                  <th>Brand</th>
                  <th>SKU</th>
                  <SortTh key="price" label="Price" num />
                  <Show when={sold()}><SortTh key="sold" label={`Sold, ${periodLabel(soldDays())}`} num /></Show>
                </tr>
              </thead>
              <tbody>
                <For each={rows()} fallback={
                  <tr><td colSpan={6} class="empty">{
                    { all: "No products match.", ticked: "Nothing ticked here yet.", stopped: "No stopped products here." }[view()]}</td></tr>}>
                  {(p) => (
                    <tr classList={{ on: isOn(p.id), stopped: off().has(p.id) }} onClick={() => toggleProduct(p.id)}
                      title={off().has(p.id) ? "Stopped. Click to track it again." : undefined}>
                      <td class="tick">
                        <input type="checkbox" aria-label={`Track ${p.name}`} checked={isOn(p.id)}
                          onClick={(e) => e.stopPropagation()} onChange={() => toggleProduct(p.id)} />
                      </td>
                      <td class="fill">
                        <div class="name-cell">
                          <span class="truncate name" title={p.name}>{p.name}</span>
                          <Show when={off().has(p.id)}><span class="badge">Stopped</span></Show>
                        </div>
                      </td>
                      <td class="muted">{p.brand ?? "—"}</td>
                      <td class="muted sku">{p.sku ?? "—"}</td>
                      <td class="num">{money(p.price)}</td>
                      <Show when={sold()}>{(n) => <td class="num">{n().get(p.id) ?? <span class="muted">0</span>}</td>}</Show>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div class="savebar">
        <span>Tracking <b class="num" style={{ color: "var(--ink)" }}>{tracked()}</b> of {st.available_products.length}
          <span class="muted"> · {scope()}</span></span>
        <Show when={dirty()}><span class="badge warn">Unsaved</span></Show>
        <Show when={note()}>{(n) => <span class="savebar-note" classList={{ ok: n().ok, err: !n().ok }}>{n().text}</span>}</Show>
        <span class="spacer" />
        <Show when={cats().length || brands().length || prods().length || stopped().length}>
          <button class="btn quiet small" disabled={saving()} onClick={() => reset([], [], [], [])}>Track everything</button>
        </Show>
        <Show when={dirty()}>
          <button class="btn quiet small" disabled={saving()} onClick={() => reset(
            props.settings.track_categories, props.settings.track_brands, props.settings.track_products,
            props.settings.track_excluded)}>Discard</button>
        </Show>
        <button class="btn primary" disabled={saving() || !dirty()} onClick={save}>{saving() ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

/** A filter list: tick values to narrow the pool. A search box appears once
 *  the list is long enough to need one. */
function Facet(p: { title: string; all: string[]; get: () => string[]; set: (v: string[]) => void; counts: Map<string, number> }) {
  const [q, setQ] = createSignal("");
  const shown = () => {
    const s = q().trim().toLowerCase();
    return s ? p.all.filter((v) => v.toLowerCase().includes(s)) : p.all;
  };
  const on = (v: string) => p.get().includes(v);
  return (
    <section class="facet">
      <div class="facet-head">
        <h3>{p.title}</h3>
        <span class="hint">{p.get().length ? `${p.get().length} of ${p.all.length}` : "all"}</span>
        <span class="spacer" />
        <Show when={p.get().length}><button type="button" class="link-btn" onClick={() => p.set([])}>Clear</button></Show>
      </div>
      <Show when={p.all.length > 8}>
        <input class="input facet-search" type="search" placeholder={`Find ${p.title.toLowerCase()}`}
          aria-label={`Find ${p.title.toLowerCase()}`} value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      </Show>
      <div class="facet-list">
        <For each={shown()} fallback={<div class="hint">No match.</div>}>{(v) => (
          <label class="facet-opt" classList={{ on: on(v) }} title={v}>
            <input type="checkbox" checked={on(v)} onChange={() => p.set(on(v) ? p.get().filter((x) => x !== v) : [...p.get(), v])} />
            <span class="lbl">{v}</span><span class="n num">{p.counts.get(v) ?? 0}</span>
          </label>
        )}</For>
      </div>
    </section>
  );
}
