const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { io: connectSocket } = require("socket.io-client");

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
  const createdData = await created.json();
  const memberRooms = await fetch(base + "/api/rooms", { headers: { Authorization: "Bearer " + member.data.token } });
  assert.equal(memberRooms.status, 200);
  const initialRooms = await memberRooms.json();
  assert.equal(initialRooms.rooms.length, 6);
  const memberAdminRooms = await fetch(base + "/api/admin/rooms", { headers: { Authorization: "Bearer " + member.data.token } });
  assert.equal(memberAdminRooms.status, 403);
  const adminRooms = await fetch(base + "/api/admin/rooms", { headers: { Authorization: "Bearer " + admin.data.token } });
  assert.equal(adminRooms.status, 200);
  const createdRoom = await fetch(base + "/api/admin/rooms", { method: "POST", headers: { Authorization: "Bearer " + admin.data.token, "Content-Type": "application/json" }, body: JSON.stringify({ name: "برنامه‌ریزی" }) });
  assert.equal(createdRoom.status, 201);
  const roomData = await createdRoom.json();
  assert.match(roomData.room.id, /^room_[a-f0-9]{12}$/);
  const duplicateRoom = await fetch(base + "/api/admin/rooms", { method: "POST", headers: { Authorization: "Bearer " + admin.data.token, "Content-Type": "application/json" }, body: JSON.stringify({ name: "برنامه‌ریزی" }) });
  assert.equal(duplicateRoom.status, 409);
  const roomState = await fetch(base + "/api/admin/rooms/" + roomData.room.id + "/active", { method: "PATCH", headers: { Authorization: "Bearer " + admin.data.token, "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) });
  assert.equal(roomState.status, 200);
  const afterDisable = await fetch(base + "/api/rooms", { headers: { Authorization: "Bearer " + member.data.token } });
  const activeRoomIds = (await afterDisable.json()).rooms.map(x => x.id);
  assert.equal(activeRoomIds.includes(roomData.room.id), false);
  const invalidRoomMember = await fetch(base + "/api/admin/members/999999/active", { method: "PATCH", headers: { Authorization: "Bearer " + admin.data.token, "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) });
  assert.equal(invalidRoomMember.status, 404);

  const memberId = listing.members.find(x => x.full_name === "عضو آزمایشی").id;
  const socket = connectSocket(base, { auth: { token: member.data.token }, transports: ["websocket"] });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  const managementDenied = await new Promise(resolve => socket.emit("room:join", { roomId: "management" }, resolve));
  assert.equal(managementDenied.ok, false);
  const joined = await new Promise(resolve => socket.emit("room:join", { roomId: "nazm" }, resolve));
  assert.equal(joined.ok, true);

  const deactivated = await fetch(base + "/api/admin/members/" + memberId + "/active", {
    method: "PATCH",
    headers: { Authorization: "Bearer " + admin.data.token, "Content-Type": "application/json" },
    body: JSON.stringify({ active: false })
  });
  assert.equal(deactivated.status, 200);
  await new Promise(resolve => {
    if (!socket.connected) return resolve();
    socket.once("disconnect", resolve);
    setTimeout(resolve, 1500);
  });
  const revokedSession = await fetch(base + "/api/me", { headers: { Authorization: "Bearer " + member.data.token } });
  assert.equal(revokedSession.status, 401);
  const audit = await fetch(base + "/api/admin/audit?limit=20", { headers: { Authorization: "Bearer " + admin.data.token } });
  assert.equal(audit.status, 200);
  const auditData = await audit.json();
  assert.ok(auditData.events.some(x => x.event_type === "member.deactivated"));

  const createdMemberLogin = await login("عضو جدید", "G-NEW", "P-NEW");
  assert.equal(createdMemberLogin.status, 200);
  const changedCredentials = await fetch(base + "/api/admin/members/" + createdData.id, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + admin.data.token, "Content-Type": "application/json" },
    body: JSON.stringify({ personCode: "P-UPDATED" })
  });
  assert.equal(changedCredentials.status, 200);
  const staleAfterCredentialChange = await fetch(base + "/api/me", {
    headers: { Authorization: "Bearer " + createdMemberLogin.data.token }
  });
  assert.equal(staleAfterCredentialChange.status, 401);
});
