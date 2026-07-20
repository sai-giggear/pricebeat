import { createResource, Show } from "solid-js";
import { api } from "../api";

// Nothing renders unless a newer release exists, which is the normal state — an
// app that permanently displays its own version number is just noise in the top
// bar. If the check fails (offline, GitHub down) the resource errors and this
// stays empty, which is the same as "nothing to report".
export default function UpdateBadge() {
  const [info] = createResource(api.version);
  const update = () => (info()?.update_available ? info() : undefined);

  return (
    <Show when={update()}>
      {(v) => (
        <a
          class="update-badge"
          href={v().url}
          // Opens in the system browser: pywebview sends external links there
          // (see app/desktop.py), and a normal browser tab in dev.
          target="_blank"
          rel="noreferrer"
          title={`PriceBeat ${v().latest} is available — you're on ${v().current}. Opens the download page.`}
        >
          <span class="update-dot" aria-hidden="true" />
          {v().latest} available
        </a>
      )}
    </Show>
  );
}
