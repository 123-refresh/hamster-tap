#Requires -Version 5.1
<#
  Деплой Hamster Tap в Cloudflare Workers (D1 + статика + webhook-бот).

  Запуск:
    powershell -ExecutionPolicy Bypass -File .\tools\cf-deploy.ps1                  # прод
    powershell -ExecutionPolicy Bypass -File .\tools\cf-deploy.ps1 -Target staging   # тестовое окружение

  Шаги:
    1. проверяет wrangler и вход в аккаунт Cloudflare;
    2. создаёт базу D1, если её ещё нет, и вписывает её id в wrangler.toml;
    3. применяет схему cloudflare/schema.sql;
    4. кладёт секреты BOT_TOKEN и BOT_WEBHOOK_SECRET в окружение воркера;
    5. деплоит воркер, узнаёт публичный адрес и записывает его как WEBAPP_URL;
    6. деплоит повторно (уже с адресом) и для прода ставит webhook бота;
    7. прогоняет проверки tools/cf-check.js по боевому адресу.

  Webhook ставится только для прода: у бота может быть лишь один webhook,
  и staging не должен перехватывать апдейты.
#>
param(
  [ValidateSet('prod', 'staging')]
  [string]$Target = 'prod'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$envFile = Join-Path $root '.env'
$tomlFile = Join-Path $root 'wrangler.toml'
$secretFile = Join-Path $root '.webhook-secret'

function Write-Step([string]$text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "  ok  $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "  !!  $text" -ForegroundColor Yellow }
function Fail([string]$text, [string]$hint) {
  Write-Host "`n[x] $text" -ForegroundColor Red
  if ($hint) { Write-Host "    $hint" -ForegroundColor Yellow }
  exit 1
}

function Read-Env {
  $map = @{}
  if (-not (Test-Path $envFile)) { return $map }
  foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -lt 1) { continue }
    $map[$trimmed.Substring(0, $idx).Trim()] = $trimmed.Substring($idx + 1).Trim().Trim('"').Trim("'")
  }
  return $map
}

# wrangler запускаем через npx (он уже установлен как devDependency проекта).
function Invoke-Wrangler {
  param([string[]]$Arguments, [switch]$Capture)
  # wrangler пишет предупреждения в stderr, а PowerShell с политикой Stop и
  # перенаправлением 2>&1 превращает их в исключение и обрывает скрипт.
  # Поэтому внутри функции политику ослабляем и смотрим только на код возврата.
  $previous = $ErrorActionPreference
  if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
  }
  $ErrorActionPreference = 'Continue'
  try {
    $output = & npx.cmd wrangler @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $text = ($output | Out-String)
  if ($Capture) { return @{ text = $text; code = $code } }
  Write-Host $text
  if ($code -ne 0) { Fail "wrangler $($Arguments -join ' ') завершился с кодом $code" }
  return $text
}

# Загрузка бандла и работа с D1 идут на api.cloudflare.com; на нестабильном
# канале (VPN) одиночный запрос иногда падает с «fetch failed». Повторяем:
# операции идемпотентны — каждая попытка публикует ту же сборку/схему.
function Invoke-WranglerRetry {
  param([string[]]$Arguments, [int]$Attempts = 4, [switch]$Capture)
  $delays = @(3, 5, 10)
  $result = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $result = Invoke-Wrangler -Arguments $Arguments -Capture
    if ($result.code -eq 0 -and $result.text -notmatch 'fetch failed') { break }
    if ($attempt -lt $Attempts) {
      $wait = if ($attempt -le $delays.Count) { $delays[$attempt - 1] } else { 10 }
      Write-Warn "попытка $attempt не прошла — повтор через $wait с"
      Start-Sleep -Seconds $wait
    }
  }
  if (-not $Capture) {
    Write-Host $result.text
    if ($result.code -ne 0) {
      Resolve-WranglerFailure $result.text "wrangler $($Arguments -join ' ') завершился с кодом $($result.code)" 'Запустите скрипт снова.' $accountEmail
    }
  }
  return $result
}

# Секреты wrangler читает из stdin: значение подставляем через пайп.
function Set-WranglerSecret([string]$name, [string]$value, [string[]]$Extra) {
  $previous = $ErrorActionPreference
  if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
  }
  $ErrorActionPreference = 'Continue'
  try {
    $text = ($value | & npx.cmd wrangler secret put $name @Extra 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0) {
    # Показываем вывод wrangler: без него причина сбоя непонятна.
    $shown = $text.Trim()
    if ($shown) { Write-Host $shown }
    Resolve-WranglerFailure $text "не удалось сохранить секрет $name" 'Проверьте вход в Cloudflare (npx wrangler whoami).' $accountEmail
  }
  Write-Ok "секрет $name сохранён"
}

# Вызов наших node-утилит: они тоже пишут в stderr, поэтому политика та же.
# Вывод печатаем здесь же (Write-Host), а возвращаем ТОЛЬКО код: иначе строки
# вывода попали бы в возвращаемое значение и сравнение с 0 ломалось бы.
function Invoke-Node {
  param([string[]]$Arguments, [switch]$AllowFailure)
  $previous = $ErrorActionPreference
  if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
  }
  $ErrorActionPreference = 'Continue'
  try {
    $text = (& node @Arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $trimmed = $text.Trim()
  if ($trimmed) { Write-Host $trimmed }
  if ($code -ne 0 -and -not $AllowFailure) { Write-Warn "node $($Arguments -join ' ') вернул код $code" }
  return $code
}

# Достаёт публичный адрес воркера из вывода wrangler. Регулярные выражения тут
# намеренно не используются: адрес ищем по строкам и «чистим» каждый токен от
# управляющих символов и кавычек. Берём первую ссылку после строки «Deployed»,
# иначе — последнюю ссылку в выводе (выше есть строка биндинга WEBAPP_URL,
# где адрес может быть ещё заглушкой).
function Get-DeployedUrl([string]$text) {
  $fallback = ''
  $afterDeployed = $false
  foreach ($rawLine in ($text -split "`n")) {
    if ($rawLine -like '*Deployed*') { $afterDeployed = $true }
    foreach ($token in ($rawLine -split ' ')) {
      # Оставляем только символы, допустимые в адресе: служебные коды и
      # кавычки вокруг ссылки отбрасываются.
      $clean = ($token -replace '[^a-zA-Z0-9./:-]', '')
      if ($clean -like 'https://*.workers.dev') {
        if ($afterDeployed) { return $clean }
        $fallback = $clean
      }
    }
  }
  return $fallback
}


# Разбирает неудачу wrangler и, если это отказ из-за неподтверждённой почты,
# объясняет, что делать (ошибка 10034 приходит на любую запись в Workers).
function Resolve-WranglerFailure([string]$text, [string]$what, [string]$hint, [string]$email) {
  if ($text -match '10034' -or $text -match 'verify your email') {
    $target = if ($email) { " ($email)" } else { '' }
    Fail "Cloudflare не разрешает работу с Workers: не подтверждён e-mail$target" @"
Подтвердите адрес почты, на который зарегистрирован аккаунт Cloudflare:
  1. откройте письмо от Cloudflare «Verify your email address» (проверьте «Спам»);
  2. если письма нет — зайдите на https://dash.cloudflare.com/ : сверху будет
     предложение подтвердить адрес, там же кнопка «Resend»/«Отправить снова»;
  3. после подтверждения запустите этот скрипт снова — он продолжит с того же места.
Не удалось: $what
"@
  }
  Fail $what $hint
}


# Запись значения в нужную секцию wrangler.toml (prod — корневая, staging — [env.staging.vars]).
function Set-TomlValue([string]$key, [string]$value, [string]$section) {
  $lines = @(Get-Content -LiteralPath $tomlFile -Encoding UTF8)
  $start = 0
  $end = $lines.Count
  if ($section) {
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($start -eq 0 -and $lines[$i] -match "^\s*\[$([regex]::Escape($section))\]\s*$") { $start = $i; continue }
      if ($start -gt 0 -and $i -gt $start -and $lines[$i] -match '^\s*\[') { $end = $i; break }
    }
    if ($start -eq 0) { Fail "в wrangler.toml нет секции [$section]" }
  }
  for ($i = $start; $i -lt $end; $i++) {
    if ($lines[$i] -match ("^\s*" + [regex]::Escape($key) + "\s*=")) {
      $lines[$i] = "$key = `"$value`""
      [System.IO.File]::WriteAllLines($tomlFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
      return
    }
  }
  Fail "в wrangler.toml не найдено поле $key (секция '$section')"
}

$settings = Read-Env
$botToken = $settings['BOT_TOKEN']
$botUsername = $settings['BOT_USERNAME']
if (-not $botToken) { Fail 'BOT_TOKEN не задан в .env' 'Впишите токен от @BotFather.' }
if (-not $botUsername) { Fail 'BOT_USERNAME не задан в .env' 'Укажите юзернейм бота без @.' }

Write-Step "Деплой Hamster Tap ($Target)"
Write-Ok "токен и юзернейм (@$botUsername) на месте"

# --- 1. wrangler и вход ---

$version = Invoke-Wrangler -Arguments @('--version') -Capture
if ($version.code -ne 0) { Fail 'wrangler недоступен' 'Выполните: npm install --save-dev wrangler' }
Write-Ok "wrangler $($version.text.Trim())"

$whoami = Invoke-Wrangler -Arguments @('whoami') -Capture
if ($whoami.code -ne 0 -or $whoami.text -notmatch 'logged in') {
  Fail 'нет входа в Cloudflare' @"
  Выполните в отдельном окне:   npx wrangler login
  Откроется браузер — войдите (или создайте аккаунт) и нажмите «Allow»,
  затем запустите этот скрипт снова.
"@
}
Write-Ok 'вход в Cloudflare есть'
# Почта аккаунта нужна, чтобы подсказать, где искать письмо о подтверждении.
$accountEmail = ''
$emailMatch = [regex]::Match($whoami.text, '[\w.+-]+@[\w-]+\.[\w.-]*[\w-]')
if ($emailMatch.Success) {
  $accountEmail = $emailMatch.Value
  Write-Ok "аккаунт: $accountEmail"
}

$dbName = if ($Target -eq 'staging') { 'hamster-tap-staging' } else { 'hamster-tap' }
$envArgs = if ($Target -eq 'staging') { @('--env', 'staging') } else { @() }
$section = if ($Target -eq 'staging') { 'env.staging.vars' } else { 'vars' }

# --- 2. база D1 ---

Write-Step 'Готовим базу D1'

# Возвращает id базы по имени (или $null). Список перечитываем после создания:
# если ответ на «d1 create» не дойдёт, база всё равно уже создана.
function Get-D1DatabaseId([string]$Name) {
  $list = Invoke-WranglerRetry -Arguments (@('d1', 'list', '--json') + $envArgs) -Capture
  if ($list.code -ne 0) { return $null }
  $json = [regex]::Match($list.text, '(?s)\[.*\]')
  if (-not $json.Success) { return $null }
  try {
    $parsed = $json.Value | ConvertFrom-Json
    $found = $parsed | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if ($found) { return $found.uuid }
  } catch {
    Write-Warn 'не удалось разобрать список баз wrangler'
  }
  return $null
}

$databaseId = Get-D1DatabaseId $dbName
if (-not $databaseId) {
  Write-Warn "база $dbName не найдена — создаём"
  $created = Invoke-WranglerRetry -Arguments @('d1', 'create', $dbName) -Capture
  Write-Host $created.text
  $match = [regex]::Match($created.text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
  if ($match.Success) {
    $databaseId = $match.Value
  } else {
    # Ответ мог не дойти, хотя база создалась — перечитываем список.
    $databaseId = Get-D1DatabaseId $dbName
  }
  if (-not $databaseId) { Fail 'не удалось получить database_id из вывода wrangler' }
}
Write-Ok "база: $dbName ($databaseId)"

# Вписываем id в wrangler.toml, чтобы деплой привязал нужную базу.
$toml = Get-Content -LiteralPath $tomlFile -Raw -Encoding UTF8
$pattern = '(?s)(database_name\s*=\s*"' + [regex]::Escape($dbName) + '"\s*\r?\n\s*database_id\s*=\s*")[^"]+(")'
if ([regex]::IsMatch($toml, $pattern)) {
  $toml = [regex]::Replace($toml, $pattern, ('${1}' + $databaseId + '${2}'))
  [System.IO.File]::WriteAllText($tomlFile, $toml, (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok 'database_id записан в wrangler.toml'
} else {
  Write-Warn 'не нашли database_id нужной базы в wrangler.toml — проверьте вручную'
}

Write-Step 'Применяем схему базы'
$applyArgs = @((Join-Path $root 'tools\cf-d1-apply.js'), $dbName)
if ($Target -eq 'staging') { $applyArgs += @('--env', 'staging') }
$applyCode = Invoke-Node -Arguments $applyArgs
if ($applyCode -ne 0) {
  Fail 'схему применить не удалось' 'Запустите скрипт снова — схема применяется идемпотентно (IF NOT EXISTS).'
}

# --- 3. секреты ---

Write-Step 'Секреты окружения'
$secret = if (Test-Path $secretFile) { (Get-Content -LiteralPath $secretFile -Raw).Trim() } else { '' }
if (-not $secret) {
  $bytes = New-Object 'System.Byte[]' 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  [System.IO.File]::WriteAllText($secretFile, $secret, (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok 'секрет webhook сгенерирован и сохранён в .webhook-secret'
} else {
  Write-Ok 'используем сохранённый секрет webhook (.webhook-secret)'
}

Set-WranglerSecret 'BOT_TOKEN' $botToken $envArgs
Set-WranglerSecret 'BOT_WEBHOOK_SECRET' $secret $envArgs
# Ключ рекламной сети (Chanify): секрет, в клиент не попадает. Без него кнопка
# «энергия за рекламу» отвечает «реклама недоступна», игра работает как прежде.
if ($settings['CHANIFY_API_KEY']) {
  Set-WranglerSecret 'CHANIFY_API_KEY' $settings['CHANIFY_API_KEY'] $envArgs
} else {
  Write-Ok 'CHANIFY_API_KEY не задан в .env — реклама выключена'
}
# Секрет постбеков Monetag: он же часть адреса эндпоинта, который вставляется в
# кабинете. Генерируем один раз и держим рядом с секретом webhook — в репозиторий
# он не попадает (см. .gitignore), в клиент не уходит.
$postbackSecret = $settings['MONETAG_POSTBACK_SECRET']
if (-not $postbackSecret) {
  $postbackFile = Join-Path $root '.postback-secret'
  $postbackSecret = if (Test-Path $postbackFile) { (Get-Content -LiteralPath $postbackFile -Raw).Trim() } else { '' }
  if (-not $postbackSecret) {
    $bytes = New-Object 'System.Byte[]' 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $postbackSecret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    [System.IO.File]::WriteAllText($postbackFile, $postbackSecret, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok 'секрет постбеков Monetag сгенерирован и сохранён в .postback-secret'
  } else {
    Write-Ok 'используем сохранённый секрет постбеков (.postback-secret)'
  }
}
Set-WranglerSecret 'MONETAG_POSTBACK_SECRET' $postbackSecret $envArgs
Write-Ok 'секреты окружения готовы'

# --- 4. первый деплой и публичный адрес ---

# Без workers.dev-поддомена wrangler в неинтерактивном режиме отказывается
# публиковать воркер (на вопрос про поддомен отвечает «no»).
Write-Step 'Готовим workers.dev-адрес'
$subCode = Invoke-Node -Arguments @((Join-Path $root 'tools\ensure-subdomain.js'))
if ($subCode -ne 0) {
  Fail 'без workers.dev-поддомена воркер не опубликовать' @"
Откройте ссылку из сообщения выше в браузере: там поддомен создаётся
автоматически при первом открытии страницы Workers & Pages. Затем запустите скрипт снова.
"@
}

Write-Step 'Деплоим воркер'
$deploy = Invoke-WranglerRetry -Arguments (@('deploy') + $envArgs) -Capture
$publicUrl = Get-DeployedUrl $deploy.text
if (-not $publicUrl) {
  Write-Host $deploy.text
  Resolve-WranglerFailure $deploy.text 'не удалось определить публичный адрес воркера в выводе wrangler' 'Проверьте вывод выше и запустите скрипт снова.' $accountEmail
}
Write-Ok "адрес: $publicUrl"

Set-TomlValue 'WEBAPP_URL' $publicUrl $section
Write-Ok "WEBAPP_URL записан в wrangler.toml (секция '$section')"

Write-Step 'Повторный деплой (уже с адресом внутри воркера)'
Invoke-WranglerRetry -Arguments (@('deploy') + $envArgs) | Out-Null
Write-Ok 'готово'

# --- 5. webhook, кнопка меню и проверки ---

if ($Target -eq 'prod') {
  Write-Step 'Настраиваем бота (webhook, команды, кнопка меню)'
  Invoke-Node -Arguments @((Join-Path $root 'tools\set-webhook.js'), '--url', $publicUrl, '--secret', $secret) | Out-Null
} else {
  Write-Warn 'staging: webhook не ставим, чтобы не перехватывать апдейты бота'
}

Write-Step 'Проверяем боевой адрес'
$checkCode = Invoke-Node -Arguments @((Join-Path $root 'tools\cf-check.js'), $publicUrl)
if ($checkCode -ne 0) { Write-Warn 'часть проверок не прошла — смотрите вывод выше' }

Write-Step 'Итог'
Write-Host "  Мини-апп: $publicUrl" -ForegroundColor Green
Write-Host "  Бот:      https://t.me/$botUsername" -ForegroundColor Green
Write-Host '  Откройте бота, отправьте /start и нажмите «🐹 Играть».'
if ($Target -eq 'prod') {
  # Готовый адрес для кабинета Monetag: макросы сеть подставит сама, секрет лежит
  # в .postback-secret (в репозиторий не попадает).
  Write-Host ''
  Write-Host '  Постбек Monetag: вставьте это в кабинете в поле Postback URL главной зоны SDK' -ForegroundColor Cyan
  Write-Host ($publicUrl + '/api/ads/monetag/' + $postbackSecret +
    '?ymid={ymid}&event={event_type}&value={reward_event_type}&zone={zone_id}&sub={sub_zone_id}&source={request_var}')
}
