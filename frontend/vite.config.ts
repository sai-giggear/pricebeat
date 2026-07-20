import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  server: {
    // In dev, proxy API calls to the FastAPI backend (uvicorn on :8000).
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
  build: {
    // Emitted to frontend/dist, which FastAPI serves in single-process mode.
    outDir: "dist",
    emptyOutDir: true,
  },
});
