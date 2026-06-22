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

async function main() {
  const login = await req("POST", "/auth/login", { username: "admin", password: "admin123" });
  const token = login.data.access_token;

  const appeals = await req("GET", "/credit/appeals", null, token);
  const appeal = appeals.data[0];
  console.log("Appeal:", JSON.stringify(appeal, null, 2));

  const resId = appeal.reservation_id;
  const reservations = await req("GET", "/reservations", null, token);
  const r = reservations.data.find(x => x.id === resId);
  console.log("\nReservation#" + resId + ":", JSON.stringify(r, null, 2));

  const logs = await req("GET", "/credit/logs?phone=13800003333", null, token);
  console.log("\nLogs for WangFang:");
  for (const l of logs.data) {
    console.log(`  Log#${l.id} res_id=${l.reservation_id} type=${l.change_type} delta=${l.delta} rule=${l.rule_code}`);
  }

  console.log("\nChecking appeal reservation match...");
  const matchedLogs = logs.data.filter(l => l.reservation_id === resId && (l.change_type === "no_show" || l.change_type === "group_no_show"));
  console.log("Matched logs count:", matchedLogs.length);
  for (const l of matchedLogs) console.log("  ", JSON.stringify(l));
}
main().catch(e => console.error(e));
