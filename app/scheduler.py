from apscheduler.schedulers.background import BackgroundScheduler
import asyncio
from app import db, jobs
from app.engine import prune_snapshots, run_tracking

def start_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler()
    def _job():
        try:
            # A manual "Fetch all" may be in flight; skip rather than queue
            # behind it — the next sweep picks up whatever is still due.
            with jobs.exclusive():
                with db.get_session() as s:
                    # Hourly sweep that only fetches mappings whose adaptive
                    # interval says they're due — volatile prices get checked
                    # every few hours, stable ones back off to every few days.
                    asyncio.run(run_tracking(s, due_only=True))
                    prune_snapshots(s)
        except jobs.AlreadyRunning:
            return
    scheduler.add_job(_job, "interval", hours=1, id="due_track", replace_existing=True)
    scheduler.start()
    return scheduler
