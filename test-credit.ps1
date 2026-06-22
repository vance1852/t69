$ErrorActionPreference = "Stop"
$base = "http://localhost:7651/api"

Write-Host "`n========= 1. 登录获取 Token =========" -ForegroundColor Cyan
$loginBody = @{ username = "admin"; password = "admin123" } | ConvertTo-Json
$loginResp = Invoke-RestMethod -Uri "$base/auth/login" -Method Post -Body $loginBody -ContentType "application/json"
$token = $loginResp.token
Write-Host "Token 获取成功，长度: $($token.Length)"

$headers = @{ Authorization = "Bearer $token" }

Write-Host "`n========= 2. 健康检查 =========" -ForegroundColor Cyan
$health = Invoke-RestMethod -Uri "$base/../health" -Method Get
Write-Host "健康状态: $($health.status)"

Write-Host "`n========= 3. 信用账户查询（查询各档次用户） =========" -ForegroundColor Cyan
$testPhones = @("13800001111", "13800003333", "13800004444", "13800005555")
foreach ($phone in $testPhones) {
    $acc = Invoke-RestMethod -Uri "$base/credit/account?phone=$phone" -Method Get -Headers $headers
    Write-Host "  $($acc.visitor_name) ($phone): 分=$($acc.credit_score), 档=$($acc.credit_level), 管控=$($acc.control_status), 黑名单=$($acc.active_blacklist -ne $null)"
}

Write-Host "`n========= 4. 信用档位规则 =========" -ForegroundColor Cyan
$tiers = Invoke-RestMethod -Uri "$base/credit/tiers" -Method Get -Headers $headers
foreach ($t in $tiers) {
    Write-Host "  档[$($t.display_name)]: $($t.min_score)-$($t.max_score)分, 管控=$($t.control_status), 提前=$($t.require_advance_hours)h, 日上限=$($t.max_daily_reservations), 可约高峰=$($t.allow_peak_time), 团体上限=$($t.max_group_size)"
}

Write-Host "`n========= 5. 预约信用拦截测试 =========" -ForegroundColor Cyan
$futureDate = (Get-Date).AddDays(7).ToString("yyyy-MM-dd")
$blockTests = @(
    @{ phone = "13800005555"; date = $futureDate; slot = "pm"; size = 1; desc = "黑名单用户预约" },
    @{ phone = "13800004444"; date = $futureDate; slot = "am"; size = 1; desc = "警告档用户约高峰(上午)" },
    @{ phone = "13800003333"; date = (Get-Date).AddHours(2).ToString("yyyy-MM-dd"); slot = "pm"; size = 1; desc = "受限档用户不足提前24h预约" },
    @{ phone = "13800003333"; date = $futureDate; slot = "pm"; size = 5; desc = "受限档用户超团体人数(>3)" },
    @{ phone = "13800001111"; date = $futureDate; slot = "am"; size = 2; desc = "优秀用户正常预约" }
)
foreach ($t in $blockTests) {
    $body = @{ phone = $t.phone; visit_date = $t.date; time_slot = $t.slot; group_size = $t.size } | ConvertTo-Json
    $result = Invoke-RestMethod -Uri "$base/credit/booking/check" -Method Post -Body $body -Headers $headers -ContentType "application/json"
    $status = if ($result.allowed) { "通过" } else { "拦截: $($result.reason)" }
    Write-Host "  [$($t.desc)] -> $status"
}

Write-Host "`n========= 6. 历史爽约记录 + 信用流水（查询王芳13800003333） =========" -ForegroundColor Cyan
$logs = Invoke-RestMethod -Uri "$base/credit/logs?phone=13800003333" -Method Get -Headers $headers
Write-Host "  信用流水记录数: $($logs.Count)"
foreach ($l in $logs) {
    Write-Host "    [$($l.change_type)] $($l.delta) 分, $($l.before_score)->$($l.after_score), 原因: $($l.reason) ($($l.created_at))"
}

Write-Host "`n========= 7. 统计概览 =========" -ForegroundColor Cyan
$stats = Invoke-RestMethod -Uri "$base/credit/stats/overview" -Method Get -Headers $headers
Write-Host "  总账户=$($stats.total_accounts), 正常=$($stats.normal_count), 受限=$($stats.restricted_count), 黑名单=$($stats.blacklist_count)"
Write-Host "  总预约=$($stats.total_reservations), 爽约数=$($stats.no_show_count), 爽约率=$($stats.no_show_rate)%"
Write-Host "  申诉总数=$($stats.total_appeals), 待处理=$($stats.pending_appeals)"

Write-Host "`n========= 8. 信用档人数分布 =========" -ForegroundColor Cyan
$dist = Invoke-RestMethod -Uri "$base/credit/stats/tier-distribution" -Method Get -Headers $headers
foreach ($d in $dist) {
    Write-Host "  $($d.display_name) ($($d.min_score)-$($d.max_score)): $($d.count) 人"
}

Write-Host "`n========= 9. 当前黑名单 =========" -ForegroundColor Cyan
$bl = Invoke-RestMethod -Uri "$base/credit/blacklists?status=active" -Method Get -Headers $headers
foreach ($b in $bl) {
    Write-Host "  $($b.visitor_name) ($($b.phone)): 原因=$($b.reason), 到期=$($b.end_at)"
}

Write-Host "`n========= 10. 待处理申诉 =========" -ForegroundColor Cyan
$appeals = Invoke-RestMethod -Uri "$base/credit/appeals?status=pending" -Method Get -Headers $headers
foreach ($a in $appeals) {
    Write-Host "  申诉#$($a.id): $($a.visitor_name)($($a.phone)) - $($a.reason)"
}

Write-Host "`n========= 11. 模拟爽约批处理（昨日上午场，应已过期） =========" -ForegroundColor Cyan
$yesterday = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
try {
    $nsBody = @{ visit_date = $yesterday; time_slot = "am"; triggered_by = "manual" } | ConvertTo-Json
    $nsResult = Invoke-RestMethod -Uri "$base/credit/no-show/batch" -Method Post -Body $nsBody -Headers $headers -ContentType "application/json"
    Write-Host "  批次#$($nsResult.batchId): 待处理=$($nsResult.total_count), 已处理=$($nsResult.processed_count)"
} catch {
    Write-Host "  无待处理预约或时段未结束: $($_.Exception.Message)"
}

Write-Host "`n========= 12. 申诉通过回滚测试（处理王芳的申诉 #1） =========" -ForegroundColor Cyan
$accBefore = Invoke-RestMethod -Uri "$base/credit/account?phone=13800003333" -Method Get -Headers $headers
Write-Host "  申诉前: 王芳信用分 = $($accBefore.credit_score)"
try {
    $reviewBody = @{ approved = $true; review_note = "情况属实，突发疾病有凭证，撤销本次爽约记录" } | ConvertTo-Json
    $reviewResult = Invoke-RestMethod -Uri "$base/credit/appeals/1/review" -Method Post -Body $reviewBody -Headers $headers -ContentType "application/json"
    Write-Host "  申诉处理: approved=$($reviewResult.approved)"
    $accAfter = Invoke-RestMethod -Uri "$base/credit/account?phone=13800003333" -Method Get -Headers $headers
    Write-Host "  申诉后: 王芳信用分 = $($accAfter.credit_score) (回升了 $($accAfter.credit_score - $accBefore.credit_score) 分)"
} catch {
    Write-Host "  申诉处理失败: $($_.Exception.Message)"
}

Write-Host "`n========= 13. 信用通知（王芳） =========" -ForegroundColor Cyan
$notifs = Invoke-RestMethod -Uri "$base/credit/notifications?phone=13800003333" -Method Get -Headers $headers
Write-Host "  通知数量: $($notifs.Count)"
foreach ($n in $notifs) {
    Write-Host "    [$($n.type)] $($n.title): $($n.content)"
}

Write-Host "`n========= 14. 黑名单解除测试（陈刚 13800005555） =========" -ForegroundColor Cyan
try {
    $before = Invoke-RestMethod -Uri "$base/credit/account?phone=13800005555" -Method Get -Headers $headers
    Write-Host "  解除前: 陈刚管控状态 = $($before.control_status)"
    $releaseBody = @{ release_note = "人工审核通过，提前解除黑名单" } | ConvertTo-Json
    $releaseResult = Invoke-RestMethod -Uri "$base/credit/blacklists/1/release" -Method Post -Body $releaseBody -Headers $headers -ContentType "application/json"
    Write-Host "  解除结果: status=$($releaseResult.status)"
    $after = Invoke-RestMethod -Uri "$base/credit/account?phone=13800005555" -Method Get -Headers $headers
    Write-Host "  解除后: 陈刚管控状态 = $($after.control_status)"
} catch {
    Write-Host "  解除失败: $($_.Exception.Message)"
}

Write-Host "`n========= 全部接口验证完成 =========" -ForegroundColor Green
