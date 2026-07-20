"""Desktop entry point: the API in a background thread, a native window on top.

The app stays a normal FastAPI service — the window is just a WebView2 view of
it on localhost. That keeps one code path for dev, single-process, and desktop.
"""
import os
import socket
import sys
import threading
import time

# Must be set before app.config is imported, so Settings picks it up. The
# desktop app is only alive while its window is open, so it has to sweep
# whatever came due since the last launch.
os.environ.setdefault("CATCH_UP_ON_LAUNCH", "1")

import uvicorn
import webview
from app.main import app

WINDOW_TITLE = "PriceBeat"
STARTUP_TIMEOUT_SECONDS = 30


def _wait_for_port(server: uvicorn.Server, thread: threading.Thread) -> int:
    """Block until the server is listening, then report the port it got.

    We bind port 0 and read the assignment back rather than picking a free port
    ourselves: choosing one up front leaves a window in which something else can
    take it, and a fixed port would collide with a dev server on :8000.
    """
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if server.started:
            for listener in server.servers:
                for sock in listener.sockets:
                    if sock.family in (socket.AF_INET, socket.AF_INET6):
                        return sock.getsockname()[1]
        if not thread.is_alive():
            raise RuntimeError("API server thread exited during startup")
        time.sleep(0.05)
    raise RuntimeError(f"API server did not start within {STARTUP_TIMEOUT_SECONDS}s")


def main() -> int:
    # The update badge links to github.com. This is pywebview's default, but
    # pinned here because the badge depends on it: without it the release page
    # would load inside the app window, which has no back button to escape it.
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True

    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="pricebeat-api", daemon=True)
    thread.start()

    port = _wait_for_port(server, thread)
    webview.create_window(WINDOW_TITLE, f"http://127.0.0.1:{port}",
                          width=1280, height=860, min_size=(960, 600))
    webview.start()  # returns once the user closes the window

    # Shut the server down rather than relying on the daemon flag, so lifespan
    # teardown runs and the scheduler stops its thread.
    server.should_exit = True
    thread.join(timeout=10)
    return 0


if __name__ == "__main__":
    sys.exit(main())
