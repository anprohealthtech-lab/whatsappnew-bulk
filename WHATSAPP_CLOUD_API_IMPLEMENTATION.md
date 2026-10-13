# WhatsApp Cloud API channel: implementation record

Written 2026-10-13 as a reference for future sessions. The work was done by a
Claude Code computer-use agent in a separate session and verified here.
Technical detail (routes, env, payload shapes, behaviour notes) lives in
[NodeBackend/CLOUD_API_CHANNEL.md](NodeBackend/CLOUD_API_CHANNEL.md). This file records
the context: what was done, why, for whom, and what is still open.

## Summary

The app previously had one way to talk to WhatsApp: a Baileys session linked by
scanning a QR code with a phone. Branch `cloud-api-channel` adds a second,
official transport: Meta's WhatsApp Cloud API (Graph API). A session row in
`whatsapp_sessions` can now say `provider = 'cloud_api'` and carry the Meta
phone number id, WhatsApp Business Account id and access token. When the app
loads such a row it builds a `CloudApiSession` instead of a Baileys socket.
Everything downstream (lead chatbot, RAG, drips, campaigns, HR/HIMS bots,
notifications, `/api/send-message`) uses the same `WAServiceInstance`
interface and works unchanged.

Existing Baileys tenants are not affected. Every existing row gets
`provider = 'baileys'` through the column default. A tenant can have both a
Baileys session and a cloud session under different session names.

## Tenant this is for

| Item | Value |
|---|---|
| Tenant (users row) | Meditrust clinic tenant (look up its `users.id` before calling the admin route) |
| Clinic WhatsApp number | 6358240913 (stored as `916358240913`) |
| Meta app | Meditruat, app id `2160928754484741`, owned by verified business "AnPro Solutions - LIMS" |
| Phone number id | `1162361510300583` |
| WhatsApp Business Account id | `2747854975591157` |
| Mode | Coexistence: the WhatsApp Business phone app keeps working alongside the API |
| Templates | Four submitted, still in Meta review as of 2026-10-12 |
| Billing | Prepaid funds added in WhatsApp Manager |

Sending via the Cloud API was proven from the Meta side before the code was written.

## Code on branch `cloud-api-channel` (uncommitted as of 2026-10-13)

New files:

- `NodeBackend/server/services/CloudApiSession.ts` (533 lines). Implements
  `WAServiceInstance` over the Graph API: text, media (upload then send),
  template send, template list, mark as read, 24 h service window tracking, and
  `handleWebhookValue()` which turns Meta webhook payloads into the same
  `incoming-message`, `button-clicked`, `STOP_MESSAGES` and `message-status`
  events the Baileys session emits.
- `NodeBackend/server/cloudApiRoutes.ts` (259 lines). Signed webhook at
  `GET/POST /api/webhooks/meta`, super-admin `GET/POST /api/admin/cloud-sessions`,
  tenant routes `GET /api/cloud/templates`, `POST /api/cloud/send-template`,
  `GET /api/cloud/window/:phone`.
- `NodeBackend/CLOUD_API_CHANNEL.md`. Technical doc.

Modified files:

- `NodeBackend/server/services/WhatsAppSessionManager.ts`. `getSession()` checks
  the DB row first and builds a `CloudApiSession` when provider is `cloud_api`;
  adds `findCloudSessionRow(phoneNumberId)` for the webhook and
  `unloadSession()` for config reloads.
- `NodeBackend/shared/schema.ts` and `NodeBackend/server/migrate.ts`. Four new
  columns on `whatsapp_sessions`: `provider` (default `baileys`, not null),
  `cloud_phone_number_id`, `cloud_waba_id`, `cloud_access_token`, plus an index
  on `cloud_phone_number_id`. Added with `IF NOT EXISTS` in the startup
  migration, so it is safe to run repeatedly. No numbered SQL file was added
  under `migrations/`; this project applies schema changes through
  `migrate.ts` at boot.
- `NodeBackend/server/index.ts`. `express.json({ verify })` keeps the raw body
  so the `X-Hub-Signature-256` check can run.
- `NodeBackend/server/routes.ts`. One line registering the cloud routes.
- `NodeBackend/.env.example` and `.do/app.yaml`. New env names
  `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_WA_ACCESS_TOKEN`,
  `META_GRAPH_VERSION` (optional, default v25.0).

## Verification (re-run 2026-10-13)

- `tsc` reports 81 errors, the same count as before the branch. The five in
  `WhatsAppSessionManager.ts` are on pre-existing lines; none are in the new code.
- `npm run build:server` bundles cleanly (esbuild, dist/index.js about 832 kB).
- The original session ran a standalone smoke test against a mocked Graph API
  covering: text in, STOP, image with media download, button reply, duplicate
  suppression, failed-status receipt, outbound text, document upload and send,
  template send, and recipient validation. All passed.

## Remaining steps

1. Commit the branch and deploy it on DigitalOcean (app `whatsapp-management-app`).
   The migration adds the columns on first boot.
2. In the DigitalOcean app settings add `META_APP_SECRET` (Meta App Dashboard,
   Settings, Basic) and `META_WEBHOOK_VERIFY_TOKEN` (any random string).
3. Create the Meditrust cloud session once, with a super-admin JWT:

   ```
   POST /api/admin/cloud-sessions
   {
     "userId": "<users.id of the Meditrust tenant>",
     "sessionName": "cloud",
     "phoneNumberId": "1162361510300583",
     "wabaId": "2747854975591157",
     "accessToken": "<permanent system-user token with whatsapp_business_messaging + whatsapp_business_management>",
     "phoneNumber": "916358240913"
   }
   ```

   The route verifies the token against Meta, stores the row as `connected`
   and loads the session. Sessions are restored on boot like Baileys ones.
4. In the Meta App Dashboard, WhatsApp, Configuration: set the callback URL to
   `https://<public base url>/api/webhooks/meta`, enter the verify token, and
   subscribe to the `messages` field. Then subscribe the app to the WABA once
   (`POST /{waba_id}/subscribed_apps` with the business token, or the
   Manage button in the dashboard).
5. Send a real WhatsApp message to 6358240913 and confirm it reaches the lead
   qualifier.

## Operating rules to remember

- Free-form text and media only deliver within 24 hours of the customer's last
  inbound message. Outside that window use an approved template via
  `POST /api/cloud/send-template`. Meta accepts the free-form send but reports
  status `failed` with error 131047 on the webhook.
- No QR, no groups, no `@lid` recipients on the cloud transport.
- Webhooks without a valid signature are rejected; the admin list endpoint only
  shows the last six characters of a stored token.
- New numbers start at 250 business-initiated conversations per 24 h; the tier
  rises with volume and quality. Bans on the official API come from blocks and
  reports, so the lead qualifier should still avoid spam-like behaviour.
- `getFirstConnectedSession()` returns whichever session is connected first, so
  a cloud-only tenant should not also have a connected Baileys session.

## Future: external clients (Tech Provider model)

Each client's number would sit on their own WhatsApp Business Account, billed
to them, but connected to this app and this webhook. Needed:

1. Business verification: already done for AnPro Solutions - LIMS.
2. Advanced Access for `whatsapp_business_management` and
   `whatsapp_business_messaging` through Meta App Review (privacy policy URL,
   app icon, screen recording of the signup flow, use-case description;
   typically one to two weeks). Standard Access only covers businesses the
   app owner controls.
3. Embedded Signup: a Meta popup on the app's onboarding page. The client logs
   into Facebook, picks or creates a business portfolio, enters the number,
   receives the OTP, and the popup returns a code plus the new phone number id
   and account id. The backend exchanges the code for a permanent token and
   stores it on that tenant's `whatsapp_sessions` row (the same columns added
   here). Configured under Facebook Login for Business in the app dashboard.

## Live event feed (/ws) is now authenticated (2026-10-13)

Before this change the WebSocket at `/ws` accepted anyone and broadcast every
tenant's events, including incoming message text, media and pairing QR codes.
Now:

- The upgrade must carry the same JWT as the REST API, as `?token=` on the URL
  (what the dashboard does) or an `Authorization: Bearer` header. Otherwise the
  server answers 401 and closes.
- Each event is delivered only to sockets of the session owner, users in the
  same organization, and super admins. Events with no identifiable owner go to
  super admins only.
- Media buffers and base64 fields are stripped from broadcast payloads.

Any external tool that used to read `/ws` anonymously must now pass a token.
