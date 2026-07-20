from pydantic_settings import BaseSettings, SettingsConfigDict
from app import paths

# Packaged, there is no repo directory to read a .env from and the working
# directory is wherever the shortcut points, so both defaults have to be
# absolute. From a checkout the old relative behaviour is kept.
_ENV_FILE = str(paths.data_dir() / ".env") if paths.frozen() else ".env"
_DEFAULT_DB = f"sqlite:///{(paths.data_dir() / 'price_tracker.db').as_posix()}"

class Settings(BaseSettings):
    database_url: str = _DEFAULT_DB
    # Delay between requests to the *same* competitor host (politeness). Hosts
    # are fetched in parallel, so this no longer throttles the whole run.
    scrape_delay_seconds: float = 1.0
    # How many competitor hosts to fetch from at once.
    max_concurrent_hosts: int = 8
    # Price history older than this is pruned after a run; the newest snapshot
    # per mapping is always kept, so current prices survive. 0 disables pruning.
    snapshot_retention_days: int = 180
    # Sweep whatever is due as soon as the app starts. Off by default so dev
    # reloads and tests don't hit the network; the desktop entry point sets it,
    # since a launch-and-check app has no other chance to catch up.
    catch_up_on_launch: bool = False
    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore")

settings = Settings()
