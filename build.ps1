#!/usr/bin/env pwsh
# PriceBeat — build the portable desktop app.
# Produces dist\PriceBeat\ (run PriceBeat.exe) and dist\PriceBeat-<version>.zip.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$python = ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "No venv at $python — see README first-time setup." }

Write-Host "Building frontend..." -ForegroundColor Cyan
Push-Location frontend
try { bun run build; if ($LASTEXITCODE -ne 0) { throw "bun run build failed" } }
finally { Pop-Location }

Write-Host "Packaging with PyInstaller..." -ForegroundColor Cyan
& $python -m PyInstaller --noconfirm --clean pricebeat.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

# build\ holds an intermediate PriceBeat.exe that looks exactly like the real
# one but has no _internal\ beside it, so running it fails with a confusing
# "Failed to load Python DLL". --clean already discards the cache each run, so
# there is nothing to keep here.
Remove-Item build -Recurse -Force -ErrorAction SilentlyContinue

# Version comes from app/__init__.py — the same constant the app reports to its
# update check — so the zip name can't drift from what the build says it is.
$version = (Select-String -Path app\__init__.py -Pattern '^__version__ = "(.+)"').Matches[0].Groups[1].Value
$zip = "dist\PriceBeat-$version.zip"
Write-Host "Zipping to $zip..." -ForegroundColor Cyan
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "dist\PriceBeat" -DestinationPath $zip

Write-Host "Done: dist\PriceBeat\PriceBeat.exe" -ForegroundColor Green
Write-Host "      $zip" -ForegroundColor Green
