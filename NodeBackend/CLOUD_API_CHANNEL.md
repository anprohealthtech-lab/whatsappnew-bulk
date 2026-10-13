# Meta WhatsApp Cloud API channel

A second WhatsApp transport next to Baileys. A tenant's session row in
`whatsapp_sessions` can now say `provider = 'cloud_api'`; such a session is
driven by Meta's official WhatsApp Cloud API instead of a QR-linked phone.
Nothing in the Baileys code path changes. Everything downstream (lead chatbot,
RAG, drips, campaigns, HR/HIMS bots, notifications, `/api/send-message`) keeps
calling the same `WAServiceInstance` methods and works unchanged.

## What was added

| File | Purpose |
|---|---|
| `server/services/CloudApiSession.ts` | `WAServiceInstance` implementation on the Graph API: `sendTextMessage`, `sendMediaMessage` (upload + send), `sendTemplateMessage`, `listTemplates`, `markAsRead`, 24 h service-window tracking, and `handleWebhookValue()` which turns Meta webhook payloads into the same `incoming-message` / `button-clicked` events the Baileys session emits. |
| `server/cloudApiRoutes.ts` | `GET/POST /api/webhooks/meta` (verification + signed inbound), `GET/POST /api/admin/cloud-sessions` (super admin), `GET /api/cloud/templates`, `POST /api/cloud/send-template`, `GET /api/cloud/window/:phone`. |
| `server/services/WhatsAppSessionManager.ts` | `getSession()` creates a `CloudApiSession` when the row's provider is `cloud_api`; `findCloudSessionRow(phoneNumberId)`; `unloadSession()`. |
| `shared/schema.ts`, `server/migrate.ts` | New columns on `whatsapp_sessions`: `provider` (default `baileys`), `cloud_phone_number_id`, `cloud_waba_id`, `cloud_access_token`. Added idempotently at startup like every other migration. |
| `server/index.ts` | `express.json({ verify })` keeps the raw body so the webhook signature can be checked. |
| `server/routes.ts` | Registers the cloud routes next to the external API routes. |

## Environment

```
META_APP_SECRET=            # App Dashboard -> App settings -> Basic -> App secret. Required; webhooks are rejected without it.
META_WEBHOOK_VERIFY_TOKEN=  # any random string; same value goes in App Dashboard -> WhatsApp -> Configuration
META_WA_ACCESS_TOKEN=       # optional fallback token when a session row has no cloud_access_token
META_GRAPH_VERSION=         # optional, default v25.0
```

## Onboarding a tenant (one-time per number)

1. Deploy this branch; the migration adds the columns on startup.
2. Create the session (super admin JWT):

```
POST /api/admin/cloud-sessions
{
  "userId": "<users.id of the tenant>",
  "sessionName": "cloud",
  "phoneNumberId": "1162361510300583",
  "wabaId": "2747854975591157",
  "accessToken": "<permanent business/system-user token with whatsapp_business_messaging + whatsapp_business_management>",
  "phoneNumber": "916358240913"
}
```

   The route verifies the token against Meta, stores the row with
   `status = connected`, loads the session and returns its status. Sessions are
   restored on boot like Baileys ones (`restoreConnectedSessions`).

3. In the Meta App Dashboard, WhatsApp -> Configuration: callback URL
   `https://<this server>/api/webhooks/meta`, verify token =
   `META_WEBHOOK_VERIFY_TOKEN`, subscribe to the `messages` field.
4. Subscribe the app to the tenant's WhatsApp Business Account once:
   `POST https://graph.facebook.com/v25.0/<wabaId>/subscribed_apps` with the
   same token (or App Dashboard -> WhatsApp -> Configuration -> Manage).

Baileys tenants are untouched: their rows keep `provider = 'baileys'`.
A tenant can have both a Baileys session and a cloud session under different
`sessionName`s; `getFirstConnectedSession()` returns whichever is connected
first, so give a cloud-only tenant no connected Baileys session.

## Behaviour notes

- **24-hour window.** Free-form text/media reach a user only within 24 h of
  their last inbound message. The session tracks inbound times in memory and
  logs a warning when a free-form send falls outside the window; Meta accepts
  such sends but does not deliver them (status `failed`, error 131047 arrives
  on the webhook). For cold sends use `POST /api/cloud/send-template` or
  `session.sendTemplateMessage(phone, name, lang, params)`.
- **Inbound shape** matches the Baileys events: `phoneNumber` (digits), `from`
  and `replyTo` (`<digits>@s.whatsapp.net`), `content`, `messageType`
  (`text|image|document|video|audio|voice_note`), `mediaInfo`, `mediaData`
  (base64), `mediaBuffer`, `audioData`/`audioBuffer` for audio, plus
  `pushName`, `sourceMessageId`, `receivedAt`. Button/list replies emit
  `button-clicked` with `buttonId`; a text of `STOP` also emits
  `STOP_MESSAGES` like Baileys. Delivery receipts emit `message-status`.
- **Groups, QR, LID** are not applicable; `listGroups()` returns `[]`,
  `generateQRCode()` throws, `@lid` recipients are rejected.
- **Media** is uploaded to Meta per send (`/{phone_number_id}/media`); the
  message type is picked from the file extension (image/video/audio/document).
  Audio cannot carry a caption, so the caption is sent as a follow-up text.
- **Security.** Webhooks are accepted only with a valid `X-Hub-Signature-256`
  over the raw body. The access token lives in the DB row (or env); the admin
  list endpoint only shows its last 6 characters.
- **Rate/quality.** New numbers start at 250 business-initiated conversations
  per 24 h; the tier rises automatically with volume and quality.
