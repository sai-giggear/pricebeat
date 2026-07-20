import { Show } from "solid-js";

/** Tiny inline price-trend line: single series, no axes, accent-colored.
 *  Decorative by design — the exact figures sit in the same row and in the
 *  price-history log, so the SVG is hidden from assistive tech. */
export default function Sparkline(props: {
  points: number[];
  width?: number;
  height?: number;
}) {
  const w = () => props.width ?? 96;
  const h = () => props.height ?? 28;
  const pad = 4;

  const coords = () => {
    const pts = props.points;
    if (pts.length === 0) return [] as [number, number][];
    if (pts.length === 1) return [[w() / 2, h() / 2]] as [number, number][];
    const min = Math.min(...pts);
    const max = Math.max(...pts);
    const step = (w() - pad * 2) / (pts.length - 1);
    // A flat series draws as a midline rather than hugging an edge.
    const norm = (v: number) => (max === min ? 0.5 : (v - min) / (max - min));
    return pts.map(
      (v, i) => [pad + i * step, pad + (1 - norm(v)) * (h() - pad * 2)] as [number, number],
    );
  };

  const last = () => coords()[coords().length - 1];

  return (
    <Show when={coords().length > 0} fallback={<span class="muted">—</span>}>
      <svg
        class="spark"
        width={w()}
        height={h()}
        viewBox={`0 0 ${w()} ${h()}`}
        aria-hidden="true"
      >
        <Show when={coords().length > 1}>
          <polyline points={coords().map((c) => c.join(",")).join(" ")} />
        </Show>
        <circle cx={last()[0]} cy={last()[1]} r="3" />
      </svg>
    </Show>
  );
}
