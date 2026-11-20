require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32) {
  console.error("SESSION_SECRET must be set to a random value of at least 32 characters.");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  pingInterval: 25000,
  pingTimeout: 20000
});
const port = Number(process.env.PORT || 3000);
const dbFile = process.env.DATABASE_FILE || "./data/hamyar.sqlite";
fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS members (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 full_name TEXT NOT NULL,
 guardian_code_hash TEXT NOT NULL,
 person_code_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'member',
 active INTEGER NOT NULL DEFAULT 1,
 session_version INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_members_active_name ON members(active, full_name);
CREATE TABLE IF NOT EXISTS audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_id INTEGER,
 event_type TEXT NOT NULL,
 target_id TEXT,
 details_json TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS rooms (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL UNIQUE,
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const memberColumns = db.prepare("PRAGMA table_info(members)").all().map(column => column.name);
if (!memberColumns.includes("session_version")) {
  db.exec("ALTER TABLE members ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");
}
const roomColumns = db.prepare("PRAGMA table_info(rooms)").all().map(column => column.name);
if (!roomColumns.includes("max_members")) {
  db.exec("ALTER TABLE rooms ADD COLUMN max_members INTEGER NOT NULL DEFAULT 50 CHECK (max_members BETWEEN 1 AND 500)");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_name_ci ON rooms(lower(name))");
const seedRooms = db.prepare("INSERT OR IGNORE INTO rooms (id, name) VALUES (?, ?)");
for (const [id, name] of [
  ["management", "مدیریت"], ["khademin", "خادمین"], ["nazm", "نظم"],
  ["sound", "صوت"], ["tadarokat", "تدارکات"], ["paziraei", "پذیرایی"]
]) seedRooms.run(id, name);

const PTT_LEASE_MS = 20000;
const PTT_REQUEST_COOLDOWN_MS = 350;
const PTT_HEARTBEAT_MIN_INTERVAL_MS = 2000;

function auditEvent(actorId, eventType, targetId, details = {}) {
  db.prepare("INSERT INTO audit_events (actor_id, event_type, target_id, details_json) VALUES (?, ?, ?, ?)")
    .run(actorId || null, eventType, targetId == null ? null : String(targetId), JSON.stringify(details));
}

function refreshSocketMember(socket) {
  const current = db.prepare("SELECT id, full_name, role FROM members WHERE id = ? AND active = 1")
    .get(socket.member && socket.member.id);
  if (!current) {
    for (const roomId of socket.data.joinedRooms || []) releaseHolder(roomId, socket.id);
    socket.disconnect(true);
    return false;
  }
  socket.member = current;
  return true;
}
const roomHolders = new Map();

function signSession(member) {
  const payload = Buffer.from(JSON.stringify({
    sub: member.id,
    exp: Date.now() + 12 * 60 * 60 * 1000,
    ver: member.session_version || 0
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return payload + "." + sig;
}

function verifySession(token) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(sig, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Number.isSafeInteger(data.sub) || !Number.isFinite(data.exp) || data.exp < Date.now()) return null;
    const member = db.prepare("SELECT id, full_name, role, session_version FROM members WHERE id = ? AND active = 1").get(data.sub);
    if (!member || data.ver !== member.session_version) return null;
    return member;
  } catch { return null; }
}

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "wss:", "https:", "stun:", "turn:", "turns:"],
      mediaSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"]
    }
  }
}));
app.use(express.json({ limit: "16kb" }));
app.use("/api/admin", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use("/api/login", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use(express.static(path.join(__dirname, "public")));

function requireMember(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const member = verifySession(token);
  if (!member) return res.status(401).json({ error: "نشست معتبر نیست؛ دوباره وارد شوید." });
  req.member = member;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.member || req.member.role !== "admin") {
    return res.status(403).json({ error: "دسترسی مدیر لازم است." });
  }
  next();
}

app.get("/api/me", requireMember, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ member: { id: req.member.id, name: req.member.full_name, role: req.member.role } });
});

app.get("/api/rooms", requireMember, (_req, res) => {
  res.set("Cache-Control", "no-store");
  const rooms = db.prepare("SELECT id, name FROM rooms WHERE active = 1 ORDER BY CASE WHEN id = 'management' THEN 0 ELSE 1 END, name COLLATE NOCASE").all();
  res.json({ rooms });
});

app.get("/api/admin/members", requireMember, requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  const rawLimit = Number(req.query.limit ?? 50);
  const rawOffset = Number(req.query.offset ?? 0);
  if (!Number.isSafeInteger(rawLimit) || !Number.isSafeInteger(rawOffset) || rawOffset < 0) {
    return res.status(400).json({ error: "صفحه‌بندی درخواست معتبر نیست." });
  }
  const limit = Math.min(100, Math.max(1, rawLimit));
  const offset = rawOffset;
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const pattern = "%" + query + "%";
  const members = query
    ? db.prepare("SELECT id, full_name, role, active, created_at FROM members WHERE full_name LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?").all(pattern, limit, offset)
    : db.prepare("SELECT id, full_name, role, active, created_at FROM members ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);
  const total = query
    ? db.prepare("SELECT COUNT(*) AS n FROM members WHERE full_name LIKE ?").get(pattern).n
    : db.prepare("SELECT COUNT(*) AS n FROM members").get().n;
  res.json({ members, total, nextOffset: offset + members.length < total ? offset + members.length : null });
});

app.post("/api/admin/members", requireMember, requireAdmin, (req, res) => {
  const { fullName, guardianCode, personCode, role = "member" } = req.body || {};
  if (![fullName, guardianCode, personCode].every(v => typeof v === "string" && v.trim().length > 0 && v.length <= 120)) {
    return res.status(400).json({ error: "نام و هر دو کد الزامی است." });
  }
  if (!["member", "admin"].includes(role)) return res.status(400).json({ error: "نقش انتخاب‌شده معتبر نیست." });
  const result = db.prepare(
    "INSERT INTO members (full_name, guardian_code_hash, person_code_hash, role) VALUES (?, ?, ?, ?)"
  ).run(fullName.trim().normalize("NFC"), bcrypt.hashSync(guardianCode.trim(), 12), bcrypt.hashSync(personCode.trim(), 12), role);
  auditEvent(req.member.id, "member.created", result.lastInsertRowid, { role });
  res.status(201).json({ ok: true, id: result.lastInsertRowid });
});

app.get("/api/admin/rooms", requireMember, requireAdmin, (_req, res) => {
  res.set("Cache-Control", "no-store");
  const rooms = db.prepare("SELECT id, name, active, max_members, created_at FROM rooms ORDER BY CASE WHEN id = 'management' THEN 0 ELSE 1 END, name COLLATE NOCASE").all()
    .map(room => ({ ...room, connected_members: io.sockets.adapter.rooms.get(room.id)?.size || 0 }));
  res.json({ rooms });
});

app.post("/api/admin/rooms", requireMember, requireAdmin, (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim().normalize("NFC") : "";
  const maxMembers = req.body?.maxMembers === undefined ? 50 : Number(req.body.maxMembers);
  if (!name || name.length > 60) return res.status(400).json({ error: "نام اتاق باید بین ۱ تا ۶۰ نویسه باشد." });
  if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 500) {
    return res.status(400).json({ error: "ظرفیت اتاق باید عددی بین ۱ تا ۵۰۰ باشد." });
  }
  try {
    const id = "room_" + crypto.randomBytes(6).toString("hex");
    db.prepare("INSERT INTO rooms (id, name, max_members) VALUES (?, ?, ?)").run(id, name, maxMembers);
    auditEvent(req.member.id, "room.created", id, { name, maxMembers });
    return res.status(201).json({ ok: true, room: { id, name, active: 1, maxMembers } });
  } catch (error) {
    if (String(error.code || "").includes("SQLITE_CONSTRAINT")) {
      return res.status(409).json({ error: "اتاقی با این نام از قبل وجود دارد." });
    }
    throw error;
  }
});

app.patch("/api/admin/rooms/:id", requireMember, requireAdmin, (req, res) => {
  const id = req.params.id;
  const name = req.body?.name === undefined ? undefined : String(req.body.name).trim().normalize("NFC");
  const maxMembers = req.body?.maxMembers === undefined ? undefined : Number(req.body.maxMembers);
  if (!/^([a-z0-9_-]){1,80}$/.test(id) || (name === undefined && maxMembers === undefined)) {
    return res.status(400).json({ error: "اطلاعات ویرایش اتاق معتبر نیست." });
  }
  if (name !== undefined && (!name || name.length > 60)) return res.status(400).json({ error: "نام اتاق باید بین ۱ تا ۶۰ نویسه باشد." });
  if (maxMembers !== undefined && (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 500)) {
    return res.status(400).json({ error: "ظرفیت اتاق باید عددی بین ۱ تا ۵۰۰ باشد." });
  }
  const existing = db.prepare("SELECT id, max_members FROM rooms WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "اتاق پیدا نشد." });
  const connected = io.sockets.adapter.rooms.get(id)?.size || 0;
  if (maxMembers !== undefined && maxMembers < connected) return res.status(409).json({ error: "ظرفیت جدید از تعداد اعضای متصل کمتر است." });
  try {
    if (name !== undefined && maxMembers !== undefined) db.prepare("UPDATE rooms SET name = ?, max_members = ? WHERE id = ?").run(name, maxMembers, id);
    else if (name !== undefined) db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(name, id);
    else db.prepare("UPDATE rooms SET max_members = ? WHERE id = ?").run(maxMembers, id);
  } catch (error) {
    if (String(error.code || "").includes("SQLITE_CONSTRAINT")) return res.status(409).json({ error: "نام اتاق تکراری است." });
    throw error;
  }
  auditEvent(req.member.id, "room.updated", id, { name, maxMembers });
  res.json({ ok: true });
});

app.patch("/api/admin/members/:id", requireMember, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "شناسه عضو معتبر نیست." });
  const target = db.prepare("SELECT id, role, active FROM members WHERE id = ?").get(id);
  if (!target) return res.status(404).json({ error: "عضو پیدا نشد." });
  const { fullName, role, guardianCode, personCode } = req.body || {};
  if (fullName === undefined && role === undefined && guardianCode === undefined && personCode === undefined) {
    return res.status(400).json({ error: "حداقل یک مورد برای ویرایش لازم است." });
  }
  if (fullName !== undefined && (typeof fullName !== "string" || !fullName.trim() || fullName.length > 120)) {
    return res.status(400).json({ error: "نام عضو معتبر نیست." });
  }
  if (role !== undefined && !["member", "admin"].includes(role)) return res.status(400).json({ error: "نقش انتخاب‌شده معتبر نیست." });
  for (const code of [guardianCode, personCode]) {
    if (code !== undefined && (typeof code !== "string" || !code.trim() || code.length > 120)) {
      return res.status(400).json({ error: "کد ورود باید بین ۱ تا ۱۲۰ نویسه باشد." });
    }
  }
  if (target.active === 1 && target.role === "admin" && role === "member") {
    const count = db.prepare("SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND active = 1").get().n;
    if (count <= 1) return res.status(409).json({ error: "تغییر نقش آخرین مدیر فعال مجاز نیست." });
  }
  const fields = [];
  const values = [];
  if (fullName !== undefined) { fields.push("full_name = ?"); values.push(fullName.trim().normalize("NFC")); }
  if (role !== undefined) { fields.push("role = ?"); values.push(role); }
  if (guardianCode !== undefined) { fields.push("guardian_code_hash = ?"); values.push(bcrypt.hashSync(guardianCode.trim(), 12)); }
  if (personCode !== undefined) { fields.push("person_code_hash = ?"); values.push(bcrypt.hashSync(personCode.trim(), 12)); }
  fields.push("session_version = session_version + 1");
  values.push(id);
  db.prepare("UPDATE members SET " + fields.join(", ") + " WHERE id = ?").run(...values);
  auditEvent(req.member.id, "member.updated", id, { changed: fields.map(x => x.split(" ")[0]) });
  const sockets = await io.fetchSockets();
  for (const connected of sockets) {
    if (connected.member?.id === id) {
      for (const roomId of connected.data.joinedRooms || []) releaseHolder(roomId, connected.id);
      connected.emit("session:revoked", { reason: "account_updated" });
      connected.disconnect(true);
    }
  }
  res.json({ ok: true });
});

app.patch("/api/admin/rooms/:id/active", requireMember, requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { active } = req.body || {};
  if (!/^([a-z0-9_-]){1,80}$/.test(id) || typeof active !== "boolean") {
    return res.status(400).json({ error: "شناسه یا وضعیت اتاق معتبر نیست." });
  }
  if (id === "management" && !active) return res.status(400).json({ error: "اتاق مدیریت قابل غیرفعال‌سازی نیست." });
  const room = db.prepare("SELECT id FROM rooms WHERE id = ?").get(id);
  if (!room) return res.status(404).json({ error: "اتاق پیدا نشد." });
  db.prepare("UPDATE rooms SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
  auditEvent(req.member.id, active ? "room.activated" : "room.deactivated", id);
  if (!active) {
    releaseHolder(id);
    const sockets = await io.in(id).fetchSockets();
    for (const connected of sockets) {
      connected.emit("room:disabled");
      connected.data.joinedRooms?.delete(id);
      connected.leave(id);
    }
  }
  res.json({ ok: true });
});

app.patch("/api/admin/members/:id/active", requireMember, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { active } = req.body || {};
  if (!Number.isSafeInteger(id) || id < 1 || typeof active !== "boolean") {
    return res.status(400).json({ error: "شناسه یا وضعیت ارسالی معتبر نیست." });
  }
  if (id === req.member.id && active === false) return res.status(400).json({ error: "مدیر نمی‌تواند حساب خودش را غیرفعال کند." });
  const target = db.prepare("SELECT id, role, active FROM members WHERE id = ?").get(id);
  if (!target) return res.status(404).json({ error: "عضو پیدا نشد." });
  if (target.role === "admin" && target.active === 1 && active === false) {
    const count = db.prepare("SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND active = 1").get().n;
    if (count <= 1) return res.status(409).json({ error: "غیرفعال‌کردن آخرین مدیر مجاز نیست." });
  }
  db.prepare("UPDATE members SET active = ?, session_version = session_version + 1 WHERE id = ?").run(active ? 1 : 0, id);
  auditEvent(req.member.id, active ? "member.activated" : "member.deactivated", id);
  if (!active) {
    const sockets = await io.fetchSockets();
    for (const connected of sockets) {
      if (connected.member?.id === id) {
        for (const roomId of connected.data.joinedRooms || []) releaseHolder(roomId, connected.id);
        connected.emit("session:revoked", { reason: "account_disabled" });
        connected.disconnect(true);
      }
    }
  }
  res.json({ ok: true });
});

app.get("/api/admin/audit", requireMember, requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const events = db.prepare("SELECT id, actor_id, event_type, target_id, details_json, created_at FROM audit_events ORDER BY id DESC LIMIT ?").all(limit);
  res.json({ events });
});

app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, service: "hamyar-heyat" });
});

app.post("/api/login", (req, res) => {
  const { fullName, guardianCode, personCode } = req.body || {};
  if (![fullName, guardianCode, personCode].every(v =>
    typeof v === "string" && v.trim().length > 0 && v.length <= 120
  )) {
    return res.status(400).json({ error: "همهٔ اطلاعات ورود الزامی است." });
  }

  const normalizedName = fullName.trim().normalize("NFC");
  const candidates = db.prepare(
    "SELECT id, full_name, guardian_code_hash, person_code_hash, role, session_version FROM members WHERE active = 1 AND full_name = ?"
  ).all(normalizedName);

  let member = null;
  for (const candidate of candidates) {
    const guardianOk = bcrypt.compareSync(guardianCode.trim(), candidate.guardian_code_hash);
    const personOk = bcrypt.compareSync(personCode.trim(), candidate.person_code_hash);
    if (guardianOk && personOk) { member = candidate; break; }
  }
  if (!member) return res.status(401).json({ error: "اطلاعات ورود صحیح نیست یا عضویت فعال نیست." });

  res.set("Cache-Control", "no-store");
  return res.json({
    token: signSession(member),
    member: { name: member.full_name, role: member.role }
  });
});

io.use((socket, next) => {
  const member = verifySession(socket.handshake.auth && socket.handshake.auth.token);
  if (!member) return next(new Error("unauthorized"));
  socket.member = member;
  next();
});

function releaseHolder(roomId, expectedSocketId) {
  const lease = roomHolders.get(roomId);
  if (!lease || (expectedSocketId && lease.socketId !== expectedSocketId)) return false;
  clearTimeout(lease.timer);
  roomHolders.delete(roomId);
  io.to(roomId).emit("ptt:released");
  return true;
}

io.on("connection", socket => {
  socket.data.joinedRooms = new Set();

  socket.on("room:join", (payload = {}, ack) => {
    const roomId = payload.roomId;
    if (typeof roomId !== "string" || !db.prepare("SELECT 1 FROM rooms WHERE id = ? AND active = 1").get(roomId)) {
      if (typeof ack === "function") ack({ ok: false, error: "اتاق معتبر نیست." });
      return;
    }
    if (!refreshSocketMember(socket)) {
      if (typeof ack === "function") ack({ ok: false, error: "نشست معتبر نیست." });
      return;
    }
    if (roomId === "management" && socket.member.role !== "admin") {
      if (typeof ack === "function") ack({ ok: false, error: "ورود به اتاق مدیریت مجاز نیست." });
      return;
    }
    const room = db.prepare("SELECT max_members FROM rooms WHERE id = ? AND active = 1").get(roomId);
    if (!room) {
      if (typeof ack === "function") ack({ ok: false, error: "این اتاق فعال نیست." });
      return;
    }
    const currentSockets = io.sockets.adapter.rooms.get(roomId);
    if (!socket.rooms.has(roomId) && currentSockets && currentSockets.size >= room.max_members) {
      if (typeof ack === "function") ack({ ok: false, error: "ظرفیت این اتاق تکمیل است." });
      return;
    }
    for (const previousRoom of [...socket.data.joinedRooms]) {
      if (previousRoom === roomId) continue;
      releaseHolder(previousRoom, socket.id);
      socket.leave(previousRoom);
      socket.data.joinedRooms.delete(previousRoom);
    }
    socket.join(roomId);
    socket.data.joinedRooms.add(roomId);
    if (typeof ack === "function") ack({ ok: true, roomId });
  });

  socket.on("room:leave", (payload = {}) => {
    if (!refreshSocketMember(socket)) return;
    const roomId = payload.roomId;
    if (typeof roomId !== "string" || !socket.data.joinedRooms.has(roomId)) return;
    releaseHolder(roomId, socket.id);
    socket.leave(roomId);
    socket.data.joinedRooms.delete(roomId);
  });

  socket.on("ptt:request", (payload = {}) => {
    if (!refreshSocketMember(socket)) return;
    const now = Date.now();
    if (now - (socket.data.lastPttRequestAt || 0) < PTT_REQUEST_COOLDOWN_MS) return;
    socket.data.lastPttRequestAt = now;
    const roomId = payload.roomId;
    if (typeof roomId !== "string" || !socket.data.joinedRooms.has(roomId)) return;
    if (!db.prepare("SELECT 1 FROM rooms WHERE id = ? AND active = 1").get(roomId)) {
      releaseHolder(roomId);
      socket.emit("room:disabled");
      socket.leave(roomId);
      socket.data.joinedRooms.delete(roomId);
      return;
    }
    const existing = roomHolders.get(roomId);
    if (existing) {
      socket.emit("ptt:busy", { memberName: existing.memberName });
      return;
    }
    const lease = {
      socketId: socket.id,
      memberName: socket.member.full_name,
      timer: null
    };
    lease.timer = setTimeout(() => releaseHolder(roomId, socket.id), PTT_LEASE_MS);
    roomHolders.set(roomId, lease);
    io.to(roomId).emit("ptt:granted", { memberName: lease.memberName });
  });

  socket.on("ptt:heartbeat", (payload = {}) => {
    if (!refreshSocketMember(socket)) return;
    const now = Date.now();
    if (now - (socket.data.lastPttHeartbeatAt || 0) < PTT_HEARTBEAT_MIN_INTERVAL_MS) return;
    socket.data.lastPttHeartbeatAt = now;
    const roomId = payload.roomId;
    if (typeof roomId !== "string" || !socket.data.joinedRooms.has(roomId)) return;
    if (!db.prepare("SELECT 1 FROM rooms WHERE id = ? AND active = 1").get(roomId)) {
      releaseHolder(roomId, socket.id);
      socket.emit("room:disabled");
      socket.leave(roomId);
      socket.data.joinedRooms.delete(roomId);
      return;
    }
    const lease = roomHolders.get(roomId);
    if (!lease || lease.socketId !== socket.id) return;
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => releaseHolder(roomId, socket.id), PTT_LEASE_MS);
  });

  socket.on("ptt:release", (payload = {}) => {
    if (!refreshSocketMember(socket)) return;
    const roomId = payload.roomId;
    if (typeof roomId === "string") releaseHolder(roomId, socket.id);
  });

  socket.on("disconnect", () => {
    for (const roomId of socket.data.joinedRooms) releaseHolder(roomId, socket.id);
    socket.data.joinedRooms.clear();
  });
});

server.listen(port, "0.0.0.0", () => console.log(`Hamyar Heyat listening on :${port}`));

function shutdown() {
  for (const roomId of roomHolders.keys()) releaseHolder(roomId);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
