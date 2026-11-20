const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("authentication and admin member APIs enforce roles", { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamyar-test-"));
  const dbFile = path.join(dir, "test.sqlite");
  const port = 31000 + (process.pid % 20000);
  const env = { ...process.env, PORT: String(port), DATABASE_FILE: dbFile, SESSION_SECRET: "test-secret-at-least-32-characters-long" };
  const add = (name, guardian, person, role) => {
    const r = spawnSync(process.execPath, ["scripts/add-member.js", name, guardian, person, role], { cwd: path.join(__dirname, ".."), env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  };
  add("عضو آزمایشی", "G-12345", "P-12345", "member");
  add("مدیر آزمایشی", "G-67890", "P-67890", "admin");
  const child = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env, stdio: "ignore" });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + "/api/health"); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.equal(ready, true, "server did not become ready");
  const login = async (fullName, guardianCode, personCode) => {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fullName, guardianCode, personCode }) });
    return { status: r.status, data: await r.json() };
  };
  const member = await login("عضو آزمایشی", "G-12345", "P-12345");
  const admin = await login("مدیر آزمایشی", "G-67890", "P-67890");
  assert.equal(member.status, 200);
  assert.equal(admin.status, 200);
  const unauth = await fetch(base + "/api/admin/members");
  assert.equal(unauth.status, 401);
  const forbidden = await fetch(base + "/api/admin/members", { headers: { Authorization: "Bearer " + member.data.token } });
  assert.equal(forbidden.status, 403);
  const allowed = await fetch(base + "/api/admin/members", { headers: { Authorization: "Bearer " + admin.data.token } });
  assert.equal(allowed.status, 200);
  const listing = await allowed.json();
  assert.equal(listing.members.length, 2);
  const created = await fetch(base + "/api/admin/members", { method: "POST", headers: { Authorization: "Bearer " + admin.data.token, "Content-Type": "application/json" }, body: JSON.stringify({ fullName: "عضو جدید", guardianCode: "G-NEW", personCode: "P-NEW", role: "member" }) });
  assert.equal(created.status, 201);
  const invalidRoomMember = await fetch(base + "/api/admin/members/999999/active", { method: "PATCH", headers: { Authorization: "Bearer " + admin.data.token, "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) });
  assert.equal(invalidRoomMember.status, 404);
});
