// Three steps: connect the store, sync the catalogue, choose what to track.
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api, bumpData, type Settings as SettingsData, type TrackProduct } from "../api";
import { plural } from "../format";
import { RefreshIcon } from "../components/ui";

type Note = { text: string; ok: boolean } | null;

export default function Settings() {
  const [s, { refetch }] = createResource(api.settings);
  const connected = () => !!s()?.woo_base_url && !!s()?.woo_key_set && !!s()?.woo_secret_set;
  const synced = () => (s()?.available_products.length ?? 0) > 0;

  return (
    <main class="page">
      <div class="page-inner">
        <div class="page-head">
          <div>
            <h1>Settings</h1>
            <div class="sub">Connect your WooCommerce store, pull in your products, choose what to watch.</div>
          </div>
        </div>
        <Show when={s()} fallback={<div class="empty">Loading…</div>}>
          <div class="steps">
            <Connect done={connected()} url={s()!.woo_base_url} keySet={s()!.woo_key_set} secretSet={s()!.woo_secret_set} onSaved={refetch} />
            <Sync done={synced()} enabled={connected()} count={s()!.available_products.length} onSynced={refetch} />
            <Show when={synced()}>
              <Track settings={s()!} onSaved={refetch} />
            </Show>
          </div>
        </Show>
      </div>
    </main>
  );
}

const Step = (p: { n: number; done: boolean; title: string }) => (
  <div class="row" style={{ "margin-bottom": "12px" }}>
    <span class="step-num" classList={{ done: p.done }}>{p.done ? "✓" : p.n}</span>
    <h2>{p.title}</h2>
  </div>
);

const NoteLine = (p: { note: Note }) => (
  <Show when={p.note}>{(n) => <div class="note" classList={{ ok: n().ok, err: !n().ok }} style={{ "margin-top": "12px" }}>{n().text}</div>}</Show>
);

function Connect(props: { done: boolean; url: string; keySet: boolean; secretSet: boolean; onSaved: () => void }) {
  const [url, setUrl] = createSignal(props.url);
  const [key, setKey] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [note, setNote] = createSignal<Note>(null);
  async function save(e: Event) {
    e.preventDefault();
    setSaving(true);
    setNote(null);
    try {
      await api.saveConnection({ woo_base_url: url(), woo_key: key(), woo_secret: secret() });
      setKey(""); setSecret("");
      props.onSaved();
      setNote({ text: "Saved.", ok: true });
    } catch (err) {
      setNote({ text: (err as Error).message, ok: false });
    } finally {
      setSaving(false);
    }
  }
  return (
    <form class="card card-pad" onSubmit={save}>
      <Step n={1} done={props.done} title="Connect your store" />
      <div class="field"><label for="woo-url">Store URL</label>
        <input id="woo-url" class="input" type="url" required placeholder="https://yourstore.com.au"
          value={url()} onInput={(e) => setUrl(e.currentTarget.value)} /></div>
      <div class="row">
        <div class="field grow"><label for="woo-key">Consumer key</label>
          <input id="woo-key" class="input mono" type="password" autocomplete="off"
            placeholder={props.keySet ? "Saved. Leave blank to keep" : "ck_…"} value={key()} onInput={(e) => setKey(e.currentTarget.value)} /></div>
        <div class="field grow"><label for="woo-secret">Consumer secret</label>
          <input id="woo-secret" class="input mono" type="password" autocomplete="off"
            placeholder={props.secretSet ? "Saved. Leave blank to keep" : "cs_…"} value={secret()} onInput={(e) => setSecret(e.currentTarget.value)} /></div>
      </div>
      <p class="hint" style={{ "margin-top": 0 }}>
        WooCommerce → Settings → Advanced → REST API. Read access is enough. Saved keys are stored on this computer and never shown again.
      </p>
      <button class="btn primary" disabled={saving()}>{saving() ? "Saving…" : props.done ? "Update connection" : "Connect"}</button>
      <NoteLine note={note()} />
    </form>
  );
}

function Sync(props: { done: boolean; enabled: boolean; count: number; onSynced: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<Note>(null);
  async function sync() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.sync();
      props.onSynced();
      bumpData();
      setNote({ text: `Synced ${plural(r.synced, "product")}${r.removed ? `, removed ${r.removed} no longer in the store` : ""}.`, ok: true });
    } catch (err) {
      setNote({ text: (err as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="card card-pad">
      <Step n={2} done={props.done} title="Sync your products" />
      <p class="muted" style={{ "margin-top": 0 }}>
        Pulls names, SKUs and current prices from WooCommerce. Variations come in as separate products.
        Run it again whenever your catalogue or prices change.
      </p>
      <Show when={props.count}><p><b class="num" style={{ color: "var(--ink)" }}>{props.count}</b> products synced.</p></Show>
      <button class="btn primary" disabled={busy() || !props.enabled} onClick={sync}>
        <RefreshIcon spinning={busy()} />{busy() ? "Syncing…" : "Sync now"}
      </button>
      <Show when={!props.enabled}><div class="hint" style={{ "margin-top": "8px" }}>Connect your store first.</div></Show>
      <NoteLine note={note()} />
    </div>
  );
}

function Track(props: { settings: SettingsData; onSaved: () => void }) {
  const st = props.settings;
  const [cats, setCats] = createSignal<string[]>(st.track_categories);
  const [brands, setBrands] = createSignal<string[]>(st.track_brands);
  const [prods, setProds] = createSignal<number[]>(st.track_products);
  const [q, setQ] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [note, setNote] = createSignal<Note>(null);

  const countBy = (pick: (p: TrackProduct) => string | null) => {
    const m = new Map<string, number>();
    for (const p of st.available_products) { const v = pick(p); if (v) m.set(v, (m.get(v) ?? 0) + 1); }
    return m;
  };
  const catCounts = countBy((p) => p.category), brandCounts = countBy((p) => p.brand);

  // Mirrors the server: brand/category pool, then product-level narrowing.
  const inPool = (p: TrackProduct) =>
    (!cats().length || cats().includes(p.category ?? "")) && (!brands().length || brands().includes(p.brand ?? ""));
  const pool = createMemo(() => st.available_products.filter(inPool));
  const tracked = createMemo(() => pool().filter((p) => !prods().length || prods().includes(p.id)).length);
  const shown = createMemo(() => {
    const s = q().trim().toLowerCase();
    return pool().filter((p) => !s || p.name.toLowerCase().includes(s) || (p.sku ?? "").toLowerCase().includes(s)).slice(0, 300);
  });

  const toggle = <T,>(get: () => T[], set: (v: T[]) => void, v: T) =>
    set(get().includes(v) ? get().filter((x) => x !== v) : [...get(), v]);

  async function save() {
    setSaving(true);
    setNote(null);
    try {
      await api.saveTracking({ brands: brands(), categories: cats(), product_ids: prods() });
      props.onSaved();
      bumpData();
      setNote({ text: "Saved. The product list now shows only what you track.", ok: true });
    } catch (err) {
      setNote({ text: (err as Error).message, ok: false });
    } finally {
      setSaving(false);
    }
  }

  const Checks = (p: { title: string; all: string[]; get: () => string[]; set: (v: string[]) => void; counts: Map<string, number> }) => (
    <section>
      <div class="row" style={{ "margin-bottom": "8px" }}>
        <h3>{p.title}</h3>
        <span class="hint">{p.get().length ? `${p.get().length} of ${p.all.length}` : "all"}</span>
        <Show when={p.get().length}><button type="button" class="link-btn" onClick={() => p.set([])}>Clear</button></Show>
      </div>
      <div class="checks">
        <For each={p.all}>{(v) => (
          <label class="check" classList={{ on: p.get().includes(v) }}>
            <input type="checkbox" checked={p.get().includes(v)} onChange={() => toggle(p.get, p.set, v)} />
            <span class="lbl">{v}</span><span class="n num">{p.counts.get(v) ?? 0}</span>
          </label>
        )}</For>
      </div>
    </section>
  );

  return (
    <div class="card card-pad step-wide">
      <Step n={3} done={false} title="Choose what to track" />
      <p class="muted" style={{ "margin-top": 0 }}>
        Narrow by category and brand, then pick single products if you want. Nothing ticked means everything is tracked.
        Unticked products stay synced, just out of the way.
      </p>
      <div class="cols" style={{ "margin-bottom": "18px" }}>
        <Show when={st.available_categories.length}>
          <Checks title="Categories" all={st.available_categories} get={cats} set={setCats} counts={catCounts} />
        </Show>
        <Show when={st.available_brands.length}>
          <Checks title="Brands" all={st.available_brands} get={brands} set={setBrands} counts={brandCounts} />
        </Show>
      </div>
      <section>
        <div class="row" style={{ "margin-bottom": "8px" }}>
          <h3>Products</h3>
          <span class="hint">{prods().length ? `${pool().filter((p) => prods().includes(p.id)).length} picked` : "all in the pool"}</span>
          <Show when={prods().length}><button type="button" class="link-btn" onClick={() => setProds([])}>Clear</button></Show>
          <span style={{ flex: 1 }} />
          <input class="input" type="search" style={{ "max-width": "280px", height: "32px" }} placeholder="Search name or SKU"
            aria-label="Search products" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
        <div class="checks">
          <For each={shown()} fallback={<div class="hint">No products match.</div>}>{(p) => (
            <label class="check" classList={{ on: prods().includes(p.id) }}>
              <input type="checkbox" checked={prods().includes(p.id)} onChange={() => toggle(prods, setProds, p.id)} />
              <span class="lbl">{p.name}<span class="s">{[p.brand, p.sku].filter(Boolean).join(" · ")}</span></span>
            </label>
          )}</For>
        </div>
        <Show when={pool().length > 300 && !q()}><div class="hint" style={{ "margin-top": "6px" }}>Showing 300 of {pool().length}. Search to find the rest.</div></Show>
      </section>
      <div class="row" style={{ "margin-top": "18px" }}>
        <button class="btn primary" disabled={saving()} onClick={save}>{saving() ? "Saving…" : "Save"}</button>
        <span>Tracking <b class="num" style={{ color: "var(--ink)" }}>{tracked()}</b> of {st.available_products.length} products</span>
      </div>
      <NoteLine note={note()} />
    </div>
  );
}
