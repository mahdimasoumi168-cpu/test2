import { DurableObject } from "cloudflare:workers";

const SESSION_SECONDS = 12 * 60 * 60;
const PTT_LEASE_MS = 20000;
const PTT_HEARTBEAT_MIN_INTERVAL_MS = 2000;
const MAX_ROOM_MEMBERS = 100;
const encoder = new TextEncoder();

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
async function hashCode(code, pepper) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const material = new Uint8Array(salt.length + encoder.encode(code).length);
  material.set(salt, 0);
  material.set(encoder.encode(code), salt.length);
  const signature = await crypto.subtle.sign("HMAC", key, material);
  return "hmac-sha256$" + b64url(salt) + "$" + b64url(new Uint8Array(signature));
}
async function verifyCode(code, encoded, pepper) {
  if (typeof encoded !== "string" || !encoded.startsWith("hmac-sha256$") || !pepper) return false;
  const parts = encoded.split("$");
  if (parts.length !== 3) return false;
  try {
    const salt = unb64url(parts[1]);
    const key = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const value = encoder.encode(code);
    const material = new Uint8Array(salt.length + value.length);
    material.set(salt, 0);
    material.set(value, salt.length);
    const actual = new Uint8Array(await crypto.subtle.sign("HMAC", key, material));
    return constantTimeEqual(actual, unb64url(parts[2]));
  } catch { return false; }
}
async function signToken(payload, secret) {
  const encoded = b64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encoded));
  return encoded + "." + b64url(new Uint8Array(signature));
}
async function verifyToken(token, secret) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, unb64url(parts[1]), encoder.encode(parts[0]))) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    if (!payload.sub || !Number.isInteger(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
function parseBearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}
async function authenticate(request, env, suppliedToken = "") {
  const token = suppliedToken || parseBearer(request);
  const payload = await verifyToken(token, env.SESSION_SECRET);
  if (!payload) return null;
  const user = await env.DB.prepare(
    "SELECT id, display_name, role, is_active, session_version FROM users WHERE id = ?"
  ).bind(payload.sub).first();
  if (!user || user.is_active !== 1 || user.session_version !== payload.ver) return null;
  return { id: user.id, name: user.display_name, role: user.role };
}
async function issueSession(user, env) {
  return signToken({
    sub: user.id,
    ver: user.session_version || 0,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  }, env.SESSION_SECRET);
}
async function audit(env, userId, eventType, targetId = null, details = {}) {
  await env.DB.prepare(
    "INSERT INTO security_events (user_id, event_type, details_json) VALUES (?, ?, ?)"
  ).bind(userId || null, eventType, JSON.stringify({ targetId, ...details })).run();
}
function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin || origin === new URL(request.url).origin) return true;
  const allowed = (env.ALLOWED_ORIGINS || "capacitor://localhost,http://localhost")
    .split(",").map(value => value.trim()).filter(Boolean);
  return allowed.includes(origin);
}
function corsResponse(request, env, response) {
  const origin = request.headers.get("origin");
  if (!origin || origin === new URL(request.url).origin) return response;
  const allowed = (env.ALLOWED_ORIGINS || "capacitor://localhost,http://localhost")
    .split(",").map(value => value.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "Authorization, Content-Type, Sec-WebSocket-Protocol");
  headers.set("access-control-max-age", "86400");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function validRoomId(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,80}$/.test(value);
}
async function requireRoom(env, user, roomId) {
  const room = await env.DB.prepare("SELECT id, name, is_active, max_members FROM rooms WHERE id = ? AND is_active = 1").bind(roomId).first();
  if (!room) return null;
  if (user.role !== "admin") {
    const member = await env.DB.prepare("SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?").bind(roomId, user.id).first();
    if (!member) return null;
  }
  return room;
}
async function createMember(env, body, role = "member") {
  const fullName = typeof body.fullName === "string" ? body.fullName.trim().normalize("NFC") : "";
  const guardianCode = typeof body.guardianCode === "string" ? body.guardianCode.trim() : "";
  const personCode = typeof body.personCode === "string" ? body.personCode.trim() : "";
  if (!fullName || fullName.length > 120 || guardianCode.length < 4 || guardianCode.length > 120 ||
      personCode.length < 4 || personCode.length > 120) {
    throw new Error("نام و هر دو کد باید معتبر باشند؛ طول هر کد حداقل ۴ نویسه است.");
  }
  if (!["admin", "member"].includes(role)) throw new Error("نقش انتخاب‌شده معتبر نیست.");
  const id = crypto.randomUUID();
  const guardianHash = await hashCode(guardianCode, env.CODE_PEPPER);
  const personHash = await hashCode(personCode, env.CODE_PEPPER);
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, login_code_hash, guardian_code_hash, person_code_hash, role, is_active, session_version) VALUES (?, ?, ?, ?, ?, ?, 1, 0)"
  ).bind(id, fullName, guardianHash, guardianHash, personHash, role).run();
  const rooms = await env.DB.prepare("SELECT id FROM rooms WHERE is_active = 1").all();
  for (const room of rooms.results || []) {
    if (role === "admin" || room.id !== "management") {
      await env.DB.prepare("INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)").bind(room.id, id).run();
    }
  }
  return { id, name: fullName, role };
}
function sfuConfigured(env) {
  return Boolean(env.SFU_APP_ID && env.SFU_APP_SECRET);
}
async function sfuRequest(env, path, method = "POST", body = undefined) {
  if (!sfuConfigured(env)) throw new Error("Cloudflare Realtime SFU در این محیط پیکربندی نشده است.");
  const response = await fetch("https://rtc.live.cloudflare.com/v1/apps/" + env.SFU_APP_ID + path, {
    method,
    headers: { authorization: "Bearer " + env.SFU_APP_SECRET, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.errorCode || data.errorDescription) {
    throw new Error(data.errorDescription || "درخواست ارتباط صوتی ناموفق بود (HTTP " + response.status + ").");
  }
  return data;
}
async function closeSfuSession(env, sessionId, knownMid = null) {
  if (!sessionId || !sfuConfigured(env)) return;
  let mids = knownMid ? [knownMid] : [];
  try {
    if (!mids.length) {
      const info = await sfuRequest(env, "/sessions/" + encodeURIComponent(sessionId), "GET");
      mids = (info.tracks || []).filter(track => track.status !== "inactive" && track.mid).map(track => track.mid);
    }
    if (mids.length) {
      await sfuRequest(env, "/sessions/" + encodeURIComponent(sessionId) + "/tracks/close", "PUT", {
        tracks: mids.map(mid => ({ mid })),
        force: true
      });
    }
  } catch (error) {
    console.warn("SFU cleanup:", error.message);
  }
  await env.DB.prepare("UPDATE sfu_sessions SET status = 'closed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(sessionId).run();
}
async function handleSfu(request, env, user, url) {
  const path = url.pathname;
  if (path === "/api/sfu/sessions" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "درخواست نشست صوتی معتبر نیست." }, 400); }
    const roomId = body.roomId;
    const type = body.type;
    if (!validRoomId(roomId) || !["publisher", "subscriber"].includes(type)) return json({ error: "اتاق یا نوع نشست معتبر نیست." }, 400);
    const room = await requireRoom(env, user, roomId);
    if (!room) return json({ error: "دسترسی به این اتاق مجاز نیست." }, 403);
    const hub = env.ROOM_HUB.getByName(roomId);
    const speaker = await hub.getSpeaker();
    if (type === "publisher" && (!speaker || speaker.userId !== user.id)) return json({ error: "برای انتشار صدا باید نوبت صحبت در اختیار شما باشد." }, 403);
    if (type === "subscriber" && (!speaker || !speaker.sessionId)) return json({ error: "در حال حاضر گوینده فعالی وجود ندارد." }, 409);
    try {
      const created = await sfuRequest(env, "/sessions/new", "POST");
      if (!created.sessionId) throw new Error("شناسه نشست از SFU دریافت نشد.");
      await env.DB.prepare(
        "INSERT INTO sfu_sessions (id, user_id, room_id, session_type, status) VALUES (?, ?, ?, ?, 'created')"
      ).bind(created.sessionId, user.id, roomId, type).run();
      return json({ sessionId: created.sessionId, roomId, type }, 201);
    } catch (error) {
      return json({ error: error.message }, 502);
    }
  }

  const publishMatch = path.match(/^\/api\/sfu\/sessions\/([^/]+)\/publish$/);
  if (publishMatch && request.method === "POST") {
    const sessionId = decodeURIComponent(publishMatch[1]);
    const session = await env.DB.prepare("SELECT * FROM sfu_sessions WHERE id = ? AND user_id = ? AND session_type = 'publisher' AND status = 'created'")
      .bind(sessionId, user.id).first();
    if (!session) return json({ error: "نشست انتشار معتبر نیست." }, 404);
    const hub = env.ROOM_HUB.getByName(session.room_id);
    const speaker = await hub.getSpeaker();
    if (!speaker || speaker.userId !== user.id) return json({ error: "مجوز صحبت منقضی شده است." }, 409);
    let body;
    try { body = await request.json(); } catch { return json({ error: "توضیحات اتصال معتبر نیست." }, 400); }
    if (!body.sessionDescription || body.sessionDescription.type !== "offer" ||
        typeof body.sessionDescription.sdp !== "string" || body.sessionDescription.sdp.length > 50000 ||
        typeof body.mid !== "string" || body.mid.length > 12) {
      return json({ error: "پیشنهاد WebRTC یا شناسه ترک معتبر نیست." }, 400);
    }
    try {
      const result = await sfuRequest(env, "/sessions/" + encodeURIComponent(sessionId) + "/tracks/new", "POST", {
        sessionDescription: body.sessionDescription,
        tracks: [{ location: "local", mid: body.mid, trackName: "voice" }]
      });
      if (result.tracks?.some(track => track.errorCode || track.errorDescription)) throw new Error("SFU ترک صوتی را نپذیرفت.");
      await env.DB.prepare("UPDATE sfu_sessions SET status = 'published', mid = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(body.mid, sessionId).run();
      const announced = await hub.announcePublisher(user.id, sessionId);
      if (!announced) {
        await closeSfuSession(env, sessionId, body.mid);
        return json({ error: "نوبت صحبت در حین اتصال منقضی شد." }, 409);
      }
      return json(result);
    } catch (error) {
      await closeSfuSession(env, sessionId, body.mid);
      return json({ error: error.message }, 502);
    }
  }

  const subscribeMatch = path.match(/^\/api\/sfu\/sessions\/([^/]+)\/subscribe$/);
  if (subscribeMatch && request.method === "POST") {
    const sessionId = decodeURIComponent(subscribeMatch[1]);
    const session = await env.DB.prepare("SELECT * FROM sfu_sessions WHERE id = ? AND user_id = ? AND session_type = 'subscriber' AND status = 'created'")
      .bind(sessionId, user.id).first();
    if (!session) return json({ error: "نشست دریافت معتبر نیست." }, 404);
    let body;
    try { body = await request.json(); } catch { return json({ error: "شناسه انتشار معتبر نیست." }, 400); }
    const publisherId = typeof body.publisherSessionId === "string" ? body.publisherSessionId : "";
    const publisher = await env.DB.prepare(
      "SELECT id, room_id, status FROM sfu_sessions WHERE id = ? AND session_type = 'publisher' AND status = 'published'"
    ).bind(publisherId).first();
    if (!publisher || publisher.room_id !== session.room_id) return json({ error: "انتشار صوت در این اتاق فعال نیست." }, 404);
    const hub = env.ROOM_HUB.getByName(session.room_id);
    const speaker = await hub.getSpeaker();
    if (!speaker || speaker.sessionId !== publisherId) return json({ error: "گوینده دیگر فعال نیست." }, 409);
    try {
      const result = await sfuRequest(env, "/sessions/" + encodeURIComponent(sessionId) + "/tracks/new", "POST", {
        tracks: [{ location: "remote", sessionId: publisherId, trackName: "voice" }]
      });
      if (result.tracks?.some(track => track.errorCode || track.errorDescription)) throw new Error("اشتراک صوتی توسط SFU پذیرفته نشد.");
      const mid = result.tracks?.find(track => track.mid)?.mid || null;
      await env.DB.prepare("UPDATE sfu_sessions SET status = 'subscribed', mid = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(mid, sessionId).run();
      return json(result);
    } catch (error) {
      await closeSfuSession(env, sessionId);
      return json({ error: error.message }, 502);
    }
  }

  const renegotiateMatch = path.match(/^\/api\/sfu\/sessions\/([^/]+)\/renegotiate$/);
  if (renegotiateMatch && request.method === "PUT") {
    const sessionId = decodeURIComponent(renegotiateMatch[1]);
    const session = await env.DB.prepare("SELECT id FROM sfu_sessions WHERE id = ? AND user_id = ? AND status = 'subscribed'")
      .bind(sessionId, user.id).first();
    if (!session) return json({ error: "نشست مذاکره پیدا نشد." }, 404);
    let body;
    try { body = await request.json(); } catch { return json({ error: "پاسخ WebRTC معتبر نیست." }, 400); }
    if (!body.sessionDescription || body.sessionDescription.type !== "answer" ||
        typeof body.sessionDescription.sdp !== "string" || body.sessionDescription.sdp.length > 50000) {
      return json({ error: "پاسخ WebRTC معتبر نیست." }, 400);
    }
    try {
      return json(await sfuRequest(env, "/sessions/" + encodeURIComponent(sessionId) + "/renegotiate", "PUT", {
        sessionDescription: body.sessionDescription
      }));
    } catch (error) { return json({ error: error.message }, 502); }
  }

  const closeMatch = path.match(/^\/api\/sfu\/sessions\/([^/]+)$/);
  if (closeMatch && request.method === "DELETE") {
    const sessionId = decodeURIComponent(closeMatch[1]);
    const session = await env.DB.prepare("SELECT id, mid FROM sfu_sessions WHERE id = ? AND (user_id = ? OR ? = 'admin')")
      .bind(sessionId, user.id, user.role).first();
    if (!session) return json({ error: "نشست صوتی پیدا نشد." }, 404);
    await closeSfuSession(env, sessionId, session.mid);
    return json({ ok: true });
  }
  return null;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) return null;
  if (!allowedOrigin(request, env)) return json({ error: "مبدأ درخواست معتبر نیست." }, 403);

  if (path === "/api/health" && request.method === "GET") {
    return json({ ok: true, service: "hamyar-heyat-cloudflare", voice: sfuConfigured(env) ? "configured" : "not-configured" });
  }

  if (path === "/api/login" && request.method === "POST") {
    if (!env.SESSION_SECRET || !env.CODE_PEPPER) return json({ error: "کلیدهای امنیتی سرور تنظیم نشده‌اند." }, 503);
    let body;
    try { body = await request.json(); } catch { return json({ error: "درخواست ورود معتبر نیست." }, 400); }
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const ipHash = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(ip))));
    const loginAllowed = await env.GLOBAL_PRESENCE.getByName("global").allowLogin(ipHash);
    if (!loginAllowed) return json({ error: "تعداد تلاش‌های ورود زیاد است؛ ۱۵ دقیقه دیگر دوباره امتحان کنید." }, 429);
    const fullName = typeof body.fullName === "string" ? body.fullName.trim().normalize("NFC") : "";
    const guardianCode = typeof body.guardianCode === "string" ? body.guardianCode.trim() : "";
    const personCode = typeof body.personCode === "string" ? body.personCode.trim() : "";
    if (!fullName || !guardianCode || !personCode || fullName.length > 120 || guardianCode.length > 120 || personCode.length > 120) {
      return json({ error: "همه اطلاعات ورود را کامل وارد کنید." }, 400);
    }
    const candidates = await env.DB.prepare(
      "SELECT id, display_name, role, session_version, guardian_code_hash, person_code_hash FROM users WHERE display_name = ? AND is_active = 1 LIMIT 10"
    ).bind(fullName).all();
    let user = null;
    for (const candidate of candidates.results || []) {
      const guardianOk = await verifyCode(guardianCode, candidate.guardian_code_hash, env.CODE_PEPPER);
      const personOk = await verifyCode(personCode, candidate.person_code_hash, env.CODE_PEPPER);
      if (guardianOk && personOk) { user = candidate; break; }
    }
    if (!user) {
      await audit(env, null, "login.failed", null, { nameHash: b64url(await crypto.subtle.digest("SHA-256", encoder.encode(fullName))) });
      return json({ error: "اطلاعات ورود صحیح نیست یا عضویت فعال نیست." }, 401);
    }
    const token = await issueSession(user, env);
    await audit(env, user.id, "login.succeeded");
    return json({ token, member: { id: user.id, name: user.display_name, role: user.role } });
  }

  if (path === "/api/admin/bootstrap" && request.method === "POST") {
    if (!env.BOOTSTRAP_ADMIN_KEY || !env.SESSION_SECRET || !env.CODE_PEPPER) return json({ error: "راه‌اندازی اولیه پیکربندی نشده است." }, 503);
    const supplied = request.headers.get("x-bootstrap-key") || "";
    if (!constantTimeEqual(encoder.encode(supplied), encoder.encode(env.BOOTSTRAP_ADMIN_KEY))) return json({ error: "کلید راه‌اندازی معتبر نیست." }, 403);
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first();
    if (Number(count?.total || 0) !== 0) return json({ error: "مدیر اولیه قبلاً ایجاد شده است." }, 409);
    let body;
    try { body = await request.json(); } catch { return json({ error: "اطلاعات مدیر معتبر نیست." }, 400); }
    try {
      const admin = await createMember(env, body, "admin");
      const user = { id: admin.id, display_name: admin.name, role: "admin", session_version: 0 };
      const token = await issueSession(user, env);
      await audit(env, admin.id, "admin.bootstrap");
      return json({ ok: true, token, member: admin }, 201);
    } catch (error) { return json({ error: error.message }, 400); }
  }

  if (path === "/api/logout" && request.method === "POST") return json({ ok: true });

  const user = await authenticate(request, env);
  if (!user) return json({ error: "نشست معتبر نیست؛ دوباره وارد شوید." }, 401);

  if (path === "/api/me" && request.method === "GET") return json({ member: user });

  if (path === "/api/rooms" && request.method === "GET") {
    const rooms = user.role === "admin"
      ? await env.DB.prepare("SELECT id, name, max_members FROM rooms WHERE is_active = 1 ORDER BY CASE WHEN id = 'management' THEN 0 ELSE 1 END, name").all()
      : await env.DB.prepare("SELECT r.id, r.name, r.max_members FROM rooms r JOIN room_members rm ON rm.room_id = r.id WHERE rm.user_id = ? AND r.is_active = 1 AND r.id <> 'management' ORDER BY r.name")
        .bind(user.id).all();
    return json({ rooms: rooms.results || [] });
  }

  if (path.startsWith("/api/sfu/")) return (await handleSfu(request, env, user, url)) || json({ error: "مسیر صوتی پیدا نشد." }, 404);

  if (path === "/api/admin/members" && request.method === "GET") {
    if (user.role !== "admin") return json({ error: "دسترسی مدیر لازم است." }, 403);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
    const pattern = "%" + q + "%";
    const list = q
      ? await env.DB.prepare("SELECT id, display_name AS full_name, role, is_active AS active, created_at FROM users WHERE display_name LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(pattern, limit, offset).all()
      : await env.DB.prepare("SELECT id, display_name AS full_name, role, is_active AS active, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(limit, offset).all();
    const total = q
      ? await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE display_name LIKE ?").bind(pattern).first()
      : await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    const members = (list.results || []).map(m => ({ ...m, active: Number(m.active) === 1 }));
    return json({ members, total: Number(total?.n || 0), nextOffset: offset + members.length < Number(total?.n || 0) ? offset + members.length : null });
  }

  if (path === "/api/admin/members" && request.method === "POST") {
    if (user.role !== "admin") return json({ error: "دسترسی مدیر لازم است." }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: "اطلاعات عضو معتبر نیست." }, 400); }
    try {
      const member = await createMember(env, body, body.role || "member");
      await audit(env, user.id, "member.created", member.id, { role: member.role });
      return json({ ok: true, id: member.id }, 201);
    } catch (error) { return json({ error: error.message }, 400); }
  }

  const memberPatch = path.match(/^\/api\/admin\/members\/([^/]+)$/);
  if (memberPatch && request.method === "PATCH") {
    if (user.role !== "admin") return json({ error: "دسترسی مدیر لازم است." }, 403);
    const id = decodeURIComponent(memberPatch[1]);
    const target = await env.DB.prepare("SELECT id, role, is_active FROM users WHERE id = ?").bind(id).first();
    if (!target) return json({ error: "عضو پیدا نشد." }, 404);
    let body;
    try { body = await request.json(); } catch { return json({ error: "اطلاعات ویرایش معتبر نیست." }, 400); }
    const fields = [], values = [];
    if (body.fullName !== undefined) {
      if (typeof body.fullName !== "string" || !body.fullName.trim() || body.fullName.length > 120) return json({ error: "نام عضو معتبر نیست." }, 400);
      fields.push("display_name = ?"); values.push(body.fullName.trim().normalize("NFC"));
    }
    if (body.role !== undefined) {
      if (!["member", "admin"].includes(body.role)) return json({ error: "نقش انتخاب‌شده معتبر نیست." }, 400);
      if (target.role === "admin" && target.is_active === 1 && body.role === "member") {
        const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").first();
        if (Number(admins?.n || 0) <= 1) return json({ error: "تغییر نقش آخرین مدیر فعال مجاز نیست." }, 409);
      }
      fields.push("role = ?"); values.push(body.role);
    }
    if (body.guardianCode !== undefined) {
      if (typeof body.guardianCode !== "string" || body.guardianCode.trim().length < 4 || body.guardianCode.length > 120) return json({ error: "کد سرپرستی معتبر نیست." }, 400);
      const hash = await hashCode(body.guardianCode.trim(), env.CODE_PEPPER); fields.push("guardian_code_hash = ?"); values.push(hash);
    }
    if (body.personCode !== undefined) {
      if (typeof body.personCode !== "string" || body.personCode.trim().length < 4 || body.personCode.length > 120) return json({ error: "کد شخص معتبر نیست." }, 400);
      const hash = await hashCode(body.personCode.trim(), env.CODE_PEPPER); fields.push("person_code_hash = ?"); values.push(hash);
    }
    if (!fields.length) return json({ error: "حداقل یک مورد برای ویرایش لازم است." }, 400);
    fields.push("session_version = session_version + 1", "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    values.push(id);
    await env.DB.prepare("UPDATE users SET " + fields.join(", ") + " WHERE id = ?").bind(...values).run();
    if (body.role === "member") await env.DB.prepare("DELETE FROM room_members WHERE room_id = 'management' AND user_id = ?").bind(id).run();
    if (body.role === "admin") await env.DB.prepare("INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES ('management', ?)").bind(id).run();
    await audit(env, user.id, "member.updated", id, { fields: fields.map(x => x.split(" ")[0]) });
    const memberships = await env.DB.prepare("SELECT room_id FROM room_members WHERE user_id = ?").bind(id).all();
    for (const item of memberships.results || []) await env.ROOM_HUB.getByName(item.room_id).revokeUser(id);
    return json({ ok: true });
  }

  const memberActive = path.match(/^\/api\/admin\/members\/([^/]+)\/active$/);
  if (memberActive && request.method === "PATCH") {
    if (user.role !== "admin") return json({ error: "دسترسی مدیر لازم است." }, 403);
    const id = decodeURIComponent(memberActive[1]);
    let body;
    try { body = await request.json(); } catch { return json({ error: "وضعیت عضو معتبر نیست." }, 400); }
    if (typeof body.active !== "boolean") return json({ error: "وضعیت عضو معتبر نیست." }, 400);
    if (id === user.id && !body.active) return json({ error: "مدیر نمی‌تواند حساب خودش را غیرفعال کند." }, 400);
    const target = await env.DB.prepare("SELECT id, role, is_active FROM users WHERE id = ?").bind(id).first();
    if (!target) return json({ error: "عضو پیدا نشد." }, 404);
    if (target.role === "admin" && target.is_active === 1 && !body.active) {
      const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").first();
      if (Number(admins?.n || 0) <= 1) return json({ error: "غیرفعال‌کردن آخرین مدیر مجاز نیست." }, 409);
    }
    await env.DB.prepare("UPDATE users SET is_active = ?, session_version = session_version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .bind(body.active ? 1 : 0, id).run();
    await audit(env, user.id, body.active ? "member.activated" : "member.deactivated", id);
    const memberships = await env.DB.prepare("SELECT room_id FROM room_members WHERE user_id = ?").bind(id).all();
    for (const item of memberships.results || []) await env.ROOM_HUB.getByName(item.room_id).revokeUser(id);
    return json({ ok: true });
  }

  if (path === "/api/admin/rooms" && request.method === "GET") {
    if (user.role !== "admin") return json({ error: "دسترسی مدیر لازم است." }, 403);
    const list = await env.DB.prepare("SELECT id, name, is_active AS active, max_members, created_at FROM rooms ORDER BY CASE WHEN id = 'management' THEN 0 ELSE 1 END, name").all();
    const rooms = [];
    for (const room of list.results || []) {
      const connected = await env.ROOM_HUB.getByName(room.id).getPresence();
      rooms.push({ ...room, active: Number(room.active) === 1, connected_members: connected });
    }
    return json({ rooms });
  }

  if (path === "/api/admin/rooms" && request.method === "POST") {
    if (user.role !== "admin") return json({ error: "دسترسی مدیر لازم است." }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: "اطلاعات اتاق معتبر نیست." }, 400); }
    const name = typeof body.name === "string" ? body.name.trim().normalize("NFC") : "";
    const capacity = body.maxMembers === undefined ? 100 : Number(body.maxMembers);
    if (!name || name.length > 60 || !Number.isInteger(capacity) || capacity < 1 || capacity > 100) {
      return json({ error: "نام اتاق یا ظرفیت (۱ تا ۱۰۰ نفر) معتبر نیست." }, 400);
    }
    const id = "room_" + Array.from(crypto.getRandomValues(new Uint8Array(6))).map(x => x.toString(16).padStart(2, "0")).join("");
    try {
      await env.DB.prepare("INSERT INTO rooms (id, name, max_members, created_by) VALUES (?, ?, ?, ?)").bind(id, name, capacity, user.id).run();
      await audit(env, user.id, "room.created", id, { name, maxMembers: capacity });
      return json({ ok: true, room: { id, name, active: 1, max_members: capacity } }, 201);
    } catch (error) {
      if (String(error.message).toLowerCase().includes("unique")) return json({ error: "اتاقی با این نام از قبل وجود دارد." }, 409);
      throw error;
    }
  }

  const roomPatch = path.match(/^\/api\/admin\/rooms\/([a-z0-9_-]+)$/);
  if (roomPatch && request.method === "PATCH") {
    if (user.role !== "admin") return json({ error: "دسترسی مدیر لازم است." }, 403);
    const id = roomPatch[1];
    let body;
    try { body = await request.json(); } catch { return json({ error: "اطلاعات ویرایش معتبر نیست." }, 400); }
    const name = body.name === undefined ? undefined : String(body.name).trim().normalize("NFC");
    const capacity = body.maxMembers === undefined ? undefined : Number(body.maxMembers);
    if (name === undefined && capacity === undefined) return json({ error: "موردی برای ویرایش ارسال نشده است." }, 400);
    if (name !== undefined && (!name || name.length > 60)) return json({ error: "نام اتاق معتبر نیست." }, 400);
    if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1 || capacity > 100)) return json({ error: "ظرفیت باید بین ۱ تا ۱۰۰ باشد." }, 400);
    const existing = await env.DB.prepare("SELECT id, max_members FROM rooms WHERE id = ?").bind(id).first();
    if (!existing) return json({ error: "اتاق پیدا نشد." }, 404);
    const connected = await env.ROOM_HUB.getByName(id).getPresence();
    if (capacity !== undefined && capacity < connected) return json({ error: "ظرفیت جدید از تعداد اعضای متصل کمتر است." }, 409);
    try {
      if (name !== undefined && capacity !== undefined) await env.DB.prepare("UPDATE rooms SET name = ?, max_members = ? WHERE id = ?").bind(name, capacity, id).run();
      else if (name !== undefined) await env.DB.prepare("UPDATE rooms SET name = ? WHERE id = ?").bind(name, id).run();
      else await env.DB.prepare("UPDATE rooms SET max_members = ? WHERE id = ?").bind(capacity, id).run();
    } catch (error) {
      if (String(error.message).toLowerCase().includes("unique")) return json({ error: "نام اتاق تکراری است." }, 409);
      throw error;
    }
    await audit(env, user.id, "room.updated", id, { name, maxMembers: capacity });
    return json({ ok: true });
  }

  const roomActive = path.match(/^\/api\/admin\/rooms\/([a-z0-9_-]+)\/active$/);
  if (roomActive && request.method === "PATCH") {
    if (user.role !== "admin") return json({ error: "دسترسی مدیر لازم است." }, 403);
    const id = roomActive[1];
    let body;
    try { body = await request.json(); } catch { return json({ error: "وضعیت اتاق معتبر نیست." }, 400); }
    if (typeof body.active !== "boolean") return json({ error: "وضعیت اتاق معتبر نیست." }, 400);
    if (id === "management" && !body.active) return json({ error: "اتاق مدیریت قابل غیرفعال‌سازی نیست." }, 400);
    const result = await env.DB.prepare("UPDATE rooms SET is_active = ? WHERE id = ?").bind(body.active ? 1 : 0, id).run();
    if (!result.meta?.changes) return json({ error: "اتاق پیدا نشد." }, 404);
    await audit(env, user.id, body.active ? "room.activated" : "room.deactivated", id);
    if (!body.active) await env.ROOM_HUB.getByName(id).disableRoom();
    return json({ ok: true });
  }

  if (path === "/api/admin/audit" && request.method === "GET") {
    if (user.role !== "admin") return json({ error: "دسترسی مدیر لازم است." }, 403);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const events = await env.DB.prepare("SELECT id, user_id AS actor_id, event_type, json_extract(details_json, '$.targetId') AS target_id, details_json, created_at FROM security_events ORDER BY id DESC LIMIT ?").bind(limit).all();
    return json({ events: events.results || [] });
  }

  const socketMatch = path.match(/^\/api\/rooms\/([a-z0-9_-]+)\/socket$/);
  if (socketMatch && request.method === "GET") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "ارتباط WebSocket لازم است." }, 426);
    const offered = (request.headers.get("sec-websocket-protocol") || "").split(",").map(x => x.trim()).filter(Boolean);
    const authProtocol = offered.find(x => x.startsWith("hy-auth."));
    if (!authProtocol || !offered.includes("hy-room-v1")) return json({ error: "نشست WebSocket معتبر نیست." }, 401);
    const wsUser = await authenticate(request, env, authProtocol.slice("hy-auth.".length));
    if (!wsUser) return json({ error: "نشست معتبر نیست؛ دوباره وارد شوید." }, 401);
    const roomId = socketMatch[1];
    const room = await requireRoom(env, wsUser, roomId);
    if (!room) return json({ error: "دسترسی به این اتاق مجاز نیست." }, 403);
    const headers = new Headers(request.headers);
    headers.set("sec-websocket-protocol", "hy-room-v1");
    headers.set("x-hy-room-id", roomId);
    headers.set("x-hy-user-id", wsUser.id);
    headers.set("x-hy-user-name", wsUser.name);
    headers.set("x-hy-user-role", wsUser.role);
    headers.set("x-hy-room-capacity", String(Math.min(MAX_ROOM_MEMBERS, room.max_members || MAX_ROOM_MEMBERS)));
    return env.ROOM_HUB.getByName(roomId).fetch(new Request(request, { headers }));
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
        session_id TEXT,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  async getSpeaker() {
    const row = this.ctx.storage.sql.exec("SELECT user_id, display_name, session_id, expires_at FROM speaker WHERE id = 1").toArray()[0];
    if (!row || row.expires_at <= Date.now()) return null;
    return { userId: row.user_id, displayName: row.display_name, sessionId: row.session_id, expiresAt: row.expires_at };
  }

  getPresence() {
    return this.ctx.getWebSockets().length;
  }

  async fetch(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    const userId = request.headers.get("x-hy-user-id");
    const displayName = request.headers.get("x-hy-user-name");
    const role = request.headers.get("x-hy-user-role");
    const capacity = Math.min(MAX_ROOM_MEMBERS, Math.max(1, Number(request.headers.get("x-hy-room-capacity") || MAX_ROOM_MEMBERS)));
    const roomId = request.headers.get("x-hy-room-id");
    if (!userId || !displayName || !role || !roomId) return new Response("Unauthorized", { status: 401 });
    if (this.ctx.getWebSockets().length >= capacity) return new Response("Room is full", { status: 429 });
    await this.ctx.storage.put("roomId", roomId);
    const socketKey = crypto.randomUUID();
    const globalPresence = this.env.GLOBAL_PRESENCE.getByName("global");
    const registered = await globalPresence.register(socketKey, userId, roomId);
    if (!registered) return new Response("سامانه به ظرفیت هم‌زمان ۱۰۰ نفر رسیده است.", { status: 429 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.serializeAttachment({ userId, displayName, role, socketKey, lastRequestAt: 0, lastHeartbeatAt: 0 });
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "room:ready", capacity, connected: this.ctx.getWebSockets().length }));
    this.broadcast({ type: "room:presence", connected: this.ctx.getWebSockets().length }, server);
    const speaker = await this.getSpeaker();
    if (speaker?.sessionId) server.send(JSON.stringify({ type: "ptt:published", memberId: speaker.userId, memberName: speaker.displayName, sessionId: speaker.sessionId }));
    else if (speaker) server.send(JSON.stringify({ type: "ptt:granted", memberId: speaker.userId, memberName: speaker.displayName }));
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "hy-room-v1" } });
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
    if (typeof raw !== "string" || raw.length > 2048) { socket.close(1009, "Message too large"); return; }
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    const attachment = socket.deserializeAttachment();
    if (!attachment || !["ptt:request", "ptt:release", "ptt:heartbeat", "ptt:published", "room:heartbeat"].includes(message.type)) return;
    const now = Date.now();

    if (message.type === "ptt:request") {
      if (now - (attachment.lastRequestAt || 0) < 350) return;
      attachment.lastRequestAt = now;
      socket.serializeAttachment(attachment);
      const current = await this.getSpeaker();
      if (current && current.userId !== attachment.userId) {
        socket.send(JSON.stringify({ type: "ptt:busy", memberName: current.displayName }));
        return;
      }
      if (!current) {
        this.ctx.storage.sql.exec(
          "INSERT INTO speaker (id, user_id, display_name, session_id, expires_at) VALUES (1, ?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, display_name=excluded.display_name, session_id=NULL, expires_at=excluded.expires_at",
          attachment.userId, attachment.displayName, now + PTT_LEASE_MS
        );
        await this.ctx.storage.setAlarm(now + PTT_LEASE_MS);
      }
      this.broadcast({ type: "ptt:granted", memberId: attachment.userId, memberName: attachment.displayName, maxTalkSeconds: PTT_LEASE_MS / 1000 });
      return;
    }

    if (message.type === "ptt:heartbeat") {
      const current = await this.getSpeaker();
      if (!current || current.userId !== attachment.userId || now - (attachment.lastHeartbeatAt || 0) < PTT_HEARTBEAT_MIN_INTERVAL_MS) return;
      attachment.lastHeartbeatAt = now;
      socket.serializeAttachment(attachment);
      const expiresAt = now + PTT_LEASE_MS;
      this.ctx.storage.sql.exec("UPDATE speaker SET expires_at = ? WHERE id = 1 AND user_id = ?", expiresAt, attachment.userId);
      await this.ctx.storage.setAlarm(expiresAt);
      return;
    }

    if (message.type === "ptt:release") {
      await this.releaseSpeaker(attachment.userId);
      return;
    }

    if (message.type === "ptt:published") {
      await this.announcePublisher(attachment.userId, message.sessionId);
      return;
    }
    if (message.type === "room:heartbeat") {
      await this.env.GLOBAL_PRESENCE.getByName("global").touch(attachment.socketKey);
    }
  }

  async announcePublisher(userId, sessionId) {
    const current = await this.getSpeaker();
    if (!current || current.userId !== userId || !sessionId) return false;
    const roomId = await this.ctx.storage.get("roomId");
    const session = await this.env.DB.prepare(
      "SELECT id FROM sfu_sessions WHERE id = ? AND user_id = ? AND room_id = ? AND session_type = 'publisher' AND status = 'published'"
    ).bind(sessionId, userId, roomId).first();
    if (!session) return false;
    this.ctx.storage.sql.exec("UPDATE speaker SET session_id = ? WHERE id = 1 AND user_id = ?", sessionId, userId);
    this.broadcast({ type: "ptt:published", memberId: userId, memberName: current.displayName, sessionId });
    return true;
  }

  async releaseSpeaker(userId = null) {
    const current = this.ctx.storage.sql.exec("SELECT user_id, session_id FROM speaker WHERE id = 1").toArray()[0];
    if (!current || (userId && current.user_id !== userId)) return;
    this.ctx.storage.sql.exec("DELETE FROM speaker WHERE id = 1");
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ type: "ptt:released", memberId: current.user_id, sessionId: current.session_id || null });
    if (current.session_id) {
      const session = await this.env.DB.prepare("SELECT mid FROM sfu_sessions WHERE id = ?").bind(current.session_id).first();
      await closeSfuSession(this.env, current.session_id, session?.mid || null);
    }
  }

  async revokeUser(userId) {
    await this.releaseSpeaker(userId);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.userId === userId) {
        await this.env.GLOBAL_PRESENCE.getByName("global").unregister(attachment.socketKey);
        try { socket.send(JSON.stringify({ type: "session:revoked" })); } catch {}
        try { socket.close(4001, "Session revoked"); } catch {}
      }
    }
    const sessions = await this.env.DB.prepare(
      "SELECT id, mid FROM sfu_sessions WHERE user_id = ? AND room_id = ? AND status <> 'closed'"
    ).bind(userId, await this.ctx.storage.get("roomId")).all().catch(() => ({ results: [] }));
    for (const session of sessions.results || []) await closeSfuSession(this.env, session.id, session.mid);
  }

  async disableRoom() {
    await this.releaseSpeaker();
    const roomId = await this.ctx.storage.get("roomId");
    const sessions = await this.env.DB.prepare(
      "SELECT id, mid FROM sfu_sessions WHERE room_id = ? AND status <> 'closed'"
    ).bind(roomId).all().catch(() => ({ results: [] }));
    for (const session of sessions.results || []) await closeSfuSession(this.env, session.id, session.mid);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.socketKey) await this.env.GLOBAL_PRESENCE.getByName("global").unregister(attachment.socketKey);
      try { socket.send(JSON.stringify({ type: "room:disabled" })); } catch {}
      try { socket.close(4003, "Room disabled"); } catch {}
    }
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.userId) {
      await this.env.GLOBAL_PRESENCE.getByName("global").unregister(attachment.socketKey);
      await this.releaseSpeaker(attachment.userId);
      const sessions = await this.env.DB.prepare(
        "SELECT id, mid FROM sfu_sessions WHERE user_id = ? AND room_id = ? AND status <> 'closed'"
      ).bind(attachment.userId, await this.ctx.storage.get("roomId")).all().catch(() => ({ results: [] }));
      for (const session of sessions.results || []) await closeSfuSession(this.env, session.id, session.mid);
    }
    this.broadcast({ type: "room:presence", connected: this.ctx.getWebSockets().length });
  }

  async webSocketError(socket) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.userId) {
      await this.env.GLOBAL_PRESENCE.getByName("global").unregister(attachment.socketKey);
      await this.releaseSpeaker(attachment.userId);
    }
  }

  async alarm() {
    const current = this.ctx.storage.sql.exec("SELECT user_id, expires_at FROM speaker WHERE id = 1").toArray()[0];
    if (!current) return;
    if (current.expires_at > Date.now()) {
      await this.ctx.storage.setAlarm(current.expires_at);
      return;
    }
    await this.releaseSpeaker(current.user_id);
  }
}


export class GlobalPresence extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_connections (
        socket_key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_attempts (
        ip_hash TEXT NOT NULL,
        bucket INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        PRIMARY KEY (ip_hash, bucket)
      )
    `);
  }

  async allowLogin(ipHash) {
    const bucket = Math.floor(Date.now() / 900000);
    const row = this.ctx.storage.sql.exec(
      "SELECT attempts FROM login_attempts WHERE ip_hash = ? AND bucket = ?",
      ipHash, bucket
    ).toArray()[0];
    if ((row?.attempts || 0) >= 10) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO login_attempts (ip_hash, bucket, attempts) VALUES (?, ?, 1) ON CONFLICT(ip_hash, bucket) DO UPDATE SET attempts = attempts + 1",
      ipHash, bucket
    );
    this.ctx.storage.sql.exec("DELETE FROM login_attempts WHERE bucket < ?", bucket - 1);
    return true;
  }

  async scheduleCleanup() {
    const row = this.ctx.storage.sql.exec("SELECT MIN(expires_at) AS next_expiry FROM active_connections").toArray()[0];
    if (row?.next_expiry) await this.ctx.storage.setAlarm(row.next_expiry);
    else await this.ctx.storage.deleteAlarm();
  }

  async register(socketKey, userId, roomId) {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM active_connections WHERE expires_at <= ?", now);
    const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM active_connections").toArray()[0]?.n || 0;
    if (count >= MAX_ROOM_MEMBERS) {
      await this.scheduleCleanup();
      return false;
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO active_connections (socket_key, user_id, room_id, expires_at) VALUES (?, ?, ?, ?)",
      socketKey, userId, roomId, now + 10 * 60 * 1000
    );
    await this.scheduleCleanup();
    return true;
  }

  async touch(socketKey) {
    if (!socketKey) return false;
    this.ctx.storage.sql.exec(
      "UPDATE active_connections SET expires_at = ? WHERE socket_key = ?",
      Date.now() + 10 * 60 * 1000, socketKey
    );
    await this.scheduleCleanup();
    return true;
  }

  async unregister(socketKey) {
    if (!socketKey) return;
    this.ctx.storage.sql.exec("DELETE FROM active_connections WHERE socket_key = ?", socketKey);
    await this.scheduleCleanup();
  }

  getCount() {
    return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM active_connections WHERE expires_at > ?", Date.now()).toArray()[0]?.n || 0;
  }

  async alarm() {
    this.ctx.storage.sql.exec("DELETE FROM active_connections WHERE expires_at <= ?", Date.now());
    this.ctx.storage.sql.exec("DELETE FROM login_attempts WHERE bucket < ?", Math.floor(Date.now() / 900000) - 1);
    await this.scheduleCleanup();
  }
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB || !env.ROOM_HUB || !env.GLOBAL_PRESENCE) return json({ error: "اتصال پایگاه داده یا اتاق‌ها تنظیم نشده است." }, 503);
      if (request.method === "OPTIONS") return corsResponse(request, env, new Response(null, { status: 204 }));
      const response = await handleApi(request, env);
      if (response) return request.headers.get("upgrade")?.toLowerCase() === "websocket" ? response : corsResponse(request, env, response);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: error?.message || "unknown" }));
      return json({ error: "خطای داخلی سامانه رخ داد." }, 500);
    }
  }
};
