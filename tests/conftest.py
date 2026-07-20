import os
# Set before any `app.*` import so app.config.settings picks these up.
os.environ["DISABLE_SCHEDULER"] = "1"
os.environ["SCRAPE_DELAY_SECONDS"] = "0"  # no throttling delay during tests

import pytest


@pytest.fixture(autouse=True)
def _reset_jobs():
    """Background-job state is module-global, so a run started by one test
    would otherwise block or leak into the next."""
    from app import jobs
    jobs.reset()
    yield
    jobs.reset()
