// Small shared pieces: icons, favicons, the product picker.
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { ProductRow } from "../api";

const Svg = (props: { size?: number; children: JSX.Element; class?: string }) => (
  <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" class={props.class}>
    {props.children}
  </svg>
);

/** The brand mark: a scalloped shop awning over a storefront. */
export const Awning = (p: { size?: number }) => (
  <Svg size={p.size ?? 20}>
    <path d="M3 7.5 4.5 3h15L21 7.5a3 3 0 0 0-6 0 3 3 0 0 0-6 0 3 3 0 0 0-6 0Z" />
    <path d="M5 13V21h14v-8M10 21v-4h4v4" />
  </Svg>
);
export const SearchIcon = () => <Svg size={15}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>;
export const RefreshIcon = (p: { spinning?: boolean }) => (
  <Svg size={15} class={p.spinning ? "spin" : undefined}><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" /></Svg>
);
export const ExternalIcon = () => <Svg size={13}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>;
export const PlusIcon = () => <Svg size={15}><path d="M12 5v14M5 12h14" /></Svg>;
export const DownloadIcon = () => <Svg size={14}><path d="M12 4v12m0 0-5-5m5 5 5-5M5 20h14" /></Svg>;
export const SunIcon = () => <Svg><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>;
export const MoonIcon = () => <Svg><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" /></Svg>;

/** A competitor's favicon, or its first letter when there's none or it fails. */
export function Favicon(props: { src: string | null; name: string }) {
  const [failed, setFailed] = createSignal(false);
  return (
    <Show when={props.src && !failed()}
      fallback={<span class="favicon letter" aria-hidden="true">{(props.name.trim()[0] || "?").toUpperCase()}</span>}>
      <img class="favicon" src={props.src!} alt="" loading="lazy" onError={() => setFailed(true)} />
    </Show>
  );
}

export function MatchBadge(props: { status: string | null }) {
  return (
    <>
      <Show when={props.status === "verified"}>
        <span class="badge good" title="Same product: the seller's SKU/GTIN matches yours">verified</span>
      </Show>
      <Show when={props.status === "review"}>
        <span class="badge warn" title="The listing title doesn't look like this product. Check the link.">check match</span>
      </Show>
    </>
  );
}

/** Searchable product chooser, for moving a listing to the right product. */
export function ProductPicker(props: { products: ProductRow[]; current: number; onPick: (id: number) => void }) {
  const [q, setQ] = createSignal("");
  const matches = createMemo(() => {
    const s = q().trim().toLowerCase();
    return props.products
      .filter((p) => !s || p.name.toLowerCase().includes(s) || (p.sku ?? "").toLowerCase().includes(s))
      .slice(0, 50);
  });
  return (
    <div class="picker">
      <input class="input" type="search" autofocus placeholder="Search your products by name or SKU"
        value={q()} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Find the right product" />
      <Show when={q().trim()}>
        <div class="picker-pop">
          <div class="picker-list" role="listbox">
            <For each={matches()} fallback={<div class="hint" style={{ padding: "8px" }}>No matches</div>}>
              {(p) => (
                <button type="button" role="option" class="picker-opt" classList={{ active: p.id === props.current }}
                  disabled={p.id === props.current} onClick={() => props.onPick(p.id)}>
                  <span>{p.name}</span>
                  <span class="muted mono">{p.sku}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
