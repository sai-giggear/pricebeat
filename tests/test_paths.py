"""The packaged app runs from an arbitrary working directory, so every path it
uses has to be absolute and anchored to something other than the CWD."""
import sys
from pathlib import Path

from app import paths


def test_data_dir_is_absolute_and_named():
    d = paths.data_dir()
    assert d.is_absolute()
    assert d.name == "PriceBeat"


def test_data_dir_follows_localappdata_on_windows(monkeypatch):
    if sys.platform != "win32":
        return
    monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\someone\AppData\Local")
    assert paths.data_dir() == Path(r"C:\Users\someone\AppData\Local\PriceBeat")


def test_resource_dir_is_repo_root_when_not_frozen():
    # app/paths.py lives one level down, so the parent holds frontend/.
    assert paths.resource_dir() == Path(paths.__file__).resolve().parent.parent
    assert not paths.frozen()


def test_resource_dir_follows_meipass_when_frozen(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(Path.cwd() / "unpacked"), raising=False)
    assert paths.frozen()
    assert paths.resource_dir() == Path.cwd() / "unpacked"


def test_database_url_default_is_absolute():
    """A relative sqlite URL would put the DB wherever the shortcut points."""
    from app.config import _DEFAULT_DB
    assert _DEFAULT_DB.startswith("sqlite:///")
    assert Path(_DEFAULT_DB.removeprefix("sqlite:///")).is_absolute()


def test_catch_up_is_off_by_default():
    """Keeps dev reloads and the test suite from firing real scrape traffic;
    only app/desktop.py turns it on."""
    from app.config import Settings
    assert Settings().catch_up_on_launch is False
