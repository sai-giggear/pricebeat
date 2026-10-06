// HTTP server: the JSON API plus the built web UI from one process.
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { HttpError, routes } from "./api";
import { openDb } from "./db";
import { isRunning, startJob, startScheduler } from "./engine";
import { settings } from "./config";

// Built UI: next to the executable when packaged, web/dist in a checkout.
const DIST = [join(dirname(process.execPath), "web"), resolve(import.meta.dir, "../web/dist")]
  .find((d) => existsSync(join(d, "index.html")));

const json = (data: unknown, status = 200) => Response.json(data ?? null, { status });

function wrap(handler: (req: any) => unknown) {
  return async (req: Request) => {
    try {
      return json(await handler(req));
    } catch (err) {
      if (err instanceof HttpError) return json({ detail: err.message }, err.status);
      console.error(err);
      return json({ detail: err instanceof Error ? err.message : "Server error" }, 500);
    }
  };
}

async function serveUi(req: Request): Promise<Response> {
  if (!DIST) return new Response("UI not built. Run `bun run build`.", { status: 404 });
  const path = decodeURIComponent(new URL(req.url).pathname);
  // Resolve, then require containment, so "/../" can never leave dist.
  const file = resolve(DIST, "." + path);
  if (path !== "/" && file.startsWith(DIST + sep) && (await Bun.file(file).exists())) {
    return new Response(Bun.file(file));
  }
  return new Response(Bun.file(join(DIST, "index.html")));
}

export function start(opts: { port?: number; hostname?: string; catchUp?: boolean } = {}) {
  openDb();
  const server = Bun.serve({
    port: opts.port ?? settings.port,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 255, // discovery and single-product fetches take a while
    routes: Object.fromEntries(Object.entries(routes).map(([path, methods]) =>
      [path, Object.fromEntries(Object.entries(methods).map(([m, h]) => [m, wrap(h!)]))])),
    fetch: (req) => new URL(req.url).pathname.startsWith("/api/")
      ? json({ detail: "Not found" }, 404) : serveUi(req),
  });
  if (process.env.DISABLE_SCHEDULER !== "1") startScheduler();
  // The desktop app only runs while its window is open, so it sweeps whatever
  // came due since last time. Through startJob, so the UI shows progress.
  if ((opts.catchUp ?? process.env.CATCH_UP_ON_LAUNCH === "1") && !isRunning()) startJob(true);
  return server;
}

if (import.meta.main) {
  const server = start();
  console.log(`PriceBeat on ${server.url}`);
}
