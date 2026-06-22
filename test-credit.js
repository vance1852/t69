const { execSync, spawn } = require("child_process");
const BASE = "http://localhost:7651/api";

let step = 0;
function log(title) {
  step++;
  console.log(`\n\x1b[36m[Step ${step}] ${title}\x1b[0m`);
}
function assert(cond, msg) {
  if (!cond) {
    console.error(`\n\x1b[31m  ASSERT FAILED: ${msg}\x1b[0m`);
    process.exit(1);
  }
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`\n\x1b[31m  ASSERT FAILED: ${msg}\x1b[0m`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

async function req(method, path, body = null, token = null) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function daysAgoISO(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
function daysLaterISO(n) {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
}

async function waitForService(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "admin123" }),
      });
      if (r.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function resetDockerIfNeeded() {
  console.log("\n\x1b[33m[Init] 检查数据是否需要重置...\x1b[0m");
  let alive = await waitForService(5000);
  if (!alive) {
    console.log("  服务未启动，开始 docker-compose up --build -d ...");
    execSync("docker-compose up --build -d", { stdio: "inherit", cwd: __dirname });
    alive = await waitForService(180000);
    if (!alive) {
      console.error("  服务启动超时");
      process.exit(1);
    }
  }
  const login = await req("POST", "/auth/login", { username: "admin", password: "admin123" });
  const token = login.data.access_token;
  const liwei = await req("GET", "/credit/account?phone=13800002222", null, token);
  const wangfang = await req("GET", "/credit/account?phone=13800003333", null, token);
  const needReset =
    liwei.status !== 200 ||
    liwei.data.credit_score !== 85 ||
    wangfang.data.credit_score !== 55 ||
    (wangfang.data.active_blacklist !== undefined && wangfang.data.active_blacklist !== null);

  if (needReset) {
    console.log(`  检测到数据已被修改 (李伟=${liwei.data?.credit_score}, 王芳=${wangfang.data?.credit_score})，正在重置 Docker volume...`);
    console.log("  docker-compose down -v ...");
    try { execSync("docker-compose down -v", { stdio: "inherit", cwd: __dirname }); } catch {}
    console.log("  docker-compose up --build -d ...");
    execSync("docker-compose up --build -d", { stdio: "inherit", cwd: __dirname });
    alive = await waitForService(180000);
    if (!alive) { console.error("  重置后服务启动超时"); process.exit(1); }
    console.log("  服务已重启，数据已重置");
  } else {
    console.log("  数据为原始状态，无需重置");
  }
}

async function main() {
  await resetDockerIfNeeded();

  log("登录获取 Token");
  const login = await req("POST", "/auth/login", { username: "admin", password: "admin123" });
  assertEq(login.status, 200, "登录成功");
  const token = login.data.access_token;
  assert(token && token.length > 20, "获取到有效 Token");

  log("获取场馆 ID");
  const museumsRes = await fetch(BASE.replace("/api", "") + "/museums", {
    headers: { Authorization: "Bearer " + token },
  });
  let museumId;
  if (museumsRes.status === 200) {
    const list = await museumsRes.json();
    museumId = list[0]?.id ?? 1;
  } else {
    museumId = 1;
  }
  console.log(`  使用 museumId=${museumId}`);

  log("初始信用账户状态（4 档位覆盖）");
  const accounts = {
    zhangmin: "13800001111",
    wangfang: "13800003333",
    zhaoqiang: "13800004444",
    chengang: "13800005555",
    liwei: "13800002222",
  };
  const zm = await req("GET", `/credit/account?phone=${accounts.zhangmin}`, null, token);
  assertEq(zm.status, 200, "张敏账户存在");
  assertEq(zm.data.credit_score, 100, "张敏信用分 100");
  assertEq(zm.data.credit_level, "excellent", "张敏档位 excellent");
  assertEq(zm.data.control_status, "normal", "张敏管控状态 normal");

  const wf = await req("GET", `/credit/account?phone=${accounts.wangfang}`, null, token);
  assertEq(wf.data.credit_score, 55, "王芳信用分 55");
  assertEq(wf.data.credit_level, "restricted", "王芳档位 restricted");
  assertEq(wf.data.control_status, "restricted", "王芳管控状态 restricted");

  const zq = await req("GET", `/credit/account?phone=${accounts.zhaoqiang}`, null, token);
  assertEq(zq.data.credit_score, 25, "赵强信用分 25");
  assertEq(zq.data.credit_level, "warning", "赵强档位 warning");
  assertEq(zq.data.control_status, "restricted", "赵强管控状态 restricted");

  const cg = await req("GET", `/credit/account?phone=${accounts.chengang}`, null, token);
  assertEq(cg.data.credit_score, 0, "陈刚信用分 0");
  assertEq(cg.data.control_status, "blacklist", "陈刚管控状态 blacklist");
  assert(cg.data.active_blacklist !== null, "陈刚有活跃黑名单记录");

  log("真实预约接口：黑名单用户必须返回 403");
  const blBooking = await req("POST", "/reservations", {
    museumId,
    visitorName: "陈刚", phone: accounts.chengang,
    visitDate: daysLaterISO(7), timeSlot: "pm", passType: "single", groupSize: 1,
  }, token);
  assertEq(blBooking.status, 403, "陈刚（黑名单）预约被 403 拦截");
  assert(blBooking.data.detail?.includes("黑名单"), "拦截原因包含黑名单");

  log("真实预约接口：受限用户提前时长不足必须 403");
  const wfSoon = await req("POST", "/reservations", {
    museumId, visitorName: "王芳", phone: accounts.wangfang,
    visitDate: daysLaterISO(0), timeSlot: "pm", groupSize: 1,
  }, token);
  assertEq(wfSoon.status, 403, "王芳（受限）24h 内预约被 403 拦截");
  assert(wfSoon.data.detail?.includes("提前"), "拦截原因包含提前时长");

  log("真实预约接口：受限用户团体人数超限必须 403");
  const wfBig = await req("POST", "/reservations", {
    museumId, visitorName: "王芳", phone: accounts.wangfang,
    visitDate: daysLaterISO(7), timeSlot: "pm", groupSize: 5,
  }, token);
  assertEq(wfBig.status, 403, "王芳（受限）5 人团体被 403 拦截");
  assert(wfBig.data.detail?.includes("团体") || wfBig.data.detail?.includes("最多"), "拦截原因包含团体人数");

  log("真实预约接口：优秀用户正常预约必须 201");
  const zmOk = await req("POST", "/reservations", {
    museumId, visitorName: "张敏", phone: accounts.zhangmin,
    visitDate: daysLaterISO(3), timeSlot: "am", groupSize: 2,
  }, token);
  assertEq(zmOk.status, 201, "张敏（优秀）正常预约创建成功 201");
  assert(zmOk.data.id > 0, "返回预约 ID");

  log("批量爽约：昨日上午场必须处理非零预约并生成扣分流水");
  const wfBeforeBatch = await req("GET", `/credit/account?phone=${accounts.liwei}`, null, token);
  const liweiLogsBefore = await req("GET", `/credit/logs?phone=${accounts.liwei}`, null, token);
  const beforeNoShowLogs = liweiLogsBefore.data.filter((l) => l.change_type === "no_show").length;

  const yesterday = daysAgoISO(1);
  const batch = await req("POST", "/credit/no-show/batch", {
    visit_date: yesterday, time_slot: "am", triggered_by: "manual",
  }, token);
  assertEq(batch.status, 200, "批量爽约处理成功");
  assert(batch.data.totalCount > 0, `批量处理总数>0 (实际=${batch.data.totalCount})`);
  assertEq(batch.data.processedCount, batch.data.totalCount, "处理数量等于总数");

  const liweiLogsAfter = await req("GET", `/credit/logs?phone=${accounts.liwei}`, null, token);
  const afterNoShowLogs = liweiLogsAfter.data.filter((l) => l.change_type === "no_show").length;
  assert(afterNoShowLogs > beforeNoShowLogs, `李伟爽约扣分流水增加 (前=${beforeNoShowLogs}, 后=${afterNoShowLogs})`);

  const wfAfterBatch = await req("GET", `/credit/account?phone=${accounts.liwei}`, null, token);
  const scoreDrop = wfBeforeBatch.data.credit_score - wfAfterBatch.data.credit_score;
  assert(scoreDrop >= 15, `李伟信用分因爽约下降≥15 (下降${scoreDrop}分)`);

  const latestNoShowLog = liweiLogsAfter.data.find((l) => l.change_type === "no_show");
  assert(latestNoShowLog.reservation_id > 0, "爽约扣分流水关联了预约 ID");
  assertEq(latestNoShowLog.rule_code, "NO_SHOW_BASE", "爽约扣分为 NO_SHOW_BASE 规则");

  log("申诉管理：待处理申诉必须存在且关联预约");
  const pendingAppeals = await req("GET", "/credit/appeals?status=pending", null, token);
  assert(pendingAppeals.data.length >= 1, "至少 1 条待处理申诉");
  const appeal = pendingAppeals.data[0];
  assertEq(appeal.phone, accounts.wangfang, "申诉属于王芳");
  assert(appeal.reservation_id > 0, "申诉关联了预约 ID");

  const wfLogsBeforeAppeal = await req("GET", `/credit/logs?phone=${accounts.wangfang}`, null, token);
  const noShowLogsBefore = wfLogsBeforeAppeal.data.filter((l) => l.change_type === "no_show");
  assert(noShowLogsBefore.length >= 2, `王芳至少有 2 条爽约流水 (实际${noShowLogsBefore.length}条)`);

  const targetLog = noShowLogsBefore.find((l) => l.reservation_id === appeal.reservation_id);
  assert(targetLog, `申诉对应预约 ${appeal.reservation_id} 的爽约流水存在`);
  const otherNoShowLogs = noShowLogsBefore.filter((l) => l.reservation_id !== appeal.reservation_id);
  assert(otherNoShowLogs.length >= 1, "王芳存在至少 1 条其他爽约流水（用于验证不被回滚）");

  const scoreBeforeAppeal = (await req("GET", `/credit/account?phone=${accounts.wangfang}`, null, token)).data.credit_score;

  log("申诉审核：通过必须只回滚对应爽约扣分，不影响其他扣分项");
  const review = await req("POST", `/credit/appeals/${appeal.id}/review`, {
    approved: true, review_note: "经核实确属不可抗力，撤销爽约记录",
  }, token);
  assertEq(review.status, 200, "申诉审核成功");

  const scoreAfterAppeal = (await req("GET", `/credit/account?phone=${accounts.wangfang}`, null, token)).data.credit_score;
  const recovered = scoreAfterAppeal - scoreBeforeAppeal;
  assertEq(recovered, Math.abs(targetLog.delta), `只回滚申诉对应爽约扣分 +${Math.abs(targetLog.delta)} (实际+${recovered})`);

  const wfLogsAfterAppeal = await req("GET", `/credit/logs?phone=${accounts.wangfang}`, null, token);
  const revertLog = wfLogsAfterAppeal.data.find((l) => l.change_type === "appeal_revert");
  assert(revertLog, "存在 appeal_revert 类型回滚流水");
  assertEq(revertLog.reservation_id, appeal.reservation_id, "回滚流水关联了正确的预约 ID");
  assertEq(revertLog.delta, Math.abs(targetLog.delta), "回滚加分等于原扣分绝对值");

  const otherNoShowStillExists = wfLogsAfterAppeal.data.filter(
    (l) => l.change_type === "no_show" && l.reservation_id !== appeal.reservation_id,
  ).length;
  assertEq(otherNoShowStillExists, otherNoShowLogs.length, "其他爽约流水未受申诉影响，保持不变");

  const appealReservation = await req("GET", "/reservations", null, token);
  const updatedReservation = appealReservation.data.find((r) => r.id === appeal.reservation_id);
  assert(updatedReservation, `找到申诉对应预约 ID=${appeal.reservation_id}`);
  assertEq(updatedReservation.status, "appealed", "申诉对应预约状态变为 appealed");

  log("信用变动通知：申诉通过后必须产生通知");
  const notifs = await req("GET", `/credit/notifications?phone=${accounts.wangfang}`, null, token);
  const appealNotif = notifs.data.find((n) => n.type === "appeal_revert");
  assert(appealNotif, "王芳收到 appeal_revert 类型通知");
  assert(appealNotif.title.includes("申诉") || appealNotif.title.includes("恢复"), "通知标题包含申诉/恢复");

  log("黑名单解除：人工解除后管控状态必须从 blacklist 变为 restricted");
  const blList = await req("GET", "/credit/blacklists?status=active", null, token);
  const cgBl = blList.data.find((b) => b.phone === accounts.chengang);
  assert(cgBl, "陈刚有活跃黑名单记录");

  const beforeRelease = await req("GET", `/credit/account?phone=${accounts.chengang}`, null, token);
  assertEq(beforeRelease.data.control_status, "blacklist", "解除前陈刚为 blacklist");

  const release = await req("POST", `/credit/blacklists/${cgBl.id}/release`, {
    release_note: "用户已提交悔过材料，提前解除黑名单",
  }, token);
  assertEq(release.status, 200, "黑名单解除成功");

  const afterRelease = await req("GET", `/credit/account?phone=${accounts.chengang}`, null, token);
  assertEq(afterRelease.data.control_status, "restricted", "解除后陈刚管控状态变为 restricted");
  assertEq(afterRelease.data.credit_level, "warning", "解除后档位回落至 warning（0 分）");
  assert(afterRelease.data.active_blacklist === null, "解除后无活跃黑名单");

  const blListAfter = await req("GET", "/credit/blacklists?status=active", null, token);
  assert(!blListAfter.data.find((b) => b.phone === accounts.chengang), "解除后活跃黑名单不含陈刚");

  log("解除后再次预约：不再是 403 黑名单拦截，但仍受 warning 档位限制");
  const cgReleasedBooking = await req("POST", "/reservations", {
    museumId, visitorName: "陈刚", phone: accounts.chengang,
    visitDate: daysLaterISO(7), timeSlot: "pm", groupSize: 1,
  }, token);
  assert(cgReleasedBooking.status !== 403 || !cgReleasedBooking.data.detail?.includes("黑名单"),
    "解除后预约不再因黑名单 403 拦截");

  log("统计总览：爽约率、档位分布正确");
  const stats = await req("GET", "/credit/stats/overview", null, token);
  assert(stats.data.total_accounts >= 8, "总账户≥8");
  assert(stats.data.no_show_count >= 8, "爽约预约≥8");
  assert(stats.data.no_show_rate > 0, "爽约率>0");

  const dist = await req("GET", "/credit/stats/tier-distribution", null, token);
  assert(dist.data.length >= 4, "至少 4 个档位有分布数据");

  console.log("\n\x1b[32m========== 全部测试通过 ==========\x1b[0m");
  console.log(`\x1b[32m共执行 ${step} 个测试步骤，断言全部成功\x1b[0m`);
}

main().catch((e) => {
  console.error("\n\x1b[31m测试异常终止:\x1b[0m", e);
  process.exit(1);
});
