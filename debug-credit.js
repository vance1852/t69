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

  console.log("=== Appeal#1 details ===");
  const appeals = await req("GET", "/credit/appeals?status=pending", null, token);
  console.log("Appeal:", JSON.stringify(appeals.data[0], null, 2));

  const resId = appeals.data[0].reservation_id;
  console.log("\n=== Reservation#" + resId + " ===");
  const resvs = await req("GET", "/reservations?id=" + resId, null, token);
  const r = resvs.data.find(x => x.id === resId);
  console.log("Reservation:", JSON.stringify(r, null, 2));

  console.log("\n=== CreditLogs for 13800003333 ===");
  const logs = await req("GET", "/credit/logs?phone=13800003333", null, token);
  for (const l of logs.data) {
    console.log(`Log#${l.id} res_id=${l.reservation_id} type=${l.change_type} delta=${l.delta} rule=${l.rule_code}`);
  }

  console.log("\n=== Chen Gang account before release ===");
  const bl = await req("GET", "/credit/account?phone=13800005555", null, token);
  console.log("ChenGang:", JSON.stringify(bl.data, null, 2));

  console.log("\n=== Tiers query ===");
  const tiers = await req("GET", "/credit/tiers", null, token);
  console.log("Tiers:", JSON.stringify(tiers.data, null, 2));
}
main().catch(e => console.error(e));
