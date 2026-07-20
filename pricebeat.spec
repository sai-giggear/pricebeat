# PyInstaller spec for the PriceBeat desktop app. Build with `.\build.ps1`,
# which builds the frontend first — frontend/dist is bundled as data below and
# a stale or missing dist would ship a broken UI.
from PyInstaller.utils.hooks import collect_all

datas = [("frontend/dist", "frontend/dist")]
binaries = []
hiddenimports = []

# These four resolve parts of themselves at runtime by name, so static analysis
# alone misses them:
#   uvicorn    - loads loop/protocol/lifespan implementations from strings
#   apscheduler- looks up job stores and executors through entry points
#   selectolax - compiled extension whose binaries must be collected explicitly
#   webview    - per-platform backends plus bundled JS assets
# (app/routes/__init__.py imports every router statically, so those are fine.)
for package in ("uvicorn", "apscheduler", "selectolax", "webview"):
    pkg_datas, pkg_binaries, pkg_hiddenimports = collect_all(package)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hiddenimports

a = Analysis(
    ["app/desktop.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PriceBeat",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # no console window behind the app
    # The swing tag on money green, same mark as the favicon in
    # frontend/index.html. Without this PyInstaller stamps its own icon on the
    # exe. Windows also takes the window and taskbar icon from here.
    icon="assets/pricebeat.ico",
)

# onedir, not onefile: onefile re-extracts the whole bundle to a temp directory
# on every launch, which is the wrong trade for an app you open, glance at, and
# close again.
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="PriceBeat",
)
