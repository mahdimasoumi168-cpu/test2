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
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_members_active_name ON members(active, full_name);
`);

const ALLOWED_ROOMS = new Set(["management", "khademin", "nazm", "sound", "tadarokat", "paziraei"]);
const PTT_LEASE_MS = 20000;
const roomHolders = new Map();

function signSession(member) {
  const payload = Buffer.from(JSON.stringify({
    sub: member.id,
    exp: Date.now() + 12 * 60 * 60 * 1000
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
    return db.prepare("SELECT id, full_name, role FROM members WHERE id = ? AND active = 1").get(data.sub) || null;
  } catch { return null; }
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "16kb" }));
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

app.get("/api/admin/members", requireMember, requireAdmin, (_req, res) => {
  res.set("Cache-Control", "no-store");
  const members = db.prepare("SELECT id, full_name, role, active, created_at FROM members ORDER BY id DESC LIMIT 500").all();
  res.json({ members });
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
  res.status(201).json({ ok: true, id: result.lastInsertRowid });
});

app.patch("/api/admin/members/:id/active", requireMember, requireAdmin, (req, res) => {
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
  db.prepare("UPDATE members SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
  res.json({ ok: true });
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
    "SELECT id, full_name, guardian_code_hash, person_code_hash, role FROM members WHERE active = 1"
  ).all().filter(m => m.full_name.trim().normalize("NFC") === normalizedName);

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
    if (typeof roomId !== "string" || !ALLOWED_ROOMS.has(roomId)) {
      if (typeof ack === "function") ack({ ok: false, error: "اتاق معتبر نیست." });
      return;
    }
    socket.join(roomId);
    socket.data.joinedRooms.add(roomId);
    if (typeof ack === "function") ack({ ok: true, roomId });
  });

  socket.on("room:leave", (payload = {}) => {
    const roomId = payload.roomId;
    if (typeof roomId !== "string" || !socket.data.joinedRooms.has(roomId)) return;
    releaseHolder(roomId, socket.id);
    socket.leave(roomId);
    socket.data.joinedRooms.delete(roomId);
  });

  socket.on("ptt:request", (payload = {}) => {
    const roomId = payload.roomId;
    if (typeof roomId !== "string" || !socket.data.joinedRooms.has(roomId)) return;
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
    const roomId = payload.roomId;
    if (typeof roomId !== "string") return;
    const lease = roomHolders.get(roomId);
    if (!lease || lease.socketId !== socket.id) return;
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => releaseHolder(roomId, socket.id), PTT_LEASE_MS);
  });

  socket.on("ptt:release", (payload = {}) => {
    const roomId = payload.roomId;
    if (typeof roomId === "string") releaseHolder(roomId, socket.id);
  });

  socket.on("disconnect", () => {
    for (const roomId of socket.data.joinedRooms) releaseHolder(roomId, socket.id);
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
