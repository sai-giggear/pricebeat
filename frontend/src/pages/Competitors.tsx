import { createResource, createSignal, For, Show } from "solid-js";
import { api, type Competitor, type DetectResult } from "../api";
import Favicon from "../components/Favicon";

export default function Competitors() {
  const [list, { refetch }] = createResource(api.competitors);
  const [editId, setEditId] = createSignal<number | null>(null);
  const [name, setName] = createSignal("");
  const [priceSelector, setPriceSelector] = createSignal("");
  const [siteUrl, setSiteUrl] = createSignal("");
  const [editMethod, setEditMethod] = createSignal("");
  const [error, setError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [resetting, setResetting] = createSignal(false);

  // URL-first add: paste a URL, auto-detect the best price method, then save.
  const [addUrl, setAddUrl] = createSignal("");
  const [detecting, setDetecting] = createSignal(false);
  const [detected, setDetected] = createSignal<DetectResult | null>(null);
  const [detectError, setDetectError] = createSignal("");

  const isEditing = () => editId() !== null;

  function resetForm() {
    setEditId(null);
    setName("");
    setPriceSelector("");
    setError("");
  }

  function startEdit(c: Competitor) {
    setEditId(c.id);
    setName(c.name);
    setPriceSelector(c.price_selector);
    setSiteUrl(c.site_url ?? "");
    setEditMethod(c.config_summary);
    setError("");
  }

  async function detect() {
    setDetectError("");
    setDetected(null);
    setDetecting(true);
    try {
      setDetected(await api.detectCompetitor(addUrl()));
    } catch (err) {
      setDetectError((err as Error).message);
    } finally {
      setDetecting(false);
    }
  }

  async function addFromUrl(e: Event) {
    e.preventDefault();
    setDetectError("");
    setSaving(true);
    try {
      await api.createCompetitor({ name: name(), url: addUrl() });
      setAddUrl("");
      setName("");
      setDetected(null);
      await refetch();
    } catch (err) {
      setDetectError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const id = editId();
      if (id !== null) {
        await api.updateCompetitor(id, {
          name: name(),
          price_selector: priceSelector(),
          site_url: siteUrl(),
        });
      } else {
        await api.createCompetitor({ name: name(), price_selector: priceSelector() });
      }
      resetForm();
      await refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (editId() === id) resetForm();
    await api.deleteCompetitor(id);
    await refetch();
  }

  async function resetData() {
    if (!confirm(
      "Reset all competitor data?\n\nThis removes every competitor, mapping and " +
      "price-history record. Your synced products are kept. This can't be undone.",
    )) return;
    setResetting(true);
    try {
      await api.reset();
      resetForm();
      await refetch();
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      <div class="page-head">
        <div>
          <h1>Competitors</h1>
          <div class="sub">Rival stores and how PriceBeat reads their prices.</div>
        </div>
        <Show when={(list()?.length ?? 0) > 0}>
          <button class="btn-ghost danger-ghost" disabled={resetting()} onClick={resetData}>
            {resetting() ? "Resetting…" : "Reset data"}
          </button>
        </Show>
      </div>

      <div class="card tight">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Price method</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <Show
              when={(list()?.length ?? 0) > 0}
              fallback={
                <tr>
                  <td colspan="3">
                    <div class="empty">
                      <div class="big">No competitors yet</div>
                      Add your first one below.
                    </div>
                  </td>
                </tr>
              }
            >
              <For each={list()}>
                {(c) => (
                  <tr>
                    <td class="prod-name">
                      <span class="with-favicon">
                        <Favicon src={c.favicon_url} name={c.name} />
                        {c.name}
                      </span>
                    </td>
                    <td class="mono muted truncate">{c.config_summary || "—"}</td>
                    <td style={{ "text-align": "right", "white-space": "nowrap" }}>
                      <button class="btn-mini" onClick={() => startEdit(c)}>
                        Edit
                      </button>{" "}
                      <button class="btn-danger" onClick={() => remove(c.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </Show>
          </tbody>
        </table>
      </div>

      <Show
        when={!isEditing()}
        fallback={
          <div class="card">
            <div class="card-title">Edit competitor</div>
            <form onSubmit={submit}>
              <div class="field">
                <label>Price method</label>
                <div class="readonly-field">
                  <span class="badge good">{editMethod() || "—"}</span>
                  <span class="hint" style={{ margin: "0" }}>
                    Detected automatically from the store.
                  </span>
                </div>
              </div>
              <div class="field">
                <label>Name</label>
                <input
                  type="text"
                  required
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              </div>
              <div class="field">
                <label>Site URL</label>
                <input
                  type="url"
                  placeholder="https://competitor.com.au"
                  value={siteUrl()}
                  onInput={(e) => setSiteUrl(e.currentTarget.value)}
                />
                <div class="hint">Used for the favicon and store link.</div>
              </div>
              <div class="field">
                <label>Price CSS selector (fallback)</label>
                <input
                  type="text"
                  placeholder=".price .amount"
                  value={priceSelector()}
                  onInput={(e) => setPriceSelector(e.currentTarget.value)}
                />
                <div class="hint">
                  Optional. Only used if structured data / JSON isn't found. Leave blank to keep the current one.
                </div>
              </div>
              <Show when={error()}>
                <p class="badge bad" style={{ display: "inline-flex", "margin-bottom": "12px" }}>
                  {error()}
                </p>
              </Show>
              <div class="form-row">
                <button type="submit" class="btn-primary" disabled={saving()}>
                  {saving() ? "Saving…" : "Save changes"}
                </button>
                <button type="button" class="btn-ghost" onClick={resetForm}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        }
      >
        <div class="card">
          <div class="card-title">Add competitor</div>
          <p class="muted" style={{ margin: "-6px 0 16px" }}>
            Paste the competitor's store or a product URL. PriceBeat figures out the
            best way to read their prices automatically — Shopify JSON, structured
            data, or a CSS selector.
          </p>
          <form onSubmit={addFromUrl}>
            <div class="field">
              <label>Store or product URL</label>
              <div class="form-row" style={{ "flex-wrap": "nowrap" }}>
                <input
                  type="url"
                  required
                  placeholder="https://competitor.com.au/products/…"
                  value={addUrl()}
                  onInput={(e) => {
                    setAddUrl(e.currentTarget.value);
                    setDetected(null);
                  }}
                  style={{ flex: "1" }}
                />
                <button
                  type="button"
                  class="btn-ghost"
                  disabled={detecting() || !addUrl()}
                  onClick={detect}
                >
                  {detecting() ? "Detecting…" : "Detect method"}
                </button>
              </div>
            </div>

            <Show when={detected()}>
              {(d) => (
                <div class="detect-result">
                  <div class="detect-row">
                    <Favicon src={d().favicon_url} name={d().site_url} />
                    <span class="detect-site">{d().site_url.replace(/^https?:\/\//, "")}</span>
                    <span class="badge good">{d().method}</span>
                  </div>
                  <div class="detect-meta">
                    <Show
                      when={d().sample_price}
                      fallback={
                        <span class="muted">
                          Method detected. Paste a <b>product</b> URL to preview a live price.
                        </span>
                      }
                    >
                      <span>
                        Live price read from this URL:{" "}
                        <span class="mono price-now">${d().sample_price}</span> ✓
                      </span>
                    </Show>
                  </div>
                </div>
              )}
            </Show>

            <div class="field" style={{ "margin-top": "16px" }}>
              <label>Name (optional)</label>
              <input
                type="text"
                placeholder="auto-filled from the domain"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </div>

            <Show when={detectError()}>
              <p class="badge bad" style={{ display: "inline-flex", "margin-bottom": "12px" }}>
                {detectError()}
              </p>
            </Show>
            <button type="submit" class="btn-primary" disabled={saving() || !addUrl()}>
              {saving() ? "Adding…" : "Add competitor"}
            </button>
          </form>
        </div>
      </Show>
    </>
  );
}
