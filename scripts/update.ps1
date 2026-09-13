# ============================================================================
# 开奖后一键更新（本地版）
# ----------------------------------------------------------------------------
# 作用与 .github/workflows/update-lottery.yml 完全相同，区别只是这个在你本机跑：
#   抓数据 → 逐期交叉核对 → 数据硬校验 → 重算回测 → 重新生成页面 → 合规审计
# 任一步失败就立刻停下并告诉你哪一步红了（不会带着没通过门禁的产物继续往下走）。
#
# 用法（在项目根目录，Windows PowerShell 5.1 与 PowerShell 7+ 都可以）：
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -Peer data\peer_ssq_26105.json
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -NoFetch      # 不联网，只用本地数据重算
#
# 如果你的系统装了 PowerShell 7，把上面的 powershell 换成 pwsh 也一样。
#
# 说明：页面产物是 public/index.html，同时会复制一份到根目录 index.html
# （GitHub Pages 的 root 模式只认根目录那个）。
# ============================================================================

[CmdletBinding()]
param(
  [string]$Peer = "",
  [switch]$NoFetch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$steps = @()
function Invoke-Step {
  param([string]$Name, [scriptblock]$Body)
  Write-Host ""
  Write-Host ("=" * 70) -ForegroundColor DarkGray
  Write-Host "▶ $Name" -ForegroundColor Cyan
  Write-Host ("=" * 70) -ForegroundColor DarkGray
  $started = Get-Date
  & $Body
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 0 }
  $script:steps += [pscustomobject]@{
    Name     = $Name
    ExitCode = $code
    Seconds  = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  }
  if ($code -ne 0) {
    Write-Host ""
    Write-Host "✗ 门禁失败：$Name（退出码 $code）" -ForegroundColor Red
    Write-Host "  已停止，不继续执行后续步骤 —— 未通过门禁的产物不得发布。" -ForegroundColor Red
    Write-Host "  修掉这一步再重跑即可（前面已经通过的步骤会重新执行，代价很小）。" -ForegroundColor DarkGray
    exit $code
  }
  Write-Host "✓ 通过" -ForegroundColor Green
}

Write-Host "彩票实验室 · 开奖后一键更新" -ForegroundColor White
Write-Host "工作目录：$root"

if (-not $NoFetch) {
  if ($Peer) {
    Invoke-Step "1/10 抓取上游数据 + 逐期交叉核对 + 第二来源复核（$Peer）+ 写入" {
      node scripts/fetch-data.js --peer $Peer --apply
    }
  } else {
    Invoke-Step "1/10 抓取上游数据 + 逐期交叉核对 + 写入" {
      node scripts/fetch-data.js --apply
    }
  }
} else {
  Write-Host ""
  Write-Host "（-NoFetch：跳过抓取，直接用本地已有数据重算）" -ForegroundColor Yellow
}

Invoke-Step "2/10 多数据源合并与交叉核对（两源不一致即停线）" { node scripts/merge-sources.js --apply }
Invoke-Step "3/10 清洗数据（原始 → 标准格式）" { node scripts/prepare-data.js }
Invoke-Step "4/10 数据硬校验（格式 / 奖级全枚举 / 组合概率 / 分布 / 指纹）" { node scripts/verify-data.js }
Invoke-Step "5/10 重跑 Walk-Forward 回测与蒙特卡洛" { node src/build.js }
Invoke-Step "6/10 重新生成页面" {
  node src/build-site.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Copy-Item public/index.html index.html -Force
  Write-Host "已同步 public/index.html → index.html（GitHub Pages root 模式需要）"
}
Invoke-Step "7/10 页面内联脚本冒烟测试（模拟浏览器点击三个交互工具）" { node scripts/smoke-test-client.js }
Invoke-Step "8/10 工作流规则级校验（GitHub 专属规则，防非法 cron）" { node scripts/lint-workflows.js }
Invoke-Step "9/10 排程语义校验真实性测试（注入错误，确认校验真的会红）" { node scripts/test-schedule-lint.js }
Invoke-Step "10/10 合规红线审计" { node scripts/audit-safety.js }

Write-Host ""
Write-Host ("=" * 70) -ForegroundColor DarkGray
Write-Host "全部通过 🎉" -ForegroundColor Green
$steps | Format-Table -AutoSize Name, ExitCode, Seconds | Out-String | Write-Host

node -e "const d=require('./data/ssq.json');console.log('当前数据：'+d.length+' 期，最新一期 '+d[d.length-1].period+'（'+d[d.length-1].date+'）')"

Write-Host "下一步："
Write-Host "  · 想发布到线上：git add -A; git commit -m '更新数据'; git push"
Write-Host "  · 想先看看页面：直接双击 public/index.html"
Write-Host "  · 如果你已经把仓库连到 Cloudflare Pages，push 之后它会自动重新部署"
