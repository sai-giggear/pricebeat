from app.config import settings
from app.db import init_db, get_session

def test_settings_defaults():
    assert settings.database_url.startswith("sqlite")
    assert settings.scrape_delay_seconds >= 0

def test_init_db_and_session(tmp_path, monkeypatch):
    from app import db
    monkeypatch.setattr(db, "engine", db.make_engine(f"sqlite:///{tmp_path/'t.db'}"))
    db.init_db()
    with db.get_session() as s:
        assert s is not None
