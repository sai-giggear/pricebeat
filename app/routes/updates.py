"""Version reporting for the topbar's update badge."""
from fastapi import APIRouter
from app import updates

router = APIRouter()


@router.get("/api/version")
async def api_version() -> updates.UpdateStatus:
    # Answers in microseconds once cached, so the UI can ask on every load.
    return await updates.status()
