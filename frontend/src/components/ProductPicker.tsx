import { createMemo, createSignal, For, Show } from "solid-js";
import type { ProductRow } from "../api";

/** Searchable combobox for choosing a store product — used to move a competitor
 *  link to the correct product. Filters by name or SKU, caps the visible list. */
export default function ProductPicker(props: {
  products: ProductRow[];
  value: number;
  onChange: (id: number) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [q, setQ] = createSignal("");

  const selected = createMemo(() => props.products.find((p) => p.id === props.value));
  const matches = createMemo(() => {
    const s = q().trim().toLowerCase();
    const list = !s
      ? props.products
      : props.products.filter(
          (p) =>
            p.name.toLowerCase().includes(s) || (p.sku ?? "").toLowerCase().includes(s),
        );
    return list.slice(0, 40);
  });

  function pick(p: ProductRow) {
    props.onChange(p.id);
    setQ("");
    setOpen(false);
  }

  return (
    <div
      class="picker"
      onFocusOut={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button type="button" class="picker-value" onClick={() => setOpen(!open())}>
        <span class="picker-name">{selected()?.name ?? "Select a product…"}</span>
        <Show when={selected()?.sku}>
          <span class="picker-sku">{selected()!.sku}</span>
        </Show>
        <span class="picker-caret">▾</span>
      </button>
      <Show when={open()}>
        <div class="picker-pop">
          <input
            class="picker-search"
            type="text"
            autofocus
            placeholder="Search by name or SKU…"
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
          />
          <div class="picker-list">
            <For each={matches()} fallback={<div class="picker-empty">No matches</div>}>
              {(p) => (
                <button
                  type="button"
                  class="picker-opt"
                  classList={{ active: p.id === props.value }}
                  onClick={() => pick(p)}
                >
                  <span class="picker-opt-name">{p.name}</span>
                  <Show when={p.sku}>
                    <span class="picker-sku">{p.sku}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
