import { A, useLocation } from "@solidjs/router";
import type { JSX } from "solid-js";
import Logo from "./Logo";
import ThemeToggle from "./ThemeToggle";
import UpdateBadge from "./UpdateBadge";

// Data-dense pages use the full screen width; forms read better kept narrow,
// so they fall back to the default contained width. Product detail is wide —
// its competitor table carries five columns.
const WIDE_ROUTES = ["/", "/competitors"];

export default function Layout(props: { children?: JSX.Element }) {
  const location = useLocation();
  const wide = () =>
    WIDE_ROUTES.includes(location.pathname) ||
    location.pathname.startsWith("/product");
  return (
    <div class="shell">
      <a class="skip-link" href="#main-content">Skip to content</a>
      <header class="topbar">
        <A href="/" end class="brand">
          <Logo />
          PriceBeat
        </A>
        <nav class="topnav">
          {/* Product-detail routes live under "/product/…", so the router's
              own matching can't mark this tab; compute it from the path. */}
          <A
            href="/"
            activeClass="noop"
            class={
              location.pathname === "/" || location.pathname.startsWith("/product")
                ? "active"
                : undefined
            }
          >
            Products
          </A>
          <A href="/competitors" activeClass="active">
            Competitors
          </A>
          <A href="/settings" activeClass="active">
            Settings
          </A>
        </nav>
        <span class="spacer" />
        <UpdateBadge />
        <ThemeToggle />
      </header>
      <main class="main" id="main-content" tabindex="-1">
        <div class="main-inner" classList={{ wide: wide() }}>{props.children}</div>
      </main>
    </div>
  );
}
