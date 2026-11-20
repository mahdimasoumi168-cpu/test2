# همیار هیئت — Cloudflare foundation

This directory contains the Cloudflare Worker control plane. It is a first deployment milestone, not yet a production voice release.

## Existing Cloudflare resources inspected on 2026-11-20

- D1 database: `hamyar-heyat-db` (existing schema and six active rooms)
- Two Cloudflare Realtime SFU applications already exist
- A previous Worker named `test2` exists, but it has no D1 or Durable Object bindings
- The D1 database currently has zero users, zero room memberships, and zero SFU sessions
- The existing room table has six active rooms

The new Worker is named `hamyar-heyat` to avoid replacing the existing `test2` Worker or its assets.

## What this milestone implements

- Same-origin Persian PWA asset serving
- Login with member name + guardian code + personal code
- PBKDF2-SHA-256 code hashing and signed 12-hour sessions
- One-time bootstrap endpoint for the first administrator
- Basic admin API to create members and assign room memberships
- D1-backed room access checks
- One Durable Object per room
- Persistent exclusive PTT lease with a 30-second hard timeout
- Maximum room occupancy capped at 100
- WebSocket hibernation-compatible room control

**Important:** This milestone controls the right to speak only. It does not yet publish or receive audio. The UI must not be treated as an operational walkie-talkie until the Realtime SFU media path and native background-audio clients are completed and tested.

## Deploy

Use Node.js 20+ and Wrangler:

```bash
npx wrangler@latest secret put SESSION_SECRET --config cloudflare/wrangler.jsonc
npx wrangler@latest secret put BOOTSTRAP_ADMIN_KEY --config cloudflare/wrangler.jsonc
npx wrangler@latest deploy --config cloudflare/wrangler.jsonc
```

Generate both secrets locally with a cryptographically secure random generator. Never commit them to GitHub or send them in chat.

After deployment, call `POST /api/admin/bootstrap` once with the `x-bootstrap-key` header and JSON body:

```json
{
  "fullName": "نام مدیر",
  "guardianCode": "کد سرپرستی حداقل ۴ نویسه",
  "personCode": "کد شخص حداقل ۴ نویسه"
}
```

The bootstrap endpoint refuses to run once any user exists. Store the administrator codes securely.

## Free-tier guardrails

- Cloudflare Workers Free has a daily request allowance; excess requests are rejected until reset.
- Durable Objects Free has daily request and compute allowances. Avoid periodic heartbeat messages; the PTT lease is bounded to 30 seconds and released on pointer-up or disconnect.
- Cloudflare Realtime SFU/TURN has a shared 1,000 GB monthly free egress allowance, subject to current account terms.
- This project does not configure paid services or a paid plan.
- No hard guarantee of 100 simultaneous users is made until a real load test is completed.

## Background audio status

The web PWA cannot guarantee continuous audio reception when iOS suspends the browser. Android needs a native foreground audio service. iOS needs a native audio-session/background-audio implementation and must comply with Apple's permitted background modes and review rules. These are separate native-app milestones and are not included in this Worker control-plane release.

## Next milestones

1. Add authenticated Cloudflare Realtime SFU session, publish, subscribe, renegotiate, and cleanup endpoints.
2. Connect browser foreground audio and test one speaker / 99 listeners.
3. Add native Android audio service and iOS background-audio client.
4. Add per-room permissions, admin UI, audit log, abuse controls, and automated integration/load tests.
5. Validate 100 simultaneous connections and measure real egress before public use.
