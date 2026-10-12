# ============================================================================
#  桂养安心 · 一键安全启动 + 公网隧道
#  用途：换强口令 -> 清运行库 -> 重启服务 -> 开公网隧道 -> 自检
#  用法：右键「使用 PowerShell 运行」，或在 PowerShell 里执行
#        powershell -ExecutionPolicy Bypass -File "安全启动.ps1"
# ============================================================================

param(
    [string]$ProjectRoot = $PSScriptRoot,
    [int]$Port = 4173,
    [string]$Proxy = "http://127.0.0.1:9567",
    [switch]$SkipPasswordReset,      # 跳过换口令（确认口令已足够强时用）
    [switch]$NoTunnel                # 只起服务，不开隧道
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# ---------------------------------------------------------------- 输出工具
function Say($m, $c = "Gray") { Write-Host $m -ForegroundColor $c }
function Head($m) {
    Write-Host ""
    Write-Host ("=" * 72) -ForegroundColor DarkCyan
    Write-Host "  $m" -ForegroundColor Cyan
    Write-Host ("=" * 72) -ForegroundColor DarkCyan
}
function Ok($m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [注意] $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "  [失败] $m" -ForegroundColor Red }
function Step($m) { Write-Host "  --> $m" -ForegroundColor Gray }

function GenPassword {
    $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    $bytes = New-Object byte[] 18
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Test-Port([int]$p) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect("127.0.0.1", $p); $c.Close(); return $true
    } catch { return $false }
}

# ================================================================ 0. 前置检查
Head "0 / 6  前置检查"

if (-not (Test-Path $ProjectRoot)) { Bad "项目目录不存在: $ProjectRoot"; exit 1 }
if (-not (Test-Path (Join-Path $ProjectRoot "server.py"))) { Bad "目录里没有 server.py，路径对吗？"; exit 1 }
Ok "项目目录: $ProjectRoot"

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { Bad "找不到 python，请先安装并加入 PATH"; exit 1 }
Ok "Python: $python"

$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflared)) {
    $cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
}
if ($NoTunnel) {
    Step "已指定 -NoTunnel，跳过隧道工具检查"
} elseif ($cloudflared -and (Test-Path $cloudflared)) {
    Ok "cloudflared: $cloudflared"
} else {
    Warn "未找到 cloudflared，稍后只能靠 ngrok 或手动开隧道"
}

# ================================================================ 1. 停旧服务
Head "1 / 6  停止正在运行的服务"

$stopped = 0
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -ge $Port -and $_.LocalPort -le ($Port + 9) } |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
        $proc = Get-Process -Id $_ -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -like "python*") {
            Stop-Process -Id $_ -Force
            Step "已停止 PID $_ ($($proc.ProcessName))"
            $stopped++
        }
    }
if ($stopped -eq 0) { Ok "没有需要停止的服务" } else { Ok "已停止 $stopped 个进程" }
Start-Sleep -Milliseconds 800

# ================================================================ 2. 换强口令
Head "2 / 6  重置为强口令"

$runtimeDir = Join-Path $ProjectRoot "runtime"
$credFile   = Join-Path $runtimeDir "demo_credentials.json"

if ($SkipPasswordReset) {
    Warn "已指定 -SkipPasswordReset，保留现有口令"
    $pw = @{}
    if (Test-Path $credFile) {
        $j = Get-Content $credFile -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($r in "elder","provider","regulator") { $pw[$r] = $j.$r }
        Ok "已读取现有口令"
    } else {
        Bad "没有现成口令文件，无法跳过。请去掉 -SkipPasswordReset 重跑"; exit 1
    }
} else {
    if (Test-Path $runtimeDir) {
        Remove-Item -Recurse -Force $runtimeDir
        Ok "已清除 runtime（旧数据库 + 旧口令文件）"
    } else {
        Step "runtime 不存在，将首次创建"
    }
    $pw = @{
        elder     = GenPassword
        provider  = GenPassword
        regulator = GenPassword
    }
    $env:GUIYANG_PASSWORD_ELDER     = $pw.elder
    $env:GUIYANG_PASSWORD_PROVIDER  = $pw.provider
    $env:GUIYANG_PASSWORD_REGULATOR = $pw.regulator
    Ok "已生成三套随机强口令（18 位）"
}

# ================================================================ 3. 启动服务
Head "3 / 6  启动本地服务"

$logDir  = Join-Path $ProjectRoot "runtime"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$srvLog  = Join-Path $logDir "_server.log"

$srvArgs = @{
    FilePath         = $python
    ArgumentList     = @("server.py", "--port", "$Port")
    WorkingDirectory = $ProjectRoot
    RedirectStandardOutput = $srvLog
    RedirectStandardError  = ($srvLog -replace '\.log$','.err.log')
    WindowStyle      = "Hidden"
    PassThru         = $true
}
$srv = Start-Process @srvArgs
Step "已启动 python server.py --port $Port  (PID $($srv.Id))"

$ready = $false
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Milliseconds 700
    if (Test-Port $Port) { $ready = $true; break }
}
if (-not $ready) {
    Bad "30 秒内端口 $Port 未就绪。服务端输出如下："
    if (Test-Path $srvLog) { Get-Content $srvLog -Tail 25 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray } }
    exit 1
}
Ok "服务已就绪: http://127.0.0.1:$Port/"

# 本地健康检查
try {
    $st = Invoke-RestMethod "http://127.0.0.1:$Port/api/status" -TimeoutSec 8
    Ok "API 正常  |  model=$($st.model)  schema=$($st.database.schema_version)  deepseek=$($st.configured)"
} catch {
    Warn "api/status 未响应，但端口已开。继续。"
}

# 验证新口令生效
try {
    $body = @{ role="elder"; account="elder"; password=$pw.elder } | ConvertTo-Json
    $r = Invoke-RestMethod "http://127.0.0.1:$Port/api/login" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 8
    if ($r.token) { Ok "新口令登录验证通过（elder）" } else { Warn "登录未返回 token" }
} catch {
    Bad "新口令登录失败：$($_.Exception.Message)"
    Warn "如果刚才是跳过重置，可能是旧口令不匹配"
}

# ================================================================ 4. 开隧道
$publicUrl = $null

if ($NoTunnel) {
    Head "4 / 6  跳过隧道（-NoTunnel）"
} else {
    Head "4 / 6  开启公网隧道"

    # 先探测 cloudflared 的 API 域名是否被 DNS 污染
    $dnsBad = $false
    try {
        $a = (Resolve-DnsName api.trycloudflare.com -Type A -ErrorAction Stop |
                Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
        if ($a -match '^127\.|^0\.0\.0\.0$') { $dnsBad = $true }
        Step "api.trycloudflare.com -> $a"
    } catch { $dnsBad = $true; Step "api.trycloudflare.com 解析失败" }

    if ($dnsBad) {
        Warn "DNS 被污染（解析到本机），cloudflared 会失败"
        Warn "解决：打开 SSRDOG -> 开启 TUN 模式 / 虚拟网卡，然后重跑本脚本"
        Warn "或：改用 ngrok（DNS 干净）"
    }

    if ($cloudflared -and (Test-Path $cloudflared)) {
        Step "启动 cloudflared ..."
        $tunLog = Join-Path $logDir "_tunnel.log"
        $tun = Start-Process -FilePath $cloudflared `
            -ArgumentList @("tunnel","--url","http://127.0.0.1:$Port","--no-autoupdate") `
            -RedirectStandardOutput $tunLog -RedirectStandardError ($tunLog -replace '\.log$','.err.log') `
            -WindowStyle Hidden -PassThru

        for ($i = 1; $i -le 40; $i++) {
            Start-Sleep -Milliseconds 750
            foreach ($f in @($tunLog, ($tunLog -replace '\.log$','.err.log'))) {
                if (Test-Path $f) {
                    $m = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
                         Select-Object -First 1
                    if ($m -and $m.Matches.Count -gt 0) { $publicUrl = $m.Matches[0].Value; break }
                }
            }
            if ($publicUrl) { break }
            if ($tun.HasExited) { break }
        }

        if ($publicUrl) {
            Ok "隧道已建立: $publicUrl"
        } else {
            Bad "cloudflared 未取得地址"
            $errFile = $tunLog -replace '\.log$','.err.log'
            if (Test-Path $errFile) {
                Get-Content $errFile -Tail 6 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
            }
            if (-not $tun.HasExited) { Stop-Process -Id $tun.Id -Force -ErrorAction SilentlyContinue }
            Warn "请开启 SSRDOG 的 TUN 模式后重跑，或改用 ngrok"
        }
    }
}

# ================================================================ 5. 公网自检
if ($publicUrl) {
    Head "5 / 6  公网访问自检"

    function HttpCode([string]$u) {
        try {
            $r = Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 0 -ErrorAction Stop
            return [int]$r.StatusCode
        } catch {
            $code = $_.Exception.Response.StatusCode.value__
            if ($code) { return [int]$code }
            return -1
        }
    }

    $checks = @(
        @{ n = "首页可访问";                 u = "$publicUrl/";                         want = 200 },
        @{ n = "未登录 /api/state 应 401";   u = "$publicUrl/api/state";                want = 401 },
        @{ n = "seed.json 不应暴露";         u = "$publicUrl/seed.json";                want = 404 },
        @{ n = "密钥文件不应暴露";           u = "$publicUrl/deepseek.env.local";       want = 404 },
        @{ n = "口令文件不应暴露";           u = "$publicUrl/runtime/demo_credentials.json"; want = 404 },
        @{ n = "server.py 不应暴露";         u = "$publicUrl/server.py";                want = 404 }
    )

    $pass = 0
    foreach ($c in $checks) {
        $code = HttpCode $c.u
        if ($code -eq $c.want) { Ok ("{0,-26} HTTP {1}" -f $c.n, $code); $pass++ }
        elseif ($code -eq -1)  { Warn ("{0,-26} 无响应（可能隧道未就绪）" -f $c.n) }
        else                   { Bad ("{0,-26} HTTP {1}（期望 {2}）" -f $c.n, $code, $c.want) }
    }
    Write-Host ""
    if ($pass -eq $checks.Count) { Ok "自检 $pass/$($checks.Count) 全部通过" }
    else { Warn "自检 $pass/$($checks.Count) 通过，请核对上面标红的项" }

    # 手机实测提醒
    Write-Host ""
    Warn "请用【手机浏览器】打开下面的地址，实测一次「老人端 -> 小桂 -> 按住说话」"
    Warn "隧道是 HTTPS，麦克风应该可用；如果不行，说明浏览器拦截，改用文字输入演示"
}

# ================================================================ 6. 交付信息
Head "6 / 6  访问信息（请截图或抄走）"

Write-Host ""
if ($publicUrl) {
    Write-Host "  公网地址（发给评委）" -ForegroundColor Yellow
    Write-Host "    $publicUrl" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host "  仅本机可访问" -ForegroundColor Yellow
    Write-Host "    http://127.0.0.1:$Port/" -ForegroundColor White
    Write-Host ""
}

Write-Host "  登录账号 / 口令" -ForegroundColor Yellow
Write-Host ("    {0,-12} {1,-10} {2}" -f "角色", "账号", "口令") -ForegroundColor DarkGray
Write-Host ("    {0,-12} {1,-10} {2}" -f "老人端",   "elder",  $pw.elder)     -ForegroundColor White
Write-Host ("    {0,-12} {1,-10} {2}" -f "机构端",   "center", $pw.provider)  -ForegroundColor White
Write-Host ("    {0,-12} {1,-10} {2}" -f "监管端",   "admin",  $pw.regulator) -ForegroundColor White
Write-Host ""
Step "口令同时保存在: runtime\demo_credentials.json（这是本机私有文件，别外发）"
Write-Host ""

Write-Host "  服务日志" -ForegroundColor Yellow
Write-Host "    $srvLog"
if ($publicUrl) { Write-Host "    $tunLog" }
Write-Host ""

Write-Host "  ⚠ 重要提醒" -ForegroundColor Yellow
Write-Host "    1. 演示期间请不要关闭本窗口；关闭 = 隧道中断、评委打不开"
Write-Host "    2. 演示结束按 Ctrl+C 关掉隧道，避免长期暴露"
Write-Host "    3. 公网地址每次重启都会变，不要写进 PPT"
Write-Host "    4. 开隧道期间 /api/agent 和 /api/advisor 会消耗 DeepSeek 额度"
Write-Host ""

Write-Host ("=" * 72) -ForegroundColor DarkCyan
Write-Host "  按 Ctrl+C 结束（会同时关闭服务和隧道）" -ForegroundColor Cyan
Write-Host ("=" * 72) -ForegroundColor DarkCyan

try {
    while ($true) { Start-Sleep -Seconds 3600 }
} finally {
    Write-Host ""
    Step "正在收尾 ..."
    if ($tun -and -not $tun.HasExited) { Stop-Process -Id $tun.Id -Force -ErrorAction SilentlyContinue }
    if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }
    Ok "服务和隧道已关闭"
}

