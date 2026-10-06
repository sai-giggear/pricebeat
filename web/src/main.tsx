import { render } from "solid-js/web";
import { A, Route, Router, type RouteSectionProps } from "@solidjs/router";
import { createResource, createSignal, onMount, Show } from "solid-js";
import { api, fetchAll, job, resumeRun, running } from "./api";
import { Awning, MoonIcon, RefreshIcon, SunIcon } from "./components/ui";
import Products from "./pages/Products";
import Competitors from "./pages/Competitors";
import Settings from "./pages/Settings";
import "./styles.css";

function ThemeToggle() {
  const [dark, setDark] = createSignal(document.documentElement.dataset.theme === "dark");
  const flip = () => {
    const next = dark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
    setDark(!dark());
  };
  return (
    <button class="btn quiet icon" onClick={flip} aria-label={dark() ? "Switch to light mode" : "Switch to dark mode"}>
      {dark() ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/** Shows only when a newer release exists. A failed check shows nothing. */
function UpdateBadge() {
  const [info] = createResource(() => api.version().catch(() => null));
  return (
    <Show when={info()?.update_available && info()}>{(v) => (
      <a class="update" href={v().url} target="_blank" rel="noreferrer"
        title={`You're on ${v().current}. Opens the download page.`}>Version {v().latest} is out</a>
    )}</Show>
  );
}

function FetchAll() {
  const label = () => {
    const j = job();
    if (!running()) return "Fetch all prices";
    return j?.total ? `Fetching ${j.done} of ${j.total}` : "Starting…";
  };
  return (
    <button class="btn primary" disabled={running()} onClick={fetchAll}
      title="Fetch every tracked rival price now">
      <RefreshIcon spinning={running()} />{label()}
    </button>
  );
}

function Layout(props: RouteSectionProps) {
  onMount(resumeRun);
  const productsActive = () => props.location.pathname === "/" || props.location.pathname.startsWith("/p/");
  return (
    <>
      <header class="top">
        <A href="/" class="brand"><span class="brand-mark"><Awning /></span><span>PriceBeat</span></A>
        <nav class="nav" aria-label="Main">
          <A href="/" class={productsActive() ? "active" : undefined} activeClass="">Products</A>
          <A href="/competitors" activeClass="active">Competitors</A>
          <A href="/settings" activeClass="active">Settings</A>
        </nav>
        <span class="spacer" />
        <div class="top-actions">
          <UpdateBadge />
          <FetchAll />
          <ThemeToggle />
        </div>
      </header>
      {props.children}
    </>
  );
}

render(() => (
  <Router root={Layout}>
    <Route path={["/", "/p/:id"]} component={Products} />
    <Route path="/competitors" component={Competitors} />
    <Route path="/settings" component={Settings} />
    <Route path="*" component={Products} />
  </Router>
), document.getElementById("root")!);
