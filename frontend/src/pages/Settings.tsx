import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api } from "../api";
import FetchIcon from "../components/FetchIcon";

type Note = { text: string; ok: boolean } | null;

export default function Settings() {
  const [settings, { refetch }] = createResource(api.settings);
  const [baseUrl, setBaseUrl] = createSignal<string | null>(null);
  const [key, setKey] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const [syncing, setSyncing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  // Each action gets its own feedback line so success/errors never bleed across cards.
  const [connNote, setConnNote] = createSignal<Note>(null);
  const [syncNote, setSyncNote] = createSignal<Note>(null);
  const [trackNote, setTrackNote] = createSignal<Note>(null);

  // Track-filter selections: null until touched, then fall back to saved values.
  const [selCats, setSelCats] = createSignal<string[] | null>(null);
  const [selBrands, setSelBrands] = createSignal<string[] | null>(null);
  const [selProds, setSelProds] = createSignal<number[] | null>(null);
  const [prodQuery, setProdQuery] = createSignal("");
  const [savingTrack, setSavingTrack] = createSignal(false);
  const cats = () => selCats() ?? settings()?.track_categories ?? [];
  const brands = () => selBrands() ?? settings()?.track_brands ?? [];
  const prods = () => selProds() ?? settings()?.track_products ?? [];
  const allCats = () => settings()?.available_categories ?? [];
  const allBrands = () => settings()?.available_brands ?? [];
  const allProducts = () => settings()?.available_products ?? [];

  // Product counts per category / brand, so each row shows how much it covers.
  const countBy = (pick: (p: { brand: string | null; category: string | null }) => string | null) =>
    createMemo(() => {
      const m = new Map<string, number>();
      for (const p of allProducts()) {
        const v = pick(p);
        if (v) m.set(v, (m.get(v) ?? 0) + 1);
      }
      return m;
    });
  const catCounts = countBy((p) => p.category);
  const brandCounts = countBy((p) => p.brand);

  // How many products the current selection actually tracks (mirrors the
  // server's filter_active: brand/category pool, then product-level narrowing).
  const trackedCount = createMemo(() => {
    const c = cats(), b = brands(), p = prods();
    if (!c.length && !b.length && !p.length) return allProducts().length;
    return allProducts().filter(
      (pr) =>
        (!c.length || (pr.category != null && c.includes(pr.category))) &&
        (!b.length || (pr.brand != null && b.includes(pr.brand))) &&
        (!p.length || p.includes(pr.id)),
    ).length;
  });

  // The product picker narrows within the chosen brand/category pool: only
  // products matching the current selection are offered (all if none chosen).
  const prodPool = createMemo(() => {
    const c = cats(), b = brands();
    return allProducts().filter(
      (p) =>
        (!c.length || (p.category != null && c.includes(p.category))) &&
        (!b.length || (p.brand != null && b.includes(p.brand))),
    );
  });
  const prodVisible = createMemo(() => {
    const q = prodQuery().trim().toLowerCase();
    const pool = prodPool();
    if (!q) return pool;
    return pool.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q),
    );
  });
  const prodSelectedInPool = () => prodPool().filter((p) => prods().includes(p.id)).length;
  const allVisibleProdsSelected = () => {
    const v = prodVisible();
    return v.length > 0 && v.every((p) => prods().includes(p.id));
  };
  function toggleProd(id: number) {
    const cur = prods();
    setSelProds(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }
  function toggleAllProds() {
    const vis = prodVisible();
    const cur = prods();
    if (vis.every((p) => cur.includes(p.id))) {
      setSelProds(cur.filter((id) => !vis.some((p) => p.id === id)));
    } else {
      setSelProds([...new Set([...cur, ...vis.map((p) => p.id)])]);
    }
  }
  const toggle = (
    list: () => string[],
    setList: (v: string[]) => void,
    value: string,
  ) => {
    const cur = list();
    setList(cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]);
  };
  // Per-panel select-all / clear.
  const allSelected = (list: () => string[], all: () => string[]) =>
    all().length > 0 && list().length === all().length;
  const toggleAll = (
    list: () => string[],
    setList: (v: string[]) => void,
    all: () => string[],
  ) => setList(allSelected(list, all) ? [] : [...all()]);

  // Derived status that drives the guided-setup flow.
  const connected = () => {
    const s = settings();
    return !!s && !!s.woo_base_url && s.woo_key_set && s.woo_secret_set;
  };
  const hasCatalogue = () =>
    (settings()?.available_categories?.length ?? 0) > 0 ||
    (settings()?.available_brands?.length ?? 0) > 0;

  // Controlled base-url value: fall back to the loaded setting until edited.
  const baseUrlValue = () => baseUrl() ?? settings()?.woo_base_url ?? "";

  async function saveTracking() {
    setSavingTrack(true);
    setTrackNote(null);
    try {
      await api.saveTracking({ brands: brands(), categories: cats(), product_ids: prods() });
      await refetch();
      setSelCats(null);
      setSelBrands(null);
      setSelProds(null);
      setTrackNote({ text: "Tracking filter saved.", ok: true });
    } catch (err) {
      setTrackNote({ text: (err as Error).message, ok: false });
    } finally {
      setSavingTrack(false);
    }
  }

  async function sync() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const res = await api.sync();
      const bits = [`Synced ${res.synced} product${res.synced === 1 ? "" : "s"}`];
      if (res.removed) bits.push(`removed ${res.removed} stale`);
      setSyncNote({ text: `${bits.join(", ")}.`, ok: true });
    } catch (err) {
      setSyncNote({ text: (err as Error).message, ok: false });
    } finally {
      setSyncing(false);
    }
  }

  async function save(e: Event) {
    e.preventDefault();
    setSaving(true);
    setConnNote(null);
    try {
      await api.saveSettings({
        woo_base_url: baseUrlValue(),
        woo_key: key(),
        woo_secret: secret(),
      });
      setKey("");
      setSecret("");
      setBaseUrl(null);
      await refetch();
      setConnNote({ text: "Connection saved.", ok: true });
    } catch (err) {
      setConnNote({ text: (err as Error).message, ok: false });
    } finally {
      setSaving(false);
    }
  }

  const catalogueCount = () =>
    // available_* are distinct lists, not product totals — show the richer signal.
    (settings()?.available_categories?.length ?? 0) +
    (settings()?.available_brands?.length ?? 0);

  return (
    <>
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <div class="sub">Three steps to start tracking: connect, sync, choose what to track.</div>
        </div>
      </div>

      {/* Connect + sync sit side by side; the catalogue picker spans full width below. */}
      <div class="settings-grid">
        {/* Step 1 — connect ---------------------------------------------------- */}
        <div class="card step" classList={{ done: connected() }}>
          <div class="step-head">
            <span class="step-num"><span class="n">1</span></span>
            <div class="card-title">Connect your store</div>
            <span class="spacer" />
            <span class="status-pill" classList={{ on: connected(), off: !connected() }}>
              <span class="dot" />
              {connected() ? "Connected" : "Not connected"}
            </span>
          </div>

          <Show when={connected() && baseUrl() === null}>
            <div class="connected-line">
              Linked to <span class="store-url">{settings()?.woo_base_url}</span>
            </div>
          </Show>

          <form onSubmit={save}>
            <div class="field">
              <label>Store URL</label>
              <input
                type="url"
                placeholder="https://yourstore.com"
                value={baseUrlValue()}
                onInput={(e) => setBaseUrl(e.currentTarget.value)}
              />
            </div>
            <div class="form-row">
              <div class="field" style={{ flex: "1 1 220px" }}>
                <label>Consumer key</label>
                <input
                  type="password"
                  placeholder={settings()?.woo_key_set ? "•••• keep current" : "ck_..."}
                  value={key()}
                  onInput={(e) => setKey(e.currentTarget.value)}
                />
              </div>
              <div class="field" style={{ flex: "1 1 220px" }}>
                <label>Consumer secret</label>
                <input
                  type="password"
                  placeholder={settings()?.woo_secret_set ? "•••• keep current" : "cs_..."}
                  value={secret()}
                  onInput={(e) => setSecret(e.currentTarget.value)}
                />
              </div>
            </div>
            <div class="hint" style={{ "margin-top": "-8px", "margin-bottom": "16px" }}>
              Stored keys are never sent back to the browser — leave blank to keep the current ones.
            </div>
            <button type="submit" class="btn-primary" disabled={saving()}>
              {saving() ? "Saving…" : connected() ? "Update connection" : "Connect store"}
            </button>
            <Show when={connNote()}>
              <div class="note" classList={{ ok: connNote()!.ok, err: !connNote()!.ok }}>
                {connNote()!.text}
              </div>
            </Show>
          </form>
        </div>

        {/* Step 2 — sync ------------------------------------------------------- */}
        <div class="card step" classList={{ done: hasCatalogue() }}>
          <div class="step-head">
            <span class="step-num"><span class="n">2</span></span>
            <div class="card-title">Sync your catalogue</div>
          </div>
          <p class="step-desc">
            Pull your products and current prices from WooCommerce. Run this again
            any time your catalogue changes.
          </p>

          <Show when={hasCatalogue()}>
            <div class="sync-stat">
              <span class="sync-stat-num">{catalogueCount()}</span>
              <span class="sync-stat-label">categories &amp; brands available to track</span>
            </div>
          </Show>

          <button class="btn-primary" disabled={syncing() || !connected()} onClick={sync}>
            <Show when={!syncing()}><FetchIcon /></Show>
            {syncing() ? "Syncing…" : "Sync products"}
          </button>
          <Show when={!connected()}>
            <div class="step-lock">⤴ Connect your store first to enable syncing.</div>
          </Show>
          <Show when={syncNote()}>
            <div class="note" classList={{ ok: syncNote()!.ok, err: !syncNote()!.ok }}>
              {syncNote()!.text}
            </div>
          </Show>
        </div>
      </div>

      {/* Step 3 — track filter (full width) ---------------------------------- */}
      <Show when={hasCatalogue()}>
        <div class="card step track">
          <div class="step-head">
            <span class="step-num"><span class="n">3</span></span>
            <div class="card-title">Choose what to track</div>
            <span class="spacer" />
            <Show when={cats().length || brands().length || prods().length}>
              <button
                type="button"
                class="btn-mini"
                onClick={() => { setSelCats([]); setSelBrands([]); setSelProds([]); }}
              >
                Clear all (track everything)
              </button>
            </Show>
          </div>
          <p class="step-desc">
            First narrow by category and brand, then — if you want finer control —
            tick the individual products to track. Nothing ticked means everything
            in the pool is tracked. Un-ticked items stay synced, just hidden.
          </p>

          <div class="track-cols">
            <Show when={allCats().length > 0}>
              <section class="track-panel">
                <div class="track-panel-head">
                  <h3>Categories</h3>
                  <span class="track-count">
                    {cats().length ? `${cats().length} of ${allCats().length}` : "all"}
                  </span>
                  <button
                    type="button"
                    class="link-btn"
                    onClick={() => toggleAll(cats, setSelCats, allCats)}
                  >
                    {allSelected(cats, allCats) ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div class="check-grid">
                  <For each={allCats()}>
                    {(c) => (
                      <label class="check" classList={{ on: cats().includes(c) }}>
                        <input
                          type="checkbox"
                          checked={cats().includes(c)}
                          onChange={() => toggle(cats, setSelCats, c)}
                        />
                        <span class="check-text"><span class="check-name">{c}</span></span>
                        <span class="check-count">{catCounts().get(c) ?? 0}</span>
                      </label>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <Show when={allBrands().length > 0}>
              <section class="track-panel">
                <div class="track-panel-head">
                  <h3>Brands</h3>
                  <span class="track-count">
                    {brands().length ? `${brands().length} of ${allBrands().length}` : "all"}
                  </span>
                  <button
                    type="button"
                    class="link-btn"
                    onClick={() => toggleAll(brands, setSelBrands, allBrands)}
                  >
                    {allSelected(brands, allBrands) ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div class="check-grid">
                  <For each={allBrands()}>
                    {(b) => (
                      <label class="check" classList={{ on: brands().includes(b) }}>
                        <input
                          type="checkbox"
                          checked={brands().includes(b)}
                          onChange={() => toggle(brands, setSelBrands, b)}
                        />
                        <span class="check-text"><span class="check-name">{b}</span></span>
                        <span class="check-count">{brandCounts().get(b) ?? 0}</span>
                      </label>
                    )}
                  </For>
                </div>
              </section>
            </Show>
          </div>

          {/* Product-level narrowing within the brand/category pool. */}
          <Show when={allProducts().length > 0}>
            <section class="track-panel track-products">
              <div class="track-panel-head">
                <h3>Products</h3>
                <span class="track-count">
                  {prods().length ? `${prodSelectedInPool()} of ${prodPool().length}` : "all"}
                </span>
                <button type="button" class="link-btn" onClick={toggleAllProds}>
                  {allVisibleProdsSelected() ? "Deselect all" : "Select all"}
                </button>
              </div>
              <div class="prod-search">
                <input
                  type="text"
                  placeholder="Search products by name or SKU…"
                  value={prodQuery()}
                  onInput={(e) => setProdQuery(e.currentTarget.value)}
                />
              </div>
              <div class="check-grid check-grid-prod">
                <For each={prodVisible()}>
                  {(p) => (
                    <label class="check" classList={{ on: prods().includes(p.id) }}>
                      <input
                        type="checkbox"
                        checked={prods().includes(p.id)}
                        onChange={() => toggleProd(p.id)}
                      />
                      <span class="check-text">
                        <span class="check-name">{p.name}</span>
                        <Show when={p.brand || p.sku}>
                          <span class="check-sub">
                            {[p.brand, p.sku].filter(Boolean).join(" · ")}
                          </span>
                        </Show>
                      </span>
                    </label>
                  )}
                </For>
                <Show when={prodVisible().length === 0}>
                  <div class="picker-empty">No products match this filter.</div>
                </Show>
              </div>
            </section>
          </Show>

          <div class="track-foot">
            <button class="btn-primary" disabled={savingTrack()} onClick={saveTracking}>
              {savingTrack() ? "Saving…" : "Save tracking filter"}
            </button>
            <span class="track-summary">
              Tracking <b>{trackedCount()}</b> of {allProducts().length} products
            </span>
            <Show when={trackNote()}>
              <div class="note" classList={{ ok: trackNote()!.ok, err: !trackNote()!.ok }}>
                {trackNote()!.text}
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </>
  );
}
