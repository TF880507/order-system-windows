param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$DumpPath
)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = (Resolve-Path -LiteralPath $DumpPath).Path
$importDirectory = Join-Path $projectDirectory 'imports'
$containerDump = Join-Path $importDirectory 'legacy-dump.sql'
New-Item -ItemType Directory -Path $importDirectory -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $containerDump -Force

$securePassword = Read-Host '請設定舊會員的臨時登入密碼（至少 8 字元）' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ($plainPassword.Length -lt 8) { throw '臨時密碼至少需要 8 個字元。' }
  $env:LEGACY_MEMBER_PASSWORD = $plainPassword
  Push-Location $projectDirectory
  try {
    docker compose exec -e LEGACY_MEMBER_PASSWORD order-system node scripts/import-legacy-dump.js --dump /imports/legacy-dump.sql
    if ($LASTEXITCODE -ne 0) { throw '舊資料匯入失敗，請查看上方訊息。' }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item Env:LEGACY_MEMBER_PASSWORD -ErrorAction SilentlyContinue
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

Write-Host '舊資料匯入完成。' -ForegroundColor Green
