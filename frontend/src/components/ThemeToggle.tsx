import { createSignal } from "solid-js";

// The initial theme is set pre-paint by an inline script in index.html (to avoid
// a flash), which stamps data-theme on <html>. This just reads and flips it.
const current = () => document.documentElement.getAttribute("data-theme") ?? "light";

export default function ThemeToggle() {
  const [theme, setTheme] = createSignal(current());

  const toggle = () => {
    const next = theme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    setTheme(next);
  };

  return (
    <button
      class="theme-toggle"
      type="button"
      onClick={toggle}
      title={theme() === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle colour theme"
    >
      {theme() === "dark" ? "☀" : "☾"}
    </button>
  );
}
