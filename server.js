require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
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
const io = new Server(server);
const port = Number(process.env.PORT || 3000);
const dbFile = process.env.DATABASE_FILE || "./data/hamyar.sqlite";
require("fs").mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
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
`);

function signSession(member) {
 const payload = Buffer.from(JSON.stringify({ sub: member.id, name: member.full_name, role: member.role, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString("base64url");
 const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
 return payload + "." + sig;
}
function verifySession(token) {
 if (typeof token !== "string") return null;
 const [payload, sig] = token.split(".");
 if (!payload || !sig) return null;
 const expected = crypto.createHmac("sha256", secret).update(payload).digest();
 let actual;
 try { actual = Buffer.from(sig, "base64url"); } catch { return null; }
 if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
 try {
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!data.sub || !data.exp || data.exp < Date.now()) return null;
  const member = db.prepare("SELECT id, full_name, role FROM members WHERE id = ? AND active = 1").get(data.sub);
  return member || null;
 } catch { return null; }
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "hamyar-heyat" }));

app.post("/api/login", (req, res) => {
 const { fullName, guardianCode, personCode } = req.body || {};
 if (![fullName, guardianCode, personCode].every(v => typeof v === "string" && v.trim().length)) {
  return res.status(400).json({ error: "همهٔ اطلاعات ورود الزامی است." });
 }
 const members = db.prepare("SELECT id, full_name, guardian_code_hash, person_code_hash, role FROM members WHERE active = 1").all();
 const member = members.find(m =>
  m.full_name.trim().toLocaleLowerCase("fa") === fullName.trim().toLocaleLowerCase("fa") &&
  bcrypt.compareSync(guardianCode.trim(), m.guardian_code_hash) &&
  bcrypt.compareSync(personCode.trim(), m.person_code_hash)
 );
 if (!member) return res.status(401).json({ error: "اطلاعات ورود صحیح نیست یا عضویت فعال نیست." });
 return res.json({ token: signSession(member), member: { name: member.full_name, role: member.role } });
});

io.use((socket, next) => {
 const member = verifySession(socket.handshake.auth && socket.handshake.auth.token);
 if (!member) return next(new Error("unauthorized"));
 socket.member = member;
 next();
});
const roomHolders = new Map();
io.on("connection", socket => {
 socket.on("room:join", ({ roomId } = {}) => {
  if (typeof roomId !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(roomId)) return;
  socket.join(roomId);
 });
 socket.on("ptt:request", ({ roomId } = {}) => {
  if (typeof roomId !== "string" || !socket.rooms.has(roomId)) return;
  if (!roomHolders.has(roomId)) {
   roomHolders.set(roomId, socket.id);
   io.to(roomId).emit("ptt:granted", { memberName: socket.member.full_name });
  } else socket.emit("ptt:busy");
 });
 socket.on("ptt:release", ({ roomId } = {}) => {
  if (roomHolders.get(roomId) === socket.id) {
   roomHolders.delete(roomId);
   io.to(roomId).emit("ptt:released");
  }
 });
 socket.on("disconnect", () => {
  for (const [roomId, holder] of roomHolders.entries()) {
   if (holder === socket.id) {
    roomHolders.delete(roomId);
    io.to(roomId).emit("ptt:released");
   }
  }
 });
});
server.listen(port, "0.0.0.0", () => console.log(`Hamyar Heyat listening on :${port}`));
