#!/usr/bin/env pwsh
# PriceBeat — dev mode with hot reload.
# Runs the FastAPI backend (auto-reload) and the Vite dev server (HMR) together.
# Open http://localhost:5173 — the Vite server proxies /api to uvicorn on :8000.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Starting backend (uvicorn --reload) on http://localhost:8000" -ForegroundColor Cyan
$backend = Start-Process -PassThru -NoNewWindow `
    -FilePath ".venv\Scripts\python.exe" `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--reload", "--port", "8000"

try {
    Write-Host "Starting frontend (Vite HMR) on http://localhost:5173" -ForegroundColor Green
    Push-Location frontend
    bun run dev
    Pop-Location
}
finally {
    Write-Host "Stopping backend..." -ForegroundColor Yellow
    if ($backend -and -not $backend.HasExited) {
        Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
    }
}
