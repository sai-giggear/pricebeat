// Desktop app: the same server on a random localhost port, shown in a native
// WebView2 window. One code path for dev, single-process and desktop.
import { Application } from "@webviewjs/webview";
import { join } from "node:path";
import { dataDir } from "./server/config";
import { start } from "./server/index";
import iconPath from "./assets/icon.png" with { type: "file" };

// Port 0: the OS picks a free port, so this never collides with a dev server.
// catchUp: the app only runs while its window is open, so on launch it sweeps
// whatever prices came due since last time.
const server = start({ port: 0, catchUp: true });
const origin = server.url.origin;

const app = new Application();
const win = app.createBrowserWindow({ title: "PriceBeat", width: 1320, height: 880 });
try {
  win.setWindowIcon(await Bun.file(iconPath).bytes());
} catch { /* the exe's own icon still shows in the taskbar */ }

/** External links (update download, rival pages) open in the system browser:
 *  the app window has no back button to get out of them. */
function openExternal(url: string): false {
  if (/^https?:\/\//.test(url)) Bun.spawn(["rundll32", "url.dll,FileProtocolHandler", url]);
  return false;
}

const options = {
  url: origin,
  navigationHandler: (url: string) => url.startsWith(origin) || openExternal(url),
  newWindowHandler: (e: { url?: string }) => openExternal(e.url ?? ""),
};
let view;
try {
  // WebView2 keeps its profile next to the exe unless told otherwise, and the
  // install folder may be read-only.
  const webContext = app.createWebContext({ dataDirectory: join(dataDir(), "webview") });
  view = win.createWebview({ ...options, webContext });
} catch {
  // Profile in use: a second window, or a crashed one's helpers still exiting.
  // A private profile only forgets the light/dark choice.
  view = win.createWebview({ ...options, incognito: true });
}

app.on("application-close-requested", () => {
  app.exit();
  server.stop(true);
  process.exit(0);
});
app.run();
void view; // keep a strong reference for the window's lifetime
