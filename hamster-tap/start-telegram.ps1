#Requires -Version 5.1
<#
  Hamster Tap — запуск в Telegram одной командой.

  Порядок работы (важен именно такой: у quick-туннеля должен сразу быть живой origin,
  иначе Cloudflare снимает DNS-запись и адрес перестаёт открываться):
    1. Проверяет .env (токен) и доступность api.telegram.org.
    2. Поднимает локальный сервер и ждёт его ответа на /api/health.
    3. Поднимает туннель cloudflared и вытаскивает публичный https-адрес.
    4. Записывает адрес в .env и ждёт готовности канала (ограниченное время).
    5. Настраивает кнопку меню «Играть» и команды через Bot API (BotFather не нужен).
    6. Показывает логи сервера в этом же окне.

  Запуск:
    powershell -ExecutionPolicy Bypass -File .\start-telegram.ps1
    powershell -ExecutionPolicy Bypass -File .\start-telegram.ps1 -TunnelUrl https://my.example.com
    powershell -ExecutionPolicy Bypass -File .\start-telegram.ps1 -NoTunnel   # адрес уже в .env
    powershell -ExecutionPolicy Bypass -File .\start-telegram.ps1 -SkipBot    # сервер без бота

  Остановка: Ctrl+C — сервер и туннель закрываются автоматически.
#>
param(
  [int]$Port = 0,
  [string]$TunnelUrl = '',
  [switch]$NoTunnel,
  [switch]$SkipBot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$envFile = Join-Path $root '.env'
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$serverOut = Join-Path $dataDir 'server.out.log'
$serverErr = Join-Path $dataDir 'server.err.log'
$tunnelOut = Join-Path $dataDir 'tunnel.out.log'
$tunnelErr = Join-Path $dataDir 'tunnel.err.log'

function Write-Step([string]$text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "  ok  $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "  !!  $text" -ForegroundColor Yellow }
function Write-Dim([string]$text) { Write-Host "      $text" -ForegroundColor DarkGray }
function Fail([string]$text, [string]$hint) {
  Write-Host "`n[x] $text" -ForegroundColor Red
  if ($hint) { Write-Host "    $hint" -ForegroundColor Yellow }
  exit 1
}

# Читаем .env в хэш-таблицу (KEY=VALUE, строки с # — комментарии).
function Read-Env {
  $map = @{}
  if (-not (Test-Path $envFile)) { return $map }
  foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -lt 1) { continue }
    $key = $trimmed.Substring(0, $idx).Trim()
    $value = $trimmed.Substring($idx + 1).Trim().Trim('"').Trim("'")
    $map[$key] = $value
  }
  return $map
}

# Обновляем одно поле в .env, сохраняя комментарии; пишем UTF-8 без BOM.
function Set-EnvValue([string]$key, [string]$value) {
  $lines = @()
  if (Test-Path $envFile) { $lines = @(Get-Content -LiteralPath $envFile -Encoding UTF8) }
  $replaced = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") {
      $lines[$i] = "$key=$value"
      $replaced = $true
    }
  }
  if (-not $replaced) { $lines += "$key=$value" }
  [System.IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

# Проверка TCP до конкретного хоста/порта (без внешних модулей).
function Test-Tcp([string]$host_, [int]$port_, [int]$timeoutMs = 5000) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($host_, $port_)
    if (-not $task.Wait($timeoutMs)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

# HTTP-проверка через curl.exe: у него жёсткий таймаут, в отличие от Invoke-WebRequest,
# который может надолго зависнуть на DNS-ошибке.
function Test-Http([string]$url, [int]$timeoutSec = 10) {
  $code = & curl.exe -s -o NUL -w '%{http_code}' --max-time $timeoutSec $url 2>$null
  return ($code -eq '200')
}

# IPv4-адреса edge Cloudflare: все имена *.trycloudflare.com живут на них же.
# Нужны, когда свежий quick-туннель опубликован в DNS только как AAAA (IPv6),
# а IPv6-маршрута в сети нет: тогда обычный запрос не проходит, хотя туннель жив.
function Get-EdgeIps {
  $ips = @()
  try {
    $ips = @(Resolve-DnsName 'trycloudflare.com' -Type A -ErrorAction Stop |
      Select-Object -ExpandProperty IPAddress)
  } catch {
    # если и это не разрешилось — берём известные адреса edge Cloudflare
  }
  if (-not $ips -or $ips.Count -eq 0) { $ips = @('104.16.230.132', '104.16.231.132') }
  return $ips
}

# Готов ли канал: пробуем обычный адрес, затем — тот же адрес через IP edge с SNI.
function Test-TunnelReady([string]$url) {
  if (Test-Http "$url/api/health" 8) { return 'dns' }
  $name = ([Uri]$url).Host
  foreach ($ip in (Get-EdgeIps)) {
    $code = & curl.exe -s -o NUL -w '%{http_code}' --max-time 8 `
      --resolve "${name}:443:$ip" "$url/api/health" 2>$null
    if ($code -eq '200') { return 'edge' }
  }
  return $false
}

function Find-Cloudflared {
  $command = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    'C:\Program Files (x86)\cloudflared\cloudflared.exe',
    'C:\Program Files\cloudflared\cloudflared.exe',
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  # Последняя попытка — спросить Windows, где лежит исполняемый файл.
  $where = & where.exe cloudflared 2>$null
  if ($where) { return ($where | Select-Object -First 1) }
  return $null
}

# --- 1. Настройки ---

Write-Step 'Проверяем настройки'
$settings = Read-Env
$effectivePort = if ($Port -gt 0) { $Port } elseif ($settings['PORT']) { [int]$settings['PORT'] } else { 8020 }
$botToken = $settings['BOT_TOKEN']

if (-not $botToken) {
  Fail 'BOT_TOKEN не задан в .env' @"
  1) Откройте https://t.me/BotFather и отправьте /newbot.
  2) Скопируйте токен вида 123456789:AA... в файл .env (строка BOT_TOKEN=).
  3) Запустите этот скрипт снова — юзернейм и публичный адрес он подставит сам.
"@
}
Write-Ok "порт сервера: $effectivePort"
Write-Ok ("токен бота найден (…{0})" -f $botToken.Substring([Math]::Max(0, $botToken.Length - 6)))

if (Test-Tcp 'api.telegram.org' 443) {
  Write-Ok 'Bot API доступен'
} else {
  Write-Warn 'api.telegram.org недоступен: включите VPN — иначе бот не получит сообщения.'
  Write-Warn 'Сервер и мини-апп поднимутся, но останутся без бота.'
}

# --- 2. Локальный сервер (обязательно до туннеля) ---

Write-Step 'Запускаем локальный сервер'
Remove-Item $serverOut, $serverErr -ErrorAction SilentlyContinue
$nodeArgs = @('server.js')
if (-not $SkipBot) { $nodeArgs += '--bot' }

$serverProcess = Start-Process -FilePath 'node' -ArgumentList $nodeArgs -WorkingDirectory $root `
  -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru -WindowStyle Hidden

$localReady = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 700
  if (Test-Http "http://localhost:$effectivePort/api/health" 5) { $localReady = $true; break }
  if ($serverProcess.HasExited) {
    $log = if (Test-Path $serverErr) { Get-Content $serverErr -Raw -Encoding UTF8 } else { '' }
    Fail 'сервер завершился при запуске' $log
  }
}
if (-not $localReady) { Fail "сервер не ответил на http://localhost:$effectivePort/api/health" "Лог: $serverErr" }
Write-Ok "сервер отвечает: http://localhost:$effectivePort (pid $($serverProcess.Id))"

# --- 3. Туннель и публичный адрес ---

$tunnelProcess = $null
$publicUrl = ''

function Start-Tunnel([int]$localPort) {
  $exe = Find-Cloudflared
  if (-not $exe) {
    Fail 'cloudflared не найден' 'Установите: winget install --id Cloudflare.cloudflared -e'
  }
  Remove-Item $tunnelOut, $tunnelErr -ErrorAction SilentlyContinue
  Write-Dim "туннель: $exe"

  $process = Start-Process -FilePath $exe `
    -ArgumentList @('tunnel', '--url', "http://localhost:$localPort", '--no-autoupdate') `
    -RedirectStandardOutput $tunnelOut -RedirectStandardError $tunnelErr `
    -PassThru -WindowStyle Hidden

  # cloudflared печатает публичный адрес в stderr; ждём его до 60 секунд.
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Seconds 1
    if ($process.HasExited) {
      $log = if (Test-Path $tunnelErr) { Get-Content $tunnelErr -Raw -Encoding UTF8 } else { '' }
      Fail 'cloudflared завершился сразу после запуска' $log
    }
    $log = ''
    foreach ($file in @($tunnelErr, $tunnelOut)) {
      if (Test-Path $file) { $log += (Get-Content $file -Raw -Encoding UTF8) }
    }
    $match = [regex]::Match($log, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($match.Success) { return @{ process = $process; url = $match.Value } }
  }
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Fail 'не удалось получить адрес туннеля за 60 секунд' "Смотрите лог: $tunnelErr"
}

if ($NoTunnel) {
  $publicUrl = $settings['WEBAPP_URL']
  if (-not $publicUrl) { Fail '-NoTunnel указан, но WEBAPP_URL в .env пуст' 'Уберите флаг или заполните адрес.' }
  Write-Ok "используем существующий адрес: $publicUrl"
} elseif ($TunnelUrl) {
  $publicUrl = $TunnelUrl.TrimEnd('/')
  Write-Ok "используем переданный адрес: $publicUrl"
} else {
  Write-Step 'Поднимаем туннель'
  $tunnel = Start-Tunnel $effectivePort
  $tunnelProcess = $tunnel.process
  $publicUrl = $tunnel.url
  Write-Ok "публичный адрес: $publicUrl"
  Set-EnvValue 'WEBAPP_URL' $publicUrl
  Write-Ok 'адрес записан в .env (WEBAPP_URL)'

  # Туннель отдаёт адрес сразу, но маршрут на edge ставится не мгновенно, а свежее
  # имя сначала публикуется только как AAAA: поэтому проверяем готовность двумя
  # способами (обычный адрес и имя через IP edge Cloudflare).
  Write-Dim 'ждём готовности канала (обычно 15-60 секунд)...'
  $state = $false
  for ($i = 1; $i -le 30; $i++) {
    $state = Test-TunnelReady $publicUrl
    if ($state) { break }
    Start-Sleep -Seconds 4
  }
  if ($state -eq 'dns') {
    Write-Ok "публичный адрес отвечает (через $($i * 4) с)"
  } elseif ($state -eq 'edge') {
    Write-Ok "туннель поднялся (через $($i * 4) с)"
    Write-Warn 'само имя пока публикуется только в IPv6 — A-запись появится в течение пары минут.'
    Write-Warn 'Telegram откроет игру, когда запись появится; проверить можно повторным запуском.'
  } else {
    Write-Warn 'адрес не ответил за отведённое время — кнопку всё равно поставим,'
    Write-Warn 'Telegram проверяет адрес со своей стороны; повторите запуск, если не откроется.'
  }
}

# --- 4. Кнопка меню и команды бота ---

Write-Step 'Настраиваем кнопку меню'
$setMenuArgs = @('tools\set-menu-button.js', $publicUrl)
if (-not $SkipBot) { & node $setMenuArgs } else { Write-Warn 'бот отключён флагом -SkipBot, кнопка не настроена' }
if ($LASTEXITCODE -ne 0) {
  Write-Warn 'кнопку настроить не удалось — повторите позже: node tools\set-menu-button.js'
}

# --- 5. Логи сервера в этом окне ---

Write-Step 'Готово'
Write-Host '  Мини-апп: ' -NoNewline; Write-Host $publicUrl -ForegroundColor Green
Write-Host '  Ctrl+C — остановить сервер и туннель.' -ForegroundColor DarkGray
Write-Host ''

$offsets = @{}
try {
  while ($true) {
    foreach ($file in @($serverOut, $serverErr)) {
      if (-not (Test-Path $file)) { continue }
      $lines = @(Get-Content -LiteralPath $file -Encoding UTF8)
      $seen = if ($offsets.ContainsKey($file)) { $offsets[$file] } else { 0 }
      if ($lines.Count -gt $seen) {
        for ($i = $seen; $i -lt $lines.Count; $i++) { Write-Host $lines[$i] }
        $offsets[$file] = $lines.Count
      }
    }
    if ($serverProcess.HasExited) {
      Write-Warn "сервер завершился (код $($serverProcess.ExitCode))"
      break
    }
    Start-Sleep -Milliseconds 700
  }
} finally {
  Write-Host "`nОстанавливаем..." -ForegroundColor DarkGray
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    Write-Dim "сервер (pid $($serverProcess.Id)) остановлен"
  }
  if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
    Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    Write-Dim "туннель (pid $($tunnelProcess.Id)) остановлен"
  }
}


