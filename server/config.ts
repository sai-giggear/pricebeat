// Settings come from the environment. Bun loads .env from the working
// directory on its own, so a checkout's .env works with no extra code.
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

export const VERSION = pkg.version;

/** Writable per-user directory for the database. Never derived from the
 *  working directory: the desktop app is launched from wherever its shortcut
 *  points, and its install folder may be read-only. */
export function dataDir(): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "PriceBeat");
}

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(v) ? v : fallback;
};

export const settings = {
  // A plain file path. ":memory:" works for tests.
  databasePath: process.env.DATABASE_PATH || join(dataDir(), "price_tracker.db"),
  // Delay between requests to the *same* competitor host. Hosts run in
  // parallel, so this doesn't throttle the whole run.
  scrapeDelayMs: num("SCRAPE_DELAY_SECONDS", 1) * 1000,
  maxConcurrentHosts: Math.max(1, num("MAX_CONCURRENT_HOSTS", 8)),
  // History older than this is pruned after a run. 0 disables pruning.
  snapshotRetentionDays: num("SNAPSHOT_RETENTION_DAYS", 180),
  port: num("PORT", 8000),
};
