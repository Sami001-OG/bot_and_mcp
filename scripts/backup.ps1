param([string]$OutDir)

$ErrorActionPreference = 'Stop'
$PG_BIN = 'C:\Program Files\PostgreSQL\17\bin'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $ScriptDir) 'backups' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$envLine = Get-Content (Join-Path (Split-Path -Parent $ScriptDir) '.env') | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
if (-not $envLine) { Write-Error 'DATABASE_URL not found in .env'; exit 1 }
$dbUrl = $envLine.Substring('DATABASE_URL='.Length)
$dbUrl = $dbUrl.Split('?')[0]

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $OutDir "tradingbot-$stamp.dump"
Write-Host "Dumping to $file ..."
& "$PG_BIN\pg_dump.exe" --no-owner --no-privileges --format=custom --file="$file" $dbUrl
if ($LASTEXITCODE -ne 0) { Write-Error 'pg_dump failed'; exit 1 }
$size = [Math]::Round((Get-Item $file).Length / 1KB, 1)
Write-Host "Done. Backup: $file ($size KB)"
Write-Host "Restore: & `"$PG_BIN\pg_restore.exe`" --clean --if-exists --no-owner -d <DATABASE_URL> `"$file`""