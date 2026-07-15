# WhatsApp LIMS Backend API - Complete Endpoint Reference

## Base URL
https://node-backend-dranand.replit.app

---

## QR Code Management

### Generate QR Code
**POST** `/api/generate-qr`
- Response: 404 Not Found (as of now, endpoint not available)

### Get Current QR Code
**GET** `/api/qr-code`
- Response:
```json
{
  "success": true,
  "qrCode": "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=...",
  "message": "Test QR for immediate verification",
  "isReal": true,
  "isTest": true
}
```

---

## Message Management

### Send Text Message
**POST** `/api/send-message`
- Content-Type: application/json
- Body:
```json
{
  "phoneNumber": "+1234567890",
  "content": "Laboratory test results are ready for pickup."
}
```

### Send Report with Attachment
**POST** `/api/send-report`
- Content-Type: multipart/form-data
- Fields: phoneNumber, sampleId, content, file

### Get Message History
**GET** `/api/messages?status=all&limit=50&offset=0`
- Query Parameters: status, search, limit, offset
- Response:
```json
{
  "success": true,
  "data": {
    "messages": [
      {
        "id": "d4b0be02-cc20-4e25-a1e9-e67b1071bb2b",
        "phoneNumber": "+1234567890",
        "content": "Testing persistent storage!",
        "type": "text",
        "status": "sent",
        "fileUrl": null,
        "fileName": null,
        "fileSize": null,
        "sampleId": null,
        "metadata": { "whatsappId": "demo_1754542024150", "whatsappTimestamp": 175454202415 },
        "createdAt": "2025-08-07T04:47:04.100Z",
        "sentAt": "2025-08-07T04:47:04.150Z",
        "deliveredAt": null
      }
    ],
    "total": "1",
    "limit": 1,
    "offset": 0
  }
}
```

---

## System Status & Monitoring

### Get System Status
**GET** `/api/status`
- Response:
```json
{
  "success": true,
  "data": {
    "whatsapp": {
      "isConnected": false,
      "isAuthenticated": false,
      "lastSeen": null,
      "sessionInfo": null
    },
    "stats": {
      "totalMessages": "1",
      "sentToday": 1,
      "deliveredToday": 0,
      "failedToday": 0,
      "pendingCount": "0"
    },
    "systemLogs": [
      {
        "id": "a0000515-46db-40ed-9a97-3e9baa3e9431",
        "level": "info",
        "message": "Text message sent to 1234567890",
        "metadata": { "messageId": "d4b0be02-cc20-4e25-a1e9-e67b1071bb2b", "whatsappId": "demo_1754542024150" },
        "createdAt": "2025-08-07T04:47:04.275Z"
      }
    ],
    "timestamp": "2025-08-07T07:58:09.498Z"
  }
}
```

---

## Real-time WebSocket

### WebSocket Connection
**wss://node-backend-dranand.replit.app/ws**

#### Event Types:
- `qr-code`: New QR code generated
- `whatsapp-status`: Connection status updates
- `whatsapp-authenticated`: Successful authentication
- `whatsapp-auth-failure`: Authentication failed
- `message-sent`: Message successfully sent
- `message-update`: Delivery status updates
- `disconnected`: WhatsApp disconnected

---

## External Machine-to-Machine API (x-api-key)

Lets an external app act on behalf of an **already-registered user**: connect WhatsApp via QR, poll QR/status, disconnect, send text/media, and bulk send. Implemented in `server/externalApiRoutes.ts`.

### Authentication
Every endpoint requires the shared API key in a header:
```
x-api-key: <EXTERNAL_WA_API_KEY>
```
(`Authorization: Bearer <key>` also accepted.)

The target user is chosen via the `:userId` route param or `userId` body field and **must exist in the users table** — unknown users get 404; this API never creates users.

### Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `EXTERNAL_WA_API_KEY` | `whatsapp-lims-api-key-2024` | Shared secret for all endpoints below. Always set explicitly in production. |
| `EXTERNAL_BULK_MAX_RECIPIENTS` | `200` | Max recipients per bulk request. |
| `EXTERNAL_MEDIA_MAX_BYTES` | `26214400` (25 MB) | Max media size (URL download and multipart upload). |
| `EXTERNAL_WA_API_URL` | unset | **Must be UNSET to serve as provider.** If set, this instance proxies WhatsApp sessions to another app and these endpoints daisy-chain upstream. |

These paths match the contract consumed by `ExternalWhatsAppProxy`, so another instance of this codebase with `EXTERNAL_WA_API_URL` pointed here works as a client unchanged.

### Response envelope
All responses: `{ "success": true, "data": { ... } }` or `{ "success": false, "error": "..." }`.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/external/users/sync` | Validate a user is registered (`{ id }` in body; 404 if not) |
| POST | `/api/external/users/sync-admins` | Upsert organization admins from another app: `{ organizationId, admins: [{ id, email?, name?, role }] }` |
| POST | `/api/users/:userId/whatsapp/connect` | Init session, returns first QR (`qrCode` = raw pairing string, `qrDataUrl` = base64 PNG) |
| GET | `/api/users/:userId/whatsapp/status` | All sessions, connected first: `{ sessions: [{ sessionName, status, isConnected, isAuthenticated, phoneNumber, lastConnectedAt }] }` |
| POST | `/api/users/:userId/whatsapp/refresh-qr` | Fresh QR; re-inits if QR stale (>60s); 409 if already connected |
| GET | `/api/users/:userId/whatsapp/qr` | Pollable QR read (never re-inits) |
| POST | `/api/external/sessions/pulse` | Liveness: `{ userId }` → `{ alive, isAuthenticated }` |
| POST | `/api/external/sessions/disconnect` | Logout + clear auth: `{ userId, sessionName? }` |
| POST | `/api/external/messages/send-user` | Send text: `{ userId, phoneNumber, message, sessionName? }` → `{ messageId, to }` |
| POST | `/api/external/reports/send-url` | Send media by URL: `{ userId, phoneNumber, fileUrl, fileName?, caption? }` |
| POST | `/api/external/messages/send-media` | Send media multipart: fields `userId`, `phoneNumber`, `caption?`, file field `file` |
| POST | `/api/external/messages/send-bulk` | Bulk paced send → **202** `{ jobId, total, status, estimatedSeconds }` |
| GET | `/api/external/messages/bulk-status/:jobId` | Poll bulk job: `{ status, total, processed, sent, failed, errors }` |
| POST | `/api/external/messages/bulk-stop/:jobId` | Stop a running bulk job |

### Sync task-manager admins
```json
POST /api/external/users/sync-admins
{
  "organizationId": "task-manager-org-uuid",
  "admins": [
    {
      "id": "task-manager-public-users-id",
      "email": "admin@example.com",
      "name": "Clinic Admin",
      "role": "admin"
    }
  ]
}
```
- Only `admin`, `superadmin`, `super_admin`, and `owner` roles are synced.
- The external app must use the task-manager `public.users.id` as `id`; this becomes the WhatsApp backend `users.id`.
- Synced users are upserted with disabled random passwords; they are machine-to-machine session owners, not password-login accounts.

### Bulk send
```json
POST /api/external/messages/send-bulk
{
  "userId": "<registered user id>",
  "recipients": ["919876543210", "919876543211"],
  "message": "Hello!",
  "mediaUrl": "https://example.com/file.pdf",
  "intervalSeconds": 25,
  "jitterSeconds": 5
}
```
- Processes asynchronously with randomized pacing (default 25s ± 5s, min 5s, max 300s between messages) to reduce ban risk.
- One running bulk job per user (409 otherwise); jobs are in-memory only and lost on restart (bulk-status then returns 404 — check message history instead).
- If `mediaUrl` is set, the file is sent to every recipient with `caption` (falls back to `message`) as the caption.

### Typical connect flow
```bash
KEY=whatsapp-lims-api-key-2024
BASE=http://localhost:5000

# 1. Start session — returns QR
curl -X POST $BASE/api/users/$USER_ID/whatsapp/connect -H "x-api-key: $KEY"

# 2. Poll QR (render qrDataUrl as <img src>) until user scans it in WhatsApp
curl "$BASE/api/users/$USER_ID/whatsapp/qr" -H "x-api-key: $KEY"

# 3. Confirm connected
curl "$BASE/api/users/$USER_ID/whatsapp/status" -H "x-api-key: $KEY"

# 4. Send
curl -X POST $BASE/api/external/messages/send-user -H "x-api-key: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"'$USER_ID'","phoneNumber":"919876543210","message":"hello"}'
```

### Error codes
- **401** bad/missing API key · **400** missing/invalid params, invalid phone, over recipient cap, session limit (max 3 per user) · **404** unknown user or bulk jobId · **409** refresh-qr while connected, concurrent bulk job · **503** no connected WhatsApp session.
