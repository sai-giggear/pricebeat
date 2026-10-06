// One product: where it stands, its price history, and the rivals tracked for it.
import { useNavigate } from "@solidjs/router";
import { createResource, createSignal, For, Show } from "solid-js";
import { api, dataVersion, type Candidate, type ProductRow } from "../api";
import { gapPct, money, num, offPct, pct1, plural, timeAgo } from "../format";
import PriceChart, { seriesColor } from "../components/PriceChart";
import { ExternalIcon, Favicon, MatchBadge, PlusIcon, ProductPicker, RefreshIcon, SearchIcon } from "../components/ui";

export default function Detail(props: { id: number; products: ProductRow[]; onChange: () => void }) {
  const [detail, { refetch }] = createResource(() => [props.id, dataVersion()] as const, ([id]) => api.product(id));
  const [busy, setBusy] = createSignal<string | null>(null); // which action is in flight
  const [error, setError] = createSignal("");
  const [panel, setPanel] = createSignal<"" | "find" | "add">("");
  const [moving, setMoving] = createSignal<number | null>(null);
  const navigate = useNavigate();

  // Reversible from Settings, so a plain confirm is enough.
  async function stop(name: string) {
    if (!confirm(`Stop tracking ${name}?

It leaves the product list and price checks. Its rivals and price history are kept, and you can bring it back in Settings.`)) return;
    setBusy("stop");
    setError("");
    try {
      await api.stopTracking(props.id);
      props.onChange();
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try {
      await fn();
      await refetch();
      props.onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Show when={detail()} fallback={<div class="empty">{detail.error ? detail.error.message : "Loading…"}</div>}>
      {(d) => {
        const off = () => offPct(d().regular_price, d().own_price);
        const gap = () => gapPct(d().own_price, d().lowest_price);
        return (
          <div class="detail">
            <div class="detail-head">
              <div>
                <div class="eyebrow">
                  <Show when={d().brand}><span>{d().brand}</span></Show>
                  <Show when={d().sku}><span class="mono">{d().sku}</span></Show>
                  <Show when={d().category}><span>{d().category}</span></Show>
                </div>
                <h1>{d().name}</h1>
              </div>
              <div class="row">
                <Show when={d().permalink}>
                  <a class="btn" href={d().permalink!} target="_blank" rel="noreferrer">Your listing <ExternalIcon /></a>
                </Show>
                <button class="btn quiet danger" disabled={!!busy()} onClick={() => stop(d().name)}
                  title="Hide this product and skip it in price checks">
                  {busy() === "stop" ? "Stopping…" : "Stop tracking"}
                </button>
                <button class="btn primary" disabled={!!busy() || !d().mappings.length}
                  onClick={() => act("all", () => api.trackProduct(d().id))}>
                  <RefreshIcon spinning={busy() === "all"} />{busy() === "all" ? "Fetching…" : "Fetch prices"}
                </button>
              </div>
            </div>

            <Show when={error()}><div class="note err" role="alert">{error()}</div></Show>

            <div class="tiles">
              <div class="card tile">
                <div class="tile-label">Your price</div>
                <div class="tile-value num">{money(d().own_price)}</div>
                <div class="tile-sub">
                  <Show when={off() != null} fallback="No markdown">
                    <span class="strike num">{money(d().regular_price)}</span> · {off()}% off
                  </Show>
                </div>
              </div>
              <div class="card tile">
                <div class="tile-label">Lowest rival</div>
                <div class="tile-value num">{d().has_data && !d().is_lowest ? money(d().lowest_price) : "—"}</div>
                <div class="tile-sub">{d().has_data ? (d().is_lowest ? "Nobody's cheaper" : d().lowest_seller) : "No prices yet"}</div>
              </div>
              <div class="card tile" classList={{ good: d().has_data && d().is_lowest, bad: d().has_data && !d().is_lowest }}>
                <div class="tile-label">Position</div>
                <div class="tile-value">
                  {!d().has_data ? "No data" : d().is_lowest ? "Lowest" : `+${pct1(gap() ?? 0)}%`}
                </div>
                <div class="tile-sub">
                  {!d().has_data ? "Track a rival to compare" : d().is_lowest ? "You're the cheapest tracked"
                    : `${money(d().gap_to_lowest)} above ${d().lowest_seller}`}
                </div>
              </div>
              <div class="card tile accent">
                <div class="tile-label">Suggested</div>
                <div class="tile-value num">{money(d().suggested_price)}</div>
                <div class="tile-sub">{d().suggested_price ? "1% under the lowest rival" : "Hold your price"}</div>
              </div>
            </div>

            <div class="card">
              <div class="card-head"><h2>Price history</h2></div>
              <PriceChart mappings={d().mappings} own={d().own_price} />
            </div>

            <div class="card">
              <div class="card-head">
                <h2>Rivals <span class="count">{d().mappings.length}</span></h2>
                <span class="spacer" />
                <button class="btn small" aria-expanded={panel() === "find"} onClick={() => setPanel(panel() === "find" ? "" : "find")}>
                  <SearchIcon />Find on Google
                </button>
                <button class="btn small" aria-expanded={panel() === "add"} onClick={() => setPanel(panel() === "add" ? "" : "add")}>
                  <PlusIcon />Add by URL
                </button>
              </div>

              <Show when={panel() === "add"}>
                <AddByUrl productId={d().id} onDone={() => { setPanel(""); void refetch(); props.onChange(); }} />
              </Show>
              <Show when={panel() === "find"}>
                <Find productId={d().id} onDone={() => { setPanel(""); void refetch(); props.onChange(); }} />
              </Show>

              <div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>Rival</th><th class="num">Their price</th><th class="num">vs you</th><th>Checked</th><th /></tr>
                  </thead>
                  <tbody>
                    <For each={d().mappings} fallback={
                      <tr><td colspan="5"><div class="empty"><div class="big">No rivals tracked yet</div>
                        Find them on Google, or paste a rival's product URL.</div></td></tr>}>
                      {(m, i) => {
                        const delta = () => gapPct(m.price, d().own_price);
                        return (
                          <>
                            <tr>
                              <td class="fill">
                                <div class="cell-title">
                                  <span class="key" style={{ "border-color": seriesColor(i()) }} aria-hidden="true" />
                                  <Favicon src={m.favicon_url} name={m.competitor_name} />
                                  {m.competitor_name}
                                  <MatchBadge status={m.match_status} />
                                </div>
                                <div class="cell-sub truncate">
                                  <a class="ext" href={m.identifier} target="_blank" rel="noreferrer" title={m.identifier}>
                                    {m.offer_title ?? m.identifier.replace(/^https?:\/\//, "")}
                                  </a>
                                </div>
                              </td>
                              <td class="num">
                                <Show when={m.price} fallback={<span class="muted">—</span>}>
                                  <b style={{ color: "var(--ink)" }}>{money(m.price)}</b>
                                </Show>
                                <Show when={(num(m.shipping) ?? 0) > 0}><div class="cell-sub">+{money(m.shipping)} shipping</div></Show>
                                <Show when={m.in_stock === false}><div class="cell-sub">out of stock</div></Show>
                              </td>
                              <td class="num">
                                <Show when={delta() != null} fallback={<span class="muted">—</span>}>
                                  <span class="delta" classList={{ good: delta()! > 0, bad: delta()! < 0 }}
                                    title={delta()! < 0 ? "They're cheaper than you" : "You're cheaper"}>
                                    {delta()! > 0 ? "+" : ""}{pct1(delta()!)}%
                                  </span>
                                </Show>
                              </td>
                              <td class="checked">
                                <div>{timeAgo(m.last_checked_at) ?? <span class="muted">never</span>}</div>
                                <Show when={m.last_status && m.last_status !== "ok"}>
                                  <div class="cell-sub error" title={m.last_error ?? ""}>
                                    {m.last_error ?? `last fetch ${m.last_status}`}
                                  </div>
                                </Show>
                                <Show when={m.last_status === "ok"}>
                                  <div class="cell-sub" title="Checked more often while the price moves, less while it holds">
                                    every {Math.round(m.check_interval_hours)}h
                                  </div>
                                </Show>
                              </td>
                              <td class="actions">
                                <button class="btn quiet small" disabled={!!busy()} title="Fetch this rival's price now"
                                  onClick={() => act(`m${m.id}`, () => api.trackMapping(m.id))}>
                                  <RefreshIcon spinning={busy() === `m${m.id}`} /><span class="sr-only">Fetch</span>
                                </button>
                                <button class="btn quiet small" onClick={() => setMoving(moving() === m.id ? null : m.id)}
                                  aria-expanded={moving() === m.id}>Move</button>
                                <button class="btn quiet small danger" disabled={!!busy()}
                                  onClick={() => act(`d${m.id}`, () => api.deleteMapping(m.id))}>Remove</button>
                              </td>
                            </tr>
                            <Show when={moving() === m.id}>
                              <tr><td colspan="5" style={{ background: "var(--surface-2)" }}>
                                <div class="row">
                                  <span class="muted">Wrong product? Move the <b>{m.competitor_name}</b> listing, with its history, to:</span>
                                  <ProductPicker products={props.products} current={d().id}
                                    onPick={(pid) => act(`mv${m.id}`, async () => { await api.moveMapping(m.id, pid); setMoving(null); })} />
                                  <button class="btn quiet small" onClick={() => setMoving(null)}>Cancel</button>
                                </div>
                              </td></tr>
                            </Show>
                          </>
                        );
                      }}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

function AddByUrl(props: { productId: number; onDone: () => void }) {
  const [url, setUrl] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  async function submit(e: Event) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      // The rival is worked out from the URL's site, added if new, and priced
      // straight away, so this takes a few seconds.
      await api.addMapping(props.productId, url());
      props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <form class="panel" onSubmit={submit}>
      <div class="row">
        <input class="input grow" type="url" required autofocus placeholder="https://rival.com.au/products/…"
          aria-label="Rival product URL" value={url()} onInput={(e) => setUrl(e.currentTarget.value)} />
        <button class="btn primary" disabled={saving()}>{saving() ? "Adding…" : "Track it"}</button>
      </div>
      <Show when={error()}><div class="note err">{error()}</div></Show>
      <div class="hint">New sites are set up automatically: PriceBeat works out how to read their prices.</div>
    </form>
  );
}

function Find(props: { productId: number; onDone: () => void }) {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<Candidate[] | null>(null);
  const [picked, setPicked] = createSignal<string[]>([]);
  const [state, setState] = createSignal<"" | "searching" | "adding">("searching");
  const [error, setError] = createSignal("");

  async function search(q?: string) {
    setState("searching");
    setError("");
    setResults(null);
    try {
      const res = await api.discover(props.productId, q);
      setQuery(res.query);
      setResults(res.candidates);
      // Pre-tick priced listings that match; "check match" is left to you.
      setPicked(res.candidates.filter((c) => c.suggested).map((c) => c.url));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setState("");
    }
  }
  void search();

  async function add() {
    setState("adding");
    setError("");
    try {
      const res = await api.discoverAdd(props.productId, picked());
      if (res.skipped.length) setError(`Skipped ${res.skipped.length}: ${res.skipped[0].reason}`);
      else props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setState("");
    }
  }

  const toggle = (url: string) =>
    setPicked(picked().includes(url) ? picked().filter((u) => u !== url) : [...picked(), url]);

  return (
    <div class="panel">
      <form class="row" onSubmit={(e) => { e.preventDefault(); void search(query()); }}>
        <input class="input grow" type="search" aria-label="Search query" value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)} placeholder="Product name" />
        <button class="btn" disabled={!!state()}>Search again</button>
      </form>
      <Show when={state() === "searching"}>
        <div class="hint" role="status"><RefreshIcon spinning /> Searching and reading each shop's price. This takes 10 to 30 seconds.</div>
      </Show>
      <Show when={error()}><div class="note err" role="alert">{error()}</div></Show>
      <Show when={results()}>{(list) => (
        <Show when={list().length} fallback={<div class="note">No shops found. Try a shorter query, or add a URL by hand.</div>}>
          <div class="cands">
            <For each={list()}>{(c) => (
              <label class="cand" classList={{ off: c.already_tracked }}>
                <input type="checkbox" disabled={c.already_tracked} checked={picked().includes(c.url)} onChange={() => toggle(c.url)} />
                <Favicon src={c.favicon_url} name={c.host} />
                <span class="t">
                  <div title={c.title}>{c.title}</div>
                  <div class="cell-sub">
                    <a class="ext" href={c.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{c.host}</a>
                    <Show when={c.error}> · {c.error}</Show>
                    <Show when={c.in_stock === false}> · out of stock</Show>
                  </div>
                </span>
                <span class="num" style={{ color: "var(--ink)", "font-weight": 600 }}>{c.price ? money(c.price) : "—"}</span>
                <span>
                  <Show when={c.already_tracked} fallback={
                    <Show when={c.price} fallback={<span class="badge bad">no price</span>}>
                      <Show when={c.match_status === "likely"} fallback={<MatchBadge status={c.match_status} />}>
                        <span class="badge">likely match</span>
                      </Show>
                    </Show>}>
                    <span class="badge">tracked</span>
                  </Show>
                </span>
              </label>
            )}</For>
          </div>
          <div class="row">
            <button class="btn primary" disabled={!picked().length || !!state()} onClick={add}>
              {state() === "adding" ? "Adding…" : `Track ${plural(picked().length, "rival")}`}
            </button>
            <span class="hint">Your own store is left out. Results follow this computer's region.</span>
          </div>
        </Show>
      )}</Show>
    </div>
  );
}
