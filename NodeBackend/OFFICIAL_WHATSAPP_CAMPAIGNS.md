# Official WhatsApp campaigns and receipts

The official campaign workflow is separate from the existing Baileys campaign sender. Open `/cloud-campaigns` or **Official WhatsApp** in the sidebar. Existing `/campaigns`, campaign tables, Baileys services, ad-hoc template sends and bot replies retain their existing interfaces.

## Storage

The existing PostgreSQL database holds four new tables:

- `cloud_campaigns`: tenant, explicit sender session/phone/WABA, approved template snapshot, shared header/button parameters, pacing, daily attempt cap and scheduling state.
- `cloud_campaign_recipients`: unique campaign/phone, name, body parameters, opt-in source, latest attempt and status.
- `cloud_message_attempts`: immutable request snapshot per attempt, Meta message ID, acceptance and receipt timestamps, failure details. Failed retries create a new attempt.
- `cloud_message_status_events`: deduplicated receipt history and STOP suppression, including receipts for direct API/Python sends that are not associated with a campaign.

`server/cloud/schema.ts` is an additive, transactional, idempotent startup migration. `shared/cloudCampaignSchema.ts` describes the same tables for Drizzle. Existing Baileys campaign and recipient tables are not modified or used by the new sender. Tenant/session mappings and the existing blocklist are read, not migrated.

## Preparing and sending

1. Choose an explicitly connected official sender and an approved template/language.
2. Provide template parameters, and a durable HTTPS media URL if its header requires media. The Dr. Amit template requires an image header and one body parameter.
3. Import CSV with `name,phone,param_1,param_2,...`, international phone numbers and an opt-in source. Duplicate phone numbers are rejected. Up to 1,000 recipients per draft, subject to the 1 MB API request limit.
4. Save a draft. This does not send anything. Review saved content/audience, then start or schedule it in the UI.
5. Export the recipient report as CSV. The API also returns attempt history. Recent standalone receipts appear below the campaign list.

The default campaign cap is 100 attempts per rolling 24 hours with 25 seconds between recipients. The configurable cap (1–250) is an application campaign limit, not a claim about the account's Meta allowance. Meta's account, recipient, quality and billing limits still apply. Positional text body/header parameters, image/video/document headers, static buttons and dynamic URL buttons are supported. Unsupported/named/authentication/carousel template formats are rejected rather than silently altered.

## Delivery and restart behavior

The signed Meta webhook saves receipts and STOP suppression before HTTP 200. A persistence failure returns 503 so Meta can retry. The existing inbound-message/bot handling continues after acknowledgement. Receipt storage does not require the in-memory WhatsApp session to be loaded or its token to be valid.

Receipt keys deduplicate repeated deliveries. Projection favors read, delivered, failed, then sent; old receipts cannot regress a success. Timestamps retain the actual webhook event times. Missing delivery/read receipts stay unknown; accepting a send is not proof of delivery. Pricing metadata is retained when supplied, but reports do not invent invoice amounts.

Before each external send, a transaction locks the campaign and creates a dispatching attempt. The attempt ID is passed as Meta `biz_opaque_callback_data`, allowing a receipt to correlate even if it precedes saving the send response. Receipt matching checks tenant, sender and recipient. A late receipt for an old retry does not overwrite the latest attempt.

An interrupted dispatch or ambiguous network/5xx response becomes `unknown`; it is never automatically resent. The worker marks stale dispatches unknown after two minutes. Explicit **Queue failed recipients for retry** applies only to confirmed failures and leaves the campaign paused for review. Pausing prevents new claims, but an already dispatched request may finish. Completed means all recipients have been processed, not that all messages were delivered; late receipts continue updating the report.

STOP text/quick replies suppress subsequent official campaigns for the same tenant, and the sender also checks the existing tenant blocklist. No new unsolicited opt-out confirmation is sent by this module. The existing bot's behavior remains in place.

## API

All campaign/report routes require the existing bearer-token authentication and use both organization and user ownership:

- `GET /api/cloud/campaign-senders`, `GET /api/cloud/campaign-templates?sessionId=...`
- `GET|POST /api/cloud/campaigns`
- `GET /api/cloud/campaigns/:id`, `GET /api/cloud/campaigns/:id/report.csv`
- `POST /api/cloud/campaigns/:id/start` (optional ISO `scheduledAt`), `/pause`, `/retry-failed`
- `GET /api/cloud/status-events` (latest 200 receipts for the authenticated owner)

No historical receipts are backfilled. Existing direct-send scripts continue to send as before; their new webhook receipts are retained, but campaign association requires using this workflow.

## Validation and rollback

Run `npx tsx --test server/cloud/*.test.ts shared/metaSignup.test.ts`, `npm run build`, and compare `npx tsc --noEmit --incremental false` against the known baseline. Tests use isolated PGlite PostgreSQL and mocked Meta requests, never production sends. They cover additive migration, tenant isolation, sender selection, duplicate/out-of-order/early receipts, failures/retries, restart uncertainty, scheduling, STOP/blocklists, caps and legacy transport compatibility.

Rollback the application commit to restore the prior code; retain the four new tables and their data. Pause any official campaigns first if the application remains available. Re-enabling the new code resumes explicitly started/scheduled campaigns; uncertain attempts stay held. Do not drop existing campaign tables or run a destructive schema reset.
