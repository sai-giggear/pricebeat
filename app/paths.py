"""Where things live on disk, split by whether we may write to them.

Packaged as a desktop app, the two directories are far apart: bundled assets are
unpacked to a temp dir that is thrown away on exit, and the install location is
not writable. Running from a checkout they're both just the repo. Nothing here
creates directories — `app.db` does that once, at init, so importing the app has
no side effects on the filesystem.
"""
import os
import sys
from pathlib import Path

APP_NAME = "PriceBeat"


def frozen() -> bool:
    """True when running from a PyInstaller bundle rather than a checkout."""
    return getattr(sys, "frozen", False)


def data_dir() -> Path:
    """Writable per-user directory: the database and .env live here.

    Must not be derived from the current directory — a packaged app is launched
    from wherever the shortcut points — nor from the install location, which is
    read-only under Program Files.
    """
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local"
    else:
        base = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(base) / APP_NAME


def resource_dir() -> Path:
    """Read-only directory holding bundled assets (the built frontend).

    PyInstaller unpacks `datas` under sys._MEIPASS; from a checkout the same
    relative layout starts at the repo root.
    """
    if frozen():
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent
