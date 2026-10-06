# Fig setup for Windows. Run from this folder in PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
$ErrorActionPreference = "Continue"

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "== Installing tools with winget (skips anything already installed) =="
if (-not (Have "node"))   { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements }
if (-not (Have "ffmpeg")) { winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements }
if (-not (Have "deno"))   { winget install -e --id DenoLand.Deno --accept-source-agreements --accept-package-agreements }
if (-not (Have "yt-dlp")) { winget install -e --id yt-dlp.yt-dlp --accept-source-agreements --accept-package-agreements }
else { winget upgrade -e --id yt-dlp.yt-dlp --accept-source-agreements --accept-package-agreements; yt-dlp -U 2>$null }

# Pick up PATH changes from the installs above
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

Write-Host "== npm install =="
npm install

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host ""
  Write-Host "Created .env - open it and fill in DISCORD_TOKEN and XAI_API_KEY." -ForegroundColor Yellow
}

Write-Host "== Checking everything =="
npm run doctor -- "daft punk one more time"
Write-Host ""
Write-Host "When doctor says All good, start Fig with:  npm start"
