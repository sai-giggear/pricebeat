// Price history: one stepped line per rival (a price holds until it changes),
// your price as a dashed reference. Hover or arrow keys move a crosshair; the
// tooltip lists every series at that moment. Rival colours follow the rival's
// position in the product's list, so the rivals table can key to them.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { MappingRow } from "../api";
import { dateTime, money, num, shortDate } from "../format";

export const seriesColor = (i: number) => `var(--s${(i % 8) + 1})`;

const H = 240, PAD = { l: 56, r: 14, t: 12, b: 26 };

function niceTicks(min: number, max: number, count = 4) {
  const span = max - min || Math.abs(max) || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

export default function PriceChart(props: { mappings: MappingRow[]; own: string }) {
  let box!: HTMLDivElement;
  const [width, setWidth] = createSignal(640);
  const [hover, setHover] = createSignal<number | null>(null); // index into times()

  onMount(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width - 36)));
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });

  const series = createMemo(() =>
    props.mappings.map((m, i) => ({
      name: m.competitor_name, color: seriesColor(i),
      points: m.history.filter((h) => h.status === "ok" && num(h.price) != null)
        .map((h) => ({ t: Date.parse(h.at), v: num(h.price)! })),
    })).filter((s) => s.points.length));

  const own = () => num(props.own) ?? 0;
  const times = createMemo(() => [...new Set(series().flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b));

  const scales = createMemo(() => {
    const ts = times();
    let t0 = ts[0], t1 = ts[ts.length - 1];
    if (t0 === t1) { t0 -= 86_400_000; t1 += 86_400_000; }
    t1 = Math.max(t1, Date.now()); // lines run on to today
    const vals = [own(), ...series().flatMap((s) => s.points.map((p) => p.v))];
    const ticks = niceTicks(Math.min(...vals), Math.max(...vals));
    const v0 = ticks[0], v1 = ticks[ticks.length - 1];
    const w = width();
    return {
      ticks, t0, t1,
      x: (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (w - PAD.l - PAD.r),
      y: (v: number) => PAD.t + (1 - (v - v0) / (v1 - v0 || 1)) * (H - PAD.t - PAD.b),
    };
  });

  const path = (pts: { t: number; v: number }[]) => {
    const { x, y, t1 } = scales();
    let d = `M${x(pts[0].t)},${y(pts[0].v)}`;
    for (const p of pts.slice(1)) d += `H${x(p.t)}V${y(p.v)}`;
    return d + `H${x(t1)}`;
  };

  /** Price in force at time t: the last point at or before it. */
  const at = (pts: { t: number; v: number }[], t: number) => {
    let v: number | null = null;
    for (const p of pts) { if (p.t <= t) v = p.v; else break; }
    return v;
  };

  const xTicks = createMemo(() => {
    const { t0, t1 } = scales();
    const n = Math.max(2, Math.min(6, Math.floor(width() / 110)));
    return Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
  });

  function onMove(e: PointerEvent) {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const { x } = scales();
    let best = 0;
    times().forEach((t, i) => { if (Math.abs(x(t) - px) < Math.abs(x(times()[best]) - px)) best = i; });
    setHover(best);
  }
  function onKey(e: KeyboardEvent) {
    const n = times().length;
    if (e.key === "ArrowRight") setHover(Math.min(n - 1, (hover() ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover(Math.max(0, (hover() ?? n) - 1));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  }

  const tip = createMemo(() => {
    const i = hover();
    if (i == null) return null;
    const t = times()[i];
    const rows = series().map((s) => ({ ...s, v: at(s.points, t) }))
      .filter((s) => s.v != null).sort((a, b) => a.v! - b.v!);
    const x = scales().x(t) + 18; // + the chart's own left padding
    return { t, rows, left: x + 200 > width() + 18 ? x - 202 : x + 12 };
  });

  return (
    <Show when={series().length} fallback={
      <div class="empty" style={{ padding: "28px" }}>No prices recorded yet. Fetch a rival to start the history.</div>}>
      <div class="chart" ref={box}>
        <svg viewBox={`0 0 ${width()} ${H}`} style={{ height: `${H}px` }} tabindex="0" role="img"
          aria-label="Price history chart. Use left and right arrow keys to step through dates."
          onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey}
          onBlur={() => setHover(null)}>
          <g class="grid axis">
            <For each={scales().ticks}>{(v) => (
              <>
                <line x1={PAD.l} x2={width() - PAD.r} y1={scales().y(v)} y2={scales().y(v)} />
                <text x={PAD.l - 8} y={scales().y(v) + 4} text-anchor="end">${v.toLocaleString()}</text>
              </>
            )}</For>
            <For each={xTicks()}>{(t, i) => (
              <text x={scales().x(t)} y={H - 6}
                text-anchor={i() === 0 ? "start" : i() === xTicks().length - 1 ? "end" : "middle"}>{shortDate(t)}</text>
            )}</For>
          </g>
          <line class="own" x1={PAD.l} x2={width() - PAD.r} y1={scales().y(own())} y2={scales().y(own())} />
          <For each={series()}>{(s) => (
            <>
              <path class="series" d={path(s.points)} stroke={s.color} />
              <circle class="marker" r="4" fill={s.color}
                cx={scales().x(s.points[s.points.length - 1].t)} cy={scales().y(s.points[s.points.length - 1].v)} />
            </>
          )}</For>
          <Show when={tip()}>{(tp) => (
            <>
              <line class="hair" x1={scales().x(tp().t)} x2={scales().x(tp().t)} y1={PAD.t} y2={H - PAD.b} />
              <For each={tp().rows}>{(r) => (
                <circle class="marker" r="4" fill={r.color} cx={scales().x(tp().t)} cy={scales().y(r.v!)} />
              )}</For>
            </>
          )}</Show>
        </svg>
        <Show when={tip()}>{(tp) => (
          <div class="tooltip" style={{ left: `${tp().left}px`, top: "14px" }} aria-live="polite">
            <div class="when">{dateTime(tp().t)}</div>
            <For each={tp().rows}>{(r) => (
              <div class="line"><span class="key" style={{ "border-color": r.color }} /><b>{money(String(r.v))}</b><span>{r.name}</span></div>
            )}</For>
            <div class="line"><span class="key dash" /><b>{money(props.own)}</b><span>You</span></div>
          </div>
        )}</Show>
      </div>
      <div class="legend">
        <span><span class="key dash" />You</span>
        <For each={series()}>{(s) => <span><span class="key" style={{ "border-color": s.color }} />{s.name}</span>}</For>
      </div>
    </Show>
  );
}
