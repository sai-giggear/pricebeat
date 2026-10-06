// Rival stores and how PriceBeat reads their prices.
import { createResource, createSignal, For, Show } from "solid-js";
import { api, type Competitor, type Detected } from "../api";
import { money, plural } from "../format";
import { Favicon } from "../components/ui";

export default function Competitors() {
  const [list, { refetch }] = createResource(api.competitors);
  const [editing, setEditing] = createSignal<Competitor | null>(null);
  const [note, setNote] = createSignal("");

  async function remove(c: Competitor) {
    const listings = c.listings ? ` and its ${plural(c.listings, "tracked listing")} with their history` : "";
    if (!confirm(`Delete ${c.name}${listings}? This can't be undone.`)) return;
    await api.deleteCompetitor(c.id);
    if (editing()?.id === c.id) setEditing(null);
    await refetch();
  }

  async function resetAll() {
    if (!confirm("Remove every competitor, tracked listing and price history?\n\n" +
                 "Your synced products and settings stay. This can't be undone.")) return;
    const r = await api.reset();
    setEditing(null);
    setNote(`Removed ${plural(r.competitors, "competitor")}, ${plural(r.mappings, "listing")} and ${plural(r.snapshots, "price record")}.`);
    await refetch();
  }

  return (
    <main class="page">
      <div class="page-inner">
        <div class="page-head">
          <div>
            <h1>Competitors</h1>
            <div class="sub">Rival stores, and how PriceBeat reads their prices.</div>
          </div>
          <span class="spacer" />
          <Show when={list()?.length}>
            <button class="btn quiet danger" onClick={resetAll}>Reset all tracking data</button>
          </Show>
        </div>
        <Show when={note()}><div class="note ok" style={{ "margin-bottom": "16px" }}>{note()}</div></Show>

        <div class="two">
          <div class="card">
            <div class="table-wrap">
              <table>
                <thead><tr><th>Store</th><th>Price method</th><th class="num">Listings</th><th /></tr></thead>
                <tbody>
                  <For each={list()} fallback={
                    <tr><td colspan="4"><div class="empty"><div class="big">No competitors yet</div>
                      They're added for you when you track a rival listing, or add a store here.</div></td></tr>}>
                    {(c) => (
                      <tr>
                        <td>
                          <div class="cell-title"><Favicon src={c.favicon_url} name={c.name} />{c.name}</div>
                          <Show when={c.site_url && c.site_url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") !== c.name}>
                            <div class="cell-sub"><a class="ext" href={c.site_url!} target="_blank" rel="noreferrer">
                              {c.site_url!.replace(/^https?:\/\/(www\.)?/, "")}</a></div>
                          </Show>
                        </td>
                        <td class="muted truncate" style={{ "max-width": "260px" }} title={c.method}>{c.method}</td>
                        <td class="num">{c.listings}</td>
                        <td class="actions">
                          <button class="btn quiet small" onClick={() => setEditing(c)}>Edit</button>
                          <button class="btn quiet small danger" onClick={() => remove(c)}>Delete</button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>

          <Show when={editing()} keyed fallback={<AddStore onAdded={refetch} />}>
            {(c) => <EditStore c={c} onDone={() => { setEditing(null); void refetch(); }} />}
          </Show>
        </div>
      </div>
    </main>
  );
}

function AddStore(props: { onAdded: () => void }) {
  const [url, setUrl] = createSignal("");
  const [name, setName] = createSignal("");
  const [detected, setDetected] = createSignal<Detected | null>(null);
  const [busy, setBusy] = createSignal<"" | "detect" | "save">("");
  const [error, setError] = createSignal("");

  async function run(kind: "detect" | "save", fn: () => Promise<void>) {
    setBusy(kind);
    setError("");
    try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(""); }
  }
  const detect = () => run("detect", async () => { setDetected(await api.detect(url())); });
  const save = (e: Event) => {
    e.preventDefault();
    return run("save", async () => {
      await api.addCompetitor(url(), name());
      setUrl(""); setName(""); setDetected(null);
      props.onAdded();
    });
  };

  return (
    <form class="card card-pad" onSubmit={save}>
      <h2 style={{ "margin-bottom": "4px" }}>Add a store</h2>
      <p class="hint" style={{ "margin-top": 0 }}>
        Paste the store's address or one of its product pages. PriceBeat works out how to read its prices.
      </p>
      <div class="field">
        <label for="add-url">Store or product URL</label>
        <input id="add-url" class="input" type="url" required placeholder="https://rival.com.au"
          value={url()} onInput={(e) => { setUrl(e.currentTarget.value); setDetected(null); }} />
      </div>
      <Show when={detected()}>{(d) => (
        <div class="detected">
          <div class="cell-title"><Favicon src={d().favicon_url} name={d().site_url} />{d().site_url.replace(/^https?:\/\/(www\.)?/, "")}</div>
          <div class="hint">{d().method}</div>
          <div>{d().sample_price
            ? <>Price on this page: <b class="num">{money(d().sample_price)}</b></>
            : <span class="hint">Paste a product page to preview a live price.</span>}</div>
        </div>
      )}</Show>
      <div class="field">
        <label for="add-name">Name <span class="muted">(optional)</span></label>
        <input id="add-name" class="input" type="text" placeholder="Taken from the web address"
          value={name()} onInput={(e) => setName(e.currentTarget.value)} />
      </div>
      <Show when={error()}><div class="note err" style={{ "margin-bottom": "12px" }}>{error()}</div></Show>
      <div class="row">
        <button class="btn primary" disabled={!!busy() || !url()}>{busy() === "save" ? "Adding…" : "Add store"}</button>
        <button type="button" class="btn" disabled={!!busy() || !url()} onClick={detect}>
          {busy() === "detect" ? "Checking…" : "Test first"}
        </button>
      </div>
    </form>
  );
}

function EditStore(props: { c: Competitor; onDone: () => void }) {
  const [name, setName] = createSignal(props.c.name);
  const [site, setSite] = createSignal(props.c.site_url ?? "");
  const [selector, setSelector] = createSignal("");
  const [error, setError] = createSignal("");
  async function save(e: Event) {
    e.preventDefault();
    try {
      await api.editCompetitor(props.c.id, { name: name(), site_url: site(), price_selector: selector() });
      props.onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form class="card card-pad" onSubmit={save}>
      <h2 style={{ "margin-bottom": "12px" }}>Edit {props.c.name}</h2>
      <div class="field"><label for="ed-name">Name</label>
        <input id="ed-name" class="input" required value={name()} onInput={(e) => setName(e.currentTarget.value)} /></div>
      <div class="field"><label for="ed-site">Site URL</label>
        <input id="ed-site" class="input" type="url" value={site()} onInput={(e) => setSite(e.currentTarget.value)} />
        <span class="hint">Matches pasted links to this store.</span></div>
      <div class="field"><label for="ed-sel">Price CSS selector (fallback)</label>
        <input id="ed-sel" class="input mono" placeholder={props.c.price_selector || ".price"} value={selector()}
          onInput={(e) => setSelector(e.currentTarget.value)} />
        <span class="hint">Only used when the page has no structured price data. Leave blank to keep the current one.</span></div>
      <Show when={error()}><div class="note err" style={{ "margin-bottom": "12px" }}>{error()}</div></Show>
      <div class="row">
        <button class="btn primary">Save</button>
        <button type="button" class="btn quiet" onClick={props.onDone}>Cancel</button>
      </div>
    </form>
  );
}
