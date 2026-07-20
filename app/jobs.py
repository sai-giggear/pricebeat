"""In-process registry for the one long-running job this app has: a full
tracking run.

A full run fetches every mapping and takes minutes, which is far too long to
hold an HTTP request open — the route starts it as a task and hands back a
status the UI polls. Only one run happens at a time: concurrent runs would
double-write snapshots and fight over the SQLite write lock. The guard is a
threading lock rather than an asyncio one because the scheduler sweeps from its
own thread, outside the event loop.
"""
from __future__ import annotations
import asyncio
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

# Jobs live in memory, so a restart forgets them; keep a short tail for the UI
# to read a finished run's result, not a history.
_KEEP = 10


class AlreadyRunning(RuntimeError):
    """A tracking run is already in flight."""


@dataclass
class Job:
    id: int
    state: str = "running"  # "running" | "done" | "error"
    done: int = 0
    total: int = 0
    started_at: str = ""
    finished_at: str | None = None
    summary: dict[str, Any] | None = None
    error: str | None = None

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "state": self.state, "done": self.done,
                "total": self.total, "started_at": self.started_at,
                "finished_at": self.finished_at, "summary": self.summary,
                "error": self.error}


_jobs: dict[int, Job] = {}
_order: list[int] = []
_tasks: dict[int, asyncio.Task] = {}
_next_id = 0
_run_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def exclusive():
    """Hold the single-run slot, or raise AlreadyRunning. Used directly by the
    scheduler thread, and via ``start`` by the API."""
    if not _run_lock.acquire(blocking=False):
        raise AlreadyRunning("A tracking run is already in progress")
    try:
        yield
    finally:
        _run_lock.release()


def reset() -> None:
    """Drop all job state — for tests, which must not inherit each other's runs."""
    _jobs.clear()
    _order.clear()
    _tasks.clear()
    if _run_lock.locked():
        _run_lock.release()


def latest() -> Job | None:
    return _jobs[_order[-1]] if _order else None


def get(job_id: int) -> Job | None:
    return _jobs.get(job_id)


def start(run: Callable[[Callable[[int, int], None]], Awaitable[dict]]) -> Job:
    """Run ``run(progress)`` in the background as a job. ``progress(done, total)``
    updates the job the UI polls. Raises AlreadyRunning if one is in flight."""
    global _next_id
    if not _run_lock.acquire(blocking=False):
        raise AlreadyRunning("A tracking run is already in progress")
    _next_id += 1
    job = Job(id=_next_id, started_at=_now())
    _jobs[job.id] = job
    _order.append(job.id)
    for stale in _order[:-_KEEP]:
        _jobs.pop(stale, None)
        _tasks.pop(stale, None)
    del _order[:-_KEEP]

    def progress(done: int, total: int) -> None:
        job.done, job.total = done, total

    async def wrapper() -> None:
        try:
            job.summary = await run(progress)
            job.state = "done"
        except Exception as exc:  # a failed run must not kill the event loop
            job.state, job.error = "error", str(exc) or exc.__class__.__name__
        finally:
            job.finished_at = _now()
            _run_lock.release()

    _tasks[job.id] = asyncio.ensure_future(wrapper())
    return job
