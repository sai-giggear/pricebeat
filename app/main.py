import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from app import db, jobs, paths
from app.config import settings
from app.engine import background_run
from app.routes import all_routers


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    if settings.catch_up_on_launch:
        # The desktop app is only running while its window is open, so anything
        # that came due since last time has to be picked up now. Started as a
        # background job rather than awaited: it takes minutes, and going
        # through jobs.start means the UI's existing /api/track/status polling
        # shows it with no frontend changes.
        try:
            jobs.start(background_run(due_only=True))
        except jobs.AlreadyRunning:
            pass
    scheduler = None
    if os.environ.get("DISABLE_SCHEDULER") != "1":
        from app.scheduler import start_scheduler
        scheduler = start_scheduler()
    yield
    if scheduler is not None:
        scheduler.shutdown(wait=False)


app = FastAPI(title="PriceBeat", lifespan=lifespan)
for router in all_routers:
    app.include_router(router)

# ---- serve the built SPA ---------------------------------------------------
# The SolidJS app builds to frontend/dist. In dev you run Vite separately
# (bun run dev) and hit the API through its proxy; this serving is for the
# single-process production run after `bun run build`, and for the packaged
# desktop app, where the same tree is unpacked under a temp dir instead.

_DIST = paths.resource_dir() / "frontend" / "dist"
if (_DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=str(_DIST / "assets")), name="assets")


@app.get("/{full_path:path}")
def spa(full_path: str):
    index = _DIST / "index.html"
    if not index.is_file():
        raise HTTPException(status_code=404,
            detail="Frontend not built. Run `bun run build` in frontend/.")
    # Resolve and require containment in dist: an encoded ".." in the URL must
    # never reach files outside the built frontend.
    try:
        candidate = (_DIST / full_path).resolve()
        serve_file = bool(full_path) and candidate.is_relative_to(_DIST) \
            and candidate.is_file()
    except (OSError, ValueError):  # unresolvable path (bad characters etc.)
        serve_file = False
    if serve_file:
        return FileResponse(str(candidate))
    return FileResponse(str(index))
