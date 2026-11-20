# Cloudflare deployment — همیار هیئت

This is the Cloudflare deployment path for the application. The Worker is configured in the repository root `wrangler.jsonc` and serves the PWA from `public/`.

## Production resources

- Worker script: `test2`
- Production D1: `hamyar-heyat-db`
- Preview D1: `hamyar-heyat-stage-db`
- Durable Objects: `RoomHub` per room and `GlobalPresence` for the global 100-connection cap
- Cloudflare Realtime SFU application credentials already exist as Worker secrets on `test2`
- A Cloudflare Realtime TURN key has been created; its secret must be stored as a Worker secret before TURN relay is enabled

The production D1 database has six active rooms, each configured for 100 members. A separate staging D1 database has the same room/schema baseline. SFU session lifecycle migration 0003 is applied to both databases.

## Required Worker secrets

Set these under **Workers & Pages → test2 → Settings → Variables and Secrets → Add → Secret**. Do not put secret values in GitHub or chat.

- `SESSION_SECRET`: already present on Worker `test2`; verify it remains configured
- `CODE_PEPPER`: new random 48-byte secret
- `BOOTSTRAP_ADMIN_KEY`: new random 48-byte one-time setup key
- `TURN_KEY_SECRET`: secret returned when the `hamyar-heyat-turn` TURN key was created

Existing `SFU_APP_ID` and `SFU_APP_SECRET` bindings must remain present. `TURN_KEY_ID` is a non-secret Worker variable in `wrangler.jsonc`.

On Windows with Node.js 20+, generate each value separately:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Use a new output for each secret. Save the one-time `BOOTSTRAP_ADMIN_KEY` securely because it cannot be read back from Cloudflare.

## Deploy and preview

The Cloudflare build trigger for the repository deploys the Worker from the default branch. For a local deployment after configuring secrets:

```bash
npm install
npm run worker:deploy
```

Preview deployments use the isolated staging D1 binding in the `previews` section of `wrangler.jsonc`. They do not share production member data.

## Bootstrap the first administrator

The production D1 database currently contains zero users. After the Worker is deployed and all production secrets are set, call the one-time endpoint:

```powershell
$headers = @{ "x-bootstrap-key" = "YOUR_BOOTSTRAP_ADMIN_KEY" }
$body = @{
  fullName = "نام مدیر"
  guardianCode = "کد سرپرستی"
  personCode = "کد شخص"
} | ConvertTo-Json
Invoke-RestMethod -Uri "https://test2.mahdi-masoumi168.workers.dev/api/admin/bootstrap" -Method Post -Headers $headers -ContentType "application/json" -Body $body
```

Use your own administrator name and codes. The endpoint refuses to create another initial administrator once the first account exists. The created administrator receives access to all six rooms.

## Voice and capacity

- One active speaker per room, with exclusive Push-to-Talk control.
- A global Durable Object caps all active room connections at 100 across the whole service.
- Room membership is deny-by-default for regular members. Administrators assign each member to active rooms from the Persian admin panel; the Worker checks membership on every WebSocket and SFU API request.
- PTT speaker leases are stored atomically in each room Durable Object, bound to the exact WebSocket connection, and released on button release, socket close, or lease expiry. A second device logged into the same account cannot release or renew another device's speaker lease.
- Login attempts are limited per IP and per account identity; the account identity limit is 10 attempts per 15-minute bucket.
- Cloudflare Realtime SFU handles publication and subscription. Audio is constrained to a target maximum of 20 kbps per sender to control free egress consumption.
- TURN credentials are generated for authenticated members with a 48-hour TTL (Cloudflare's maximum), but the Worker must have the `TURN_KEY_SECRET` secret configured. Without it, clients use STUN only and some restrictive networks may fail to connect.
- PWA foreground audio is implemented in the branch; background playback while iOS/Android suspends the web page is not guaranteed.

## Zero-cost constraints

No paid Cloudflare plan or paid third-party service is configured in this repository. Free-tier limits still apply and are not a capacity guarantee. At 100 users, actual media egress, Workers requests, Durable Objects requests, CPU time, and mobile network behavior must be load-tested. If the free quota is exceeded, service may be throttled or stop until reset; do not enable paid overages.

## Release gate

Do not declare the system production-ready until:
1. CI and Wrangler dry-run pass.
2. Production secrets are present and bootstrap is completed.
3. Two real devices can publish/receive audio on Wi-Fi and mobile networks.
4. Android and iOS native background-audio clients are built and tested.
5. A 100-connection load test and monthly egress estimate pass within free quotas.
