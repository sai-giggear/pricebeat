from contextlib import contextmanager
from pathlib import Path
from sqlalchemy import text
from sqlmodel import SQLModel, Session, create_engine
from app.config import settings
import app.models  # noqa: F401  (register tables)

def make_engine(url: str):
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=connect_args)

engine = make_engine(settings.database_url)

# Columns added after the first release. create_all() won't add columns to an
# existing table, so we ALTER them in for SQLite databases created before these
# columns existed. New databases already get them from the model definition.
_ADDED_COLUMNS = {"product": {"brand": "VARCHAR", "category": "VARCHAR",
                              "regular_price": "NUMERIC", "permalink": "VARCHAR"},
                  "competitor": {"site_url": "VARCHAR", "favicon_url": "VARCHAR"},
                  "mapping": {"title": "VARCHAR", "brand": "VARCHAR",
                              "sku": "VARCHAR", "gtin": "VARCHAR", "mpn": "VARCHAR",
                              "match_status": "VARCHAR", "created_at": "DATETIME",
                              "last_checked_at": "DATETIME",
                              "check_interval_hours": "FLOAT DEFAULT 24.0"},
                  "pricesnapshot": {"shipping": "NUMERIC", "stock_status": "VARCHAR",
                                    "condition": "VARCHAR"}}

# Legacy columns removed from the models; dropped from older DBs on startup.
_DROPPED_COLUMNS = {"competitor": ["source_type"], "mapping": ["status"]}

# create_all() only builds indexes for tables it creates, so indexes added after
# the first release need the same treatment as added columns.
_ADDED_INDEXES = {"ix_pricesnapshot_mapping_fetched":
                  "pricesnapshot (mapping_id, fetched_at)"}

# Superseded by a composite index that covers the same lookups.
_DROPPED_INDEXES = ["ix_pricesnapshot_mapping_id"]

def _apply_sqlite_migrations(eng) -> None:
    if not eng.url.get_backend_name().startswith("sqlite"):
        return
    with eng.begin() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            existing = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            for name, coltype in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {coltype}"))
        for table, columns in _DROPPED_COLUMNS.items():
            existing = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            for name in columns:
                if name in existing:
                    conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {name}"))
        for name, target in _ADDED_INDEXES.items():
            conn.execute(text(f"CREATE INDEX IF NOT EXISTS {name} ON {target}"))
        for name in _DROPPED_INDEXES:
            conn.execute(text(f"DROP INDEX IF EXISTS {name}"))

def _ensure_db_dir(eng) -> None:
    """Create the directory holding the SQLite file. The packaged app keeps its
    database in a per-user directory that doesn't exist until first launch, and
    SQLite won't create a missing parent for us."""
    if not eng.url.get_backend_name().startswith("sqlite"):
        return
    database = eng.url.database
    if database and database != ":memory:":
        Path(database).parent.mkdir(parents=True, exist_ok=True)

def init_db() -> None:
    _ensure_db_dir(engine)
    SQLModel.metadata.create_all(engine)
    _apply_sqlite_migrations(engine)

@contextmanager
def get_session():
    with Session(engine) as session:
        yield session
