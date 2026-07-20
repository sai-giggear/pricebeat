import { createSignal, Show } from "solid-js";

/** A competitor's favicon, with a lettered fallback when it's missing or fails. */
export default function Favicon(props: { src: string | null; name: string }) {
  const [failed, setFailed] = createSignal(false);
  const initial = () => (props.name.trim()[0] || "?").toUpperCase();
  return (
    <Show
      when={props.src && !failed()}
      fallback={<span class="favicon favicon-fallback">{initial()}</span>}
    >
      <img
        class="favicon"
        src={props.src!}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </Show>
  );
}
