require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
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

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "hamyar-heyat" }));

// Initial authentication endpoint. Member provisioning/admin workflows are intentionally
// not exposed publicly until an authenticated admin flow is implemented.
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
  // TODO: issue a signed, expiring session token after SESSION_SECRET and session policy are configured.
  return res.status(501).json({ error: "احراز هویت ثبت شد؛ صدور نشست امن در مرحلهٔ بعد تکمیل می‌شود." });
});

const rooms = new Map();
io.on("connection", socket => {
  socket.on("room:join", ({ roomId } = {}) => {
    if (typeof roomId !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(roomId)) return;
    socket.join(roomId);
  });
  // PTT floor-control placeholder: actual WebRTC media transport/SFU is a later milestone.
  socket.on("ptt:request", ({ roomId } = {}) => {
    if (typeof roomId !== "string") return;
    const holder = rooms.get(roomId);
    if (!holder) {
      rooms.set(roomId, socket.id);
      io.to(roomId).emit("ptt:granted", { socketId: socket.id });
    } else {
      socket.emit("ptt:busy");
    }
  });
  socket.on("ptt:release", ({ roomId } = {}) => {
    if (rooms.get(roomId) === socket.id) {
      rooms.delete(roomId);
      io.to(roomId).emit("ptt:released", { socketId: socket.id });
    }
  });
  socket.on("disconnect", () => {
    for (const [roomId, holder] of rooms.entries()) {
      if (holder === socket.id) {
        rooms.delete(roomId);
        io.to(roomId).emit("ptt:released", { socketId: socket.id });
      }
    }
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Hamyar Heyat listening on :${port}`);
});
