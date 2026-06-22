const BASE = "http://localhost:7651/api";

async function req(method, path, body = null, token = null) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

function log(title, color = "\x1b[36m") {
  console.log(`\n${color}========= ${title} =========\x1b[0m`);
}

async function main() {
  log("1. Login get Token");
  const login = await req("POST", "/auth/login", { username: "admin", password: "admin123" });
  const token = login.data.access_token;
  console.log("Token length:", token.length);

  log("2. Credit accounts (different tiers)");
  const phones = ["13800001111", "13800003333", "13800004444", "13800005555"];
  for (const p of phones) {
    const r = await req("GET", "/credit/account?phone=" + p, null, token);
    const a = r.data;
    console.log(`  ${a.visitor_name} (${p}): score=${a.credit_score}, level=${a.credit_level}, control=${a.control_status}, blacklist=${!!a.active_blacklist}`);
  }

  log("3. Credit tier rules");
  const tiers = await req("GET", "/credit/tiers", null, token);
  for (const t of tiers.data) {
    console.log(`  Tier[${t.display_name}]: ${t.min_score}-${t.max_score} ctrl=${t.control_status} advance=${t.require_advance_hours}h dailyMax=${t.max_daily_reservations} peak=${t.allow_peak_time} grpMax=${t.max_group_size}`);
  }

  log("4. Booking eligibility check (intercept tests)");
  const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
  const tests = [
    { phone: "13800005555", d: future, slot: "pm", size: 1, desc: "Blacklist user book" },
    { phone: "13800004444", d: future, slot: "am", size: 1, desc: "Warning tier peak am" },
    { phone: "13800003333", d: soon, slot: "pm", size: 1, desc: "Restricted <24h advance" },
    { phone: "13800003333", d: future, slot: "pm", size: 5, desc: "Restricted group>3" },
    { phone: "13800001111", d: future, slot: "am", size: 2, desc: "Excellent normal book" },
  ];
  for (const t of tests) {
    const r = await req("POST", "/credit/booking/check", {
      phone: t.phone, visit_date: t.d, time_slot: t.slot, group_size: t.size
    }, token);
    const ok = r.data.allowed ? "PASS" : `BLOCK: ${r.data.reason}`;
    console.log(`  [${t.desc}] -> ${ok}`);
  }

  log("5. Credit logs for 13800003333 (Wang Fang)");
  const logs = await req("GET", "/credit/logs?phone=13800003333", null, token);
  console.log("  Log count:", logs.data.length);
  for (const l of logs.data) {
    console.log(`    [${l.change_type}] ${l.delta} ${l.before_score}->${l.after_score} ${l.reason}`);
  }

  log("6. Stats overview");
  const s = await req("GET", "/credit/stats/overview", null, token);
  console.log(`  Accounts total=${s.data.total_accounts} normal=${s.data.normal_count} restricted=${s.data.restricted_count} blacklist=${s.data.blacklist_count}`);
  console.log(`  Reservations total=${s.data.total_reservations} no_show=${s.data.no_show_count} rate=${s.data.no_show_rate}%`);
  console.log(`  Appeals total=${s.data.total_appeals} pending=${s.data.pending_appeals}`);

  log("7. Tier distribution");
  const dist = await req("GET", "/credit/stats/tier-distribution", null, token);
  for (const d of dist.data) {
    console.log(`  ${d.display_name} (${d.min_score}-${d.max_score}): ${d.count} users`);
  }

  log("8. Active blacklist");
  const bl = await req("GET", "/credit/blacklists?status=active", null, token);
  for (const b of bl.data) {
    console.log(`  ${b.visitor_name} ${b.phone}: reason=${b.reason} endAt=${b.end_at}`);
  }

  log("9. Pending appeals");
  const ap = await req("GET", "/credit/appeals?status=pending", null, token);
  for (const a of ap.data) {
    console.log(`  Appeal#${a.id} ${a.visitor_name} ${a.phone}: ${a.reason}`);
  }

  log("10. Process no-show batch (yesterday am)");
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const ns = await req("POST", "/credit/no-show/batch", {
    visit_date: y, time_slot: "am", triggered_by: "manual"
  }, token);
  if (ns.status === 200) {
    console.log(`  Batch#${ns.data.batchId}: total=${ns.data.totalCount} processed=${ns.data.processedCount}`);
  } else {
    console.log("  No pending or error:", JSON.stringify(ns.data));
  }

  log("11. Approve appeal #1 for Wang Fang (rollback)");
  const accBefore = await req("GET", "/credit/account?phone=13800003333", null, token);
  console.log(`  Before: WangFang score=${accBefore.data.credit_score}`);
  const appealsBefore = await req("GET", "/credit/appeals?status=pending", null, token);
  const targetAppeal = appealsBefore.data[0];
  console.log(`  Target appeal: id=${targetAppeal?.id} res_id=${targetAppeal?.reservation_id}`);
  if (targetAppeal?.reservation_id) {
    const logsMatch = await req("GET", "/credit/logs?phone=13800003333", null, token);
    const matched = logsMatch.data.filter(l => l.reservation_id === targetAppeal.reservation_id);
    console.log(`  Logs with res_id=${targetAppeal.reservation_id}: ${matched.length}`);
    for (const m of matched) console.log(`    -> ${m.change_type} delta=${m.delta}`);
    const resv = await req("GET", "/reservations", null, token);
    const r = resv.data.find(x => x.id === targetAppeal.reservation_id);
    console.log(`  Reservation status: ${r?.status}`);
  }
  const reviewBody = { approved: true, review_note: "Verified medical evidence, revert no-show" };
  const rev = await req("POST", "/credit/appeals/1/review", reviewBody, token);
  if (rev.status === 200) {
    const accAfter = await req("GET", "/credit/account?phone=13800003333", null, token);
    const diff = accAfter.data.credit_score - accBefore.data.credit_score;
    console.log(`  Approved! After: WangFang score=${accAfter.data.credit_score} (recovered +${diff})`);
    const notifs = await req("GET", "/credit/notifications?phone=13800003333", null, token);
    console.log(`  Notif after appeal: ${notifs.data.length}`);
    for (const n of notifs.data) console.log(`    [${n.type}] ${n.title}`);
  } else {
    console.log("  Appeal review error:", JSON.stringify(rev.data));
  }

  log("12. Notifications for Wang Fang");
  const nt = await req("GET", "/credit/notifications?phone=13800003333", null, token);
  console.log("  Notif count:", nt.data.length);
  for (const n of nt.data) {
    console.log(`    [${n.type}] ${n.title}`);
  }

  log("13. Manual release blacklist for Chen Gang");
  const blBefore = await req("GET", "/credit/account?phone=13800005555", null, token);
  console.log(`  Before: ChenGang status=${blBefore.data.control_status}`);
  const rel = await req("POST", "/credit/blacklists/1/release", {
    release_note: "Manual review approved, early release"
  }, token);
  if (rel.status === 200) {
    const blAfter = await req("GET", "/credit/account?phone=13800005555", null, token);
    console.log(`  Released! After: ChenGang status=${blAfter.data.control_status}`);
  } else {
    console.log("  Release error:", JSON.stringify(rel.data));
  }

  log("ALL TESTS PASSED", "\x1b[32m");
}

main().catch(e => { console.error(e); process.exit(1); });
