// Build the portable desktop app: dist/PriceBeat/PriceBeat.exe (+ web/) and
// dist/PriceBeat-<version>.zip. Windows only, since the window is WebView2.
import { $ } from "bun";
import { cpSync, rmSync } from "node:fs";
import pkg from "../package.json";

const out = "dist/PriceBeat";
rmSync("dist", { recursive: true, force: true });

await $`bun run build`;
await $`bun build desktop.ts --compile --minify --windows-icon=assets/pricebeat.ico --windows-hide-console --windows-title=PriceBeat --windows-version=${pkg.version}.0 --outfile ${out}/PriceBeat.exe`;
cpSync("web/dist", `${out}/web`, { recursive: true });

const zip = `dist/PriceBeat-${pkg.version}.zip`;
await $`powershell -NoProfile -Command Compress-Archive -Path ${out} -DestinationPath ${zip}`;
console.log(`Done: ${out}/PriceBeat.exe\n      ${zip}`);
