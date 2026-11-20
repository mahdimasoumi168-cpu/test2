import { DurableObject } from "cloudflare:workers";

const SESSION_SECONDS = 12 * 60 * 60;
const PBKDF2_ITERATIONS = 210000;
const MAX_TALK_MS = 30000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function unb64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function deriveCodeHash(code, salt, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function hashCode(code) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveCodeHash(code, salt);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

async function verifyCode(code, encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith("pbkdf2$")) return false;
  const parts = encoded.split("$");
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 600000) return false;
  try {
    const salt = unb64url(parts[2]);
    const expected = unb64url(parts[3]);
    const actual = await deriveCodeHash(code, salt, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function signToken(payload, secret) {
  const encoded = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));
  return encoded + "." + b64url(new Uint8Array(signature));
}

async function verifyToken(token, secret) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const valid = await crypto.subtle.verify("HMAC", key, unb64url(parts[1]), new TextEncoder().encode(parts[0]));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    if (!payload.sub || !Number.isInteger(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

async function authenticate(request, env) {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : getCookie(request, "hy_session");
  const payload = await verifyToken(token, env.SESSION_SECRET);
  if (!payload) return null;
  const user = await env.DB.prepare(
    "SELECT id, display_name, role, is_active, session_version FROM users WHERE id = ?"
  ).bind(payload.sub).first();
  if (!user || !user.is_active || user.session_version !== payload.sv) return null;
  return { id: user.id, name: user.display_name, role: user.role };
}

async function issueSession(user, env) {
  const token = await signToken({
    sub: user.id,
    sv: user.session_version || 0,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  }, env.SESSION_SECRET);
  return token;
}

async function createMember(env, input, role = "member") {
  const fullName = typeof input.fullName === "string" ? input.fullName.trim().normalize("NFC") : "";
  const guardianCode = typeof input.guardianCode === "string" ? input.guardianCode.trim() : "";
  const personCode = typeof input.personCode === "string" ? input.personCode.trim() : "";
  if (!fullName || fullName.length > 100 || guardianCode.length < 4 || guardianCode.length > 64 ||
      personCode.length < 4 || personCode.length > 64) {
    throw new Error("نام و هر دو کد باید معتبر باشند؛ طول هر کد حداقل ۴ نویسه است.");
  }
  const id = crypto.randomUUID();
  const guardianHash = await hashCode(guardianCode);
  const personHash = await hashCode(personCode);
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, login_code_hash, guardian_code_hash, person_code_hash, role, is_active, session_version) VALUES (?, ?, ?, ?, ?, ?, 1, 0)"
  ).bind(id, fullName, "pbkdf2-migrated", guardianHash, personHash, role).run();
  return { id, name: fullName, role };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health" && request.method === "GET") {
    return json({ ok: true, service: "hamyar-heyat-cloudflare", voice: "not-connected-yet" });
  }

  if (!sameOrigin(request)) return json({ error: "درخواست از مبدأ مجاز نیست." }, 403);

  if (path === "/api/admin/bootstrap" && request.method === "POST") {
    if (!env.BOOTSTRAP_ADMIN_KEY || !env.SESSION_SECRET) return json({ error: "راه‌اندازی اولیه پیکربندی نشده است." }, 503);
    const supplied = request.headers.get("x-bootstrap-key") || "";
    if (!constantTimeEqual(new TextEncoder().encode(supplied), new TextEncoder().encode(env.BOOTSTRAP_ADMIN_KEY))) {
      return json({ error: "کلید راه‌اندازی معتبر نیست." }, 403);
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first();
    if (Number(count?.total || 0) !== 0) return json({ error: "مدیر اولیه قبلاً ایجاد شده است." }, 409);
    try {
      const admin = await createMember(env, await request.json(), "admin");
      const rooms = await env.DB.prepare("SELECT id FROM rooms WHERE is_active = 1").all();
      for (const room of rooms.results || []) {
        await env.DB.prepare("INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)").bind(room.id, admin.id).run();
      }
      const user = { id: admin.id, display_name: admin.name, role: "admin", session_version: 0 };
      const token = await issueSession(user, env);
      return json({ ok: true, member: admin, token }, 201, {
        "set-cookie": `hy_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`
      });
    } catch (error) {
      return json({ error: error.message || "ایجاد مدیر انجام نشد." }, 400);
    }
  }

  if (path === "/api/login" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "درخواست ورود معتبر نیست." }, 400); }
    const fullName = typeof body.fullName === "string" ? body.fullName.trim().normalize("NFC") : "";
    const guardianCode = typeof body.guardianCode === "string" ? body.guardianCode.trim() : "";
    const personCode = typeof body.personCode === "string" ? body.personCode.trim() : "";
    if (!fullName || !guardianCode || !personCode || fullName.length > 100 || guardianCode.length > 64 || personCode.length > 64) {
      return json({ error: "همه اطلاعات ورود را کامل وارد کنید." }, 400);
    }
    const result = await env.DB.prepare(
      "SELECT id, display_name, role, session_version, guardian_code_hash, person_code_hash FROM users WHERE display_name = ? AND is_active = 1 LIMIT 20"
    ).bind(fullName).all();
    let user = null;
    for (const candidate of result.results || []) {
      const guardianOk = await verifyCode(guardianCode, candidate.guardian_code_hash);
      const personOk = await verifyCode(personCode, candidate.person_code_hash);
      if (guardianOk && personOk) { user = candidate; break; }
    }
    if (!user) return json({ error: "اطلاعات ورود صحیح نیست یا عضویت فعال نیست." }, 401);
    const token = await issueSession(user, env);
    return json({ ok: true, token, member: { id: user.id, name: user.display_name, role: user.role } }, 200, {
      "set-cookie": `hy_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`
    });
  }

  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": "hy_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
  }

  const user = await authenticate(request, env);
  if (!user) return json({ error: "نشست معتبر نیست؛ دوباره وارد شوید." }, 401);

  if (path === "/api/me" && request.method === "GET") return json({ member: user });

  if (path === "/api/rooms" && request.method === "GET") {
    const rooms = user.role === "admin" || user.role === "moderator"
      ? await env.DB.prepare("SELECT id, name, max_members FROM rooms WHERE is_active = 1 ORDER BY name").all()
      : await env.DB.prepare(
          "SELECT r.id, r.name, r.max_members FROM rooms r JOIN room_members rm ON rm.room_id = r.id WHERE rm.user_id = ? AND r.is_active = 1 ORDER BY r.name"
        ).bind(user.id).all();
    return json({ rooms: rooms.results || [] });
  }

  const memberMatch = path.match(/^\/api\/admin\/members$/);
  if (memberMatch && request.method === "POST") {
    if (user.role !== "admin") return json({ error: "دسترسی مدیر لازم است." }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: "اطلاعات عضو معتبر نیست." }, 400); }
    const role = ["member", "moderator"].includes(body.role) ? body.role : "member";
    try {
      const member = await createMember(env, body, role);
      const roomIds = Array.isArray(body.roomIds) ? [...new Set(body.roomIds)].slice(0, 20) : [];
      for (const roomId of roomIds) {
        const room = await env.DB.prepare("SELECT id FROM rooms WHERE id = ? AND is_active = 1").bind(roomId).first();
        if (!room) continue;
        await env.DB.prepare("INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)").bind(roomId, member.id).run();
      }
      return json({ ok: true, member }, 201);
    } catch (error) {
      return json({ error: error.message || "ایجاد عضو انجام نشد." }, 400);
    }
  }

  const socketMatch = path.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)\/socket$/);
  if (socketMatch && request.method === "GET") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "ارتباط WebSocket لازم است." }, 426);
    }
    const roomId = socketMatch[1];
    const room = await env.DB.prepare("SELECT id, max_members FROM rooms WHERE id = ? AND is_active = 1").bind(roomId).first();
    if (!room) return json({ error: "اتاق فعال نیست." }, 404);
    if (user.role !== "admin" && user.role !== "moderator") {
      const membership = await env.DB.prepare("SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?").bind(roomId, user.id).first();
      if (!membership) return json({ error: "شما به این اتاق دسترسی ندارید." }, 403);
    }
    const stub = env.ROOM_HUB.getByName(roomId);
    const headers = new Headers(request.headers);
    headers.set("x-hy-user-id", user.id);
    headers.set("x-hy-user-name", user.name);
    headers.set("x-hy-user-role", user.role);
    headers.set("x-hy-room-capacity", String(Math.min(100, Math.max(1, room.max_members || 100))));
    return stub.fetch(new Request(request, { headers }));
  }

  return json({ error: "مسیر پیدا نشد." }, 404);
}

export class RoomHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS speaker (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    const userId = request.headers.get("x-hy-user-id");
    const displayName = request.headers.get("x-hy-user-name");
    const role = request.headers.get("x-hy-user-role");
    const capacity = Math.min(100, Math.max(1, Number(request.headers.get("x-hy-room-capacity") || 100)));
    if (!userId || !displayName || !role) return new Response("Unauthorized", { status: 401 });
    if (this.ctx.getWebSockets().length >= capacity) return new Response("Room is full", { status: 429 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ userId, displayName, role, lastRequestAt: 0 });
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "room:ready", capacity, connected: this.ctx.getWebSockets().length }));
    this.broadcast({ type: "room:presence", connected: this.ctx.getWebSockets().length }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(payload, except = null) {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except && socket.readyState === WebSocket.OPEN) {
        try { socket.send(message); } catch {}
      }
    }
  }

  async webSocketMessage(socket, raw) {
    if (typeof raw !== "string" || raw.length > 1024) {
      socket.close(1009, "Message too large");
      return;
    }
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    const attachment = socket.deserializeAttachment();
    if (!attachment || !["ptt:request", "ptt:release"].includes(message.type)) return;

    if (message.type === "ptt:request") {
      const now = Date.now();
      if (now - (attachment.lastRequestAt || 0) < 500) return;
      attachment.lastRequestAt = now;
      socket.serializeAttachment(attachment);

      const current = this.ctx.storage.sql.exec(
        "SELECT user_id, display_name, expires_at FROM speaker WHERE id = 1"
      ).toArray()[0];
      if (current && current.expires_at > now && current.user_id !== attachment.userId) {
        socket.send(JSON.stringify({ type: "ptt:busy", memberName: current.display_name }));
        return;
      }
      if (current && current.expires_at <= now) {
        this.ctx.storage.sql.exec("DELETE FROM speaker WHERE id = 1");
        this.broadcast({ type: "ptt:released" });
      }
      const expiresAt = now + MAX_TALK_MS;
      this.ctx.storage.sql.exec(
        "INSERT INTO speaker (id, user_id, display_name, expires_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, display_name=excluded.display_name, expires_at=excluded.expires_at",
        attachment.userId, attachment.displayName, expiresAt
      );
      await this.ctx.storage.setAlarm(expiresAt);
      this.broadcast({ type: "ptt:granted", memberId: attachment.userId, memberName: attachment.displayName, maxTalkSeconds: MAX_TALK_MS / 1000 });
      return;
    }

    if (message.type === "ptt:release") {
      await this.releaseSpeaker(attachment.userId);
    }
  }

  async releaseSpeaker(userId) {
    const current = this.ctx.storage.sql.exec(
      "SELECT user_id FROM speaker WHERE id = 1"
    ).toArray()[0];
    if (!current || current.user_id !== userId) return;
    this.ctx.storage.sql.exec("DELETE FROM speaker WHERE id = 1");
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ type: "ptt:released" });
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.userId) await this.releaseSpeaker(attachment.userId);
    this.broadcast({ type: "room:presence", connected: Math.max(0, this.ctx.getWebSockets().length - 1) });
  }

  async webSocketError(socket) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.userId) await this.releaseSpeaker(attachment.userId);
  }

  async alarm() {
    const current = this.ctx.storage.sql.exec(
      "SELECT user_id, expires_at FROM speaker WHERE id = 1"
    ).toArray()[0];
    if (!current) return;
    if (current.expires_at > Date.now()) {
      await this.ctx.storage.setAlarm(current.expires_at);
      return;
    }
    this.ctx.storage.sql.exec("DELETE FROM speaker WHERE id = 1");
    this.broadcast({ type: "ptt:released", reason: "timeout" });
  }
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB || !env.ROOM_HUB || !env.SESSION_SECRET) {
        return json({ error: "زیرساخت Worker کامل پیکربندی نشده است." }, 503);
      }
      const response = await handleApi(request, env);
      if (response) return response;
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: error?.message || "unknown" }));
      return json({ error: "خطای داخلی سامانه رخ داد." }, 500);
    }
  }
};
