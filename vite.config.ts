import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: "web",
  plugins: [solid()],
  // Dev: the API runs on :8000 (bun run dev:api); Vite proxies to it.
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  build: { outDir: "dist", emptyOutDir: true },
});
