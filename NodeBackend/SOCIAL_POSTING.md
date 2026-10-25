# Scheduled Facebook / Instagram posting

Publishes MediTrust reels and photos at a chosen time **from the server**, so a
post no longer depends on anyone's PC being awake. Built 2026-10-18.

Why it exists: Facebook can schedule natively (`scheduled_publish_time`), but
**Instagram has no scheduling API at all** — something has to be awake at the
publish moment and call Meta. This app is already always-on, already holds Meta
credentials and already has Postgres, so the queue lives here.

## Pieces

| File | Role |
|---|---|
| `shared/schema.ts` → `socialPosts` | the queue table (`social_posts`) |
| `server/migrate.ts` → migration 0016 | creates the table on startup |
| `server/services/ImageKitService.ts` | uploads an asset, returns a public URL |
| `server/services/SocialPostService.ts` | the 5-minute tick, Facebook + Instagram publishing |
| `server/socialPostRoutes.ts` | `/api/social/*` endpoints (super admin only) |

Media never streams through this server: both platforms **fetch the asset from
ImageKit** (Facebook via the Reels `file_url` transfer header, Instagram via
`video_url`). The one exception is a Facebook reel cover, whose endpoint only
accepts an uploaded file — those are ~200 KB.

## Environment (DigitalOcean App Platform)

```
SOCIAL_FB_PAGE_ID=1208413379018064          # MediTrust Clinics Page
SOCIAL_FB_TOKEN=<long-lived user token>     # same token as D:\fb posting script\.env
SOCIAL_IG_USER_ID=17841414513182270         # @meditrust.clinics
IMAGEKIT_PRIVATE_KEY=<private key>          # ImageKit dashboard → Developer → API keys
IMAGEKIT_FOLDER=/social                     # optional, default /social
SOCIAL_TICK_MS=300000                       # optional, default 5 min
IG_MAX_POSTS_PER_DAY=3                      # optional, default 3
IG_MIN_GAP_MINUTES=180                      # optional, default 180
```

The token needs `pages_manage_posts`, `pages_read_engagement`,
`instagram_basic`, `instagram_content_publish`. The service swaps the user token
for the Page token itself, exactly as `fb_post.py` does; both never expire, but
**data access expires 2027-01-10** — a `code 190` in the logs means regenerate.
A System User token is the better long-term choice.

Without `SOCIAL_FB_PAGE_ID`/`SOCIAL_FB_TOKEN` the scheduler logs a warning and
stays off, so deploying before the env is set changes nothing.

## Posting something

1. Upload the files (multipart; `media` and optional `cover`):

```bash
curl -X POST https://whatsapp-automation.limsapp.in/api/social/assets \
  -H "Authorization: Bearer $JWT" \
  -F media=@P1_baby-normal-temperature.mp4 \
  -F cover=@COVER_P1_baby-normal-temperature.jpg
# -> { "mediaUrl": "https://ik.imagekit.io/...", "coverUrl": "https://ik.imagekit.io/..." }
```

2. Queue it:

```bash
curl -X POST https://whatsapp-automation.limsapp.in/api/social/posts \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"name":"P1_baby-normal-temperature","mediaType":"reel",
       "mediaUrl":"https://ik.imagekit.io/...","coverUrl":"https://ik.imagekit.io/...",
       "caption":"...","platforms":"both","publishAt":"2026-10-20T10:00:00+05:30"}'
```

`mediaType`: `reel` (9:16 under 90 s) · `video` (longer, feed video) · `photo`.
`platforms`: `fb` · `ig` · `both`. `publishAt` is ISO 8601 — send the offset.

Other endpoints: `GET /api/social/posts?status=pending,failed&limit=50`,
`POST /api/social/posts/:id/cancel`, `POST /api/social/posts/:id/retry`,
and `POST /api/social/run` to force a tick instead of waiting five minutes.

## How a row moves

```
pending ──due──> claimed ──FB published──> (ig wanted?) ──> processing ──> posted
                     │                          │               │
                     │                          no              └─ container ERROR / stuck 45 min ─> failed
                     │                          └──> posted
                     └─ error ─> pending (retry, max 4) ─> failed
                                 └─ FB already out ─> partial
```

Four things worth knowing before changing this:

- **The claim is a conditional UPDATE** (`WHERE status='pending' RETURNING`).
  Two instances run during a deploy; without it both publish the same row, and
  **an Instagram post cannot be deleted through the API**.
- **`partial` never retries.** One platform already has the post, so a retry
  would publish it there a second time. Fix those by hand.
- **Instagram pacing is enforced in the service**, not trusted to the caller:
  @meditrust.clinics was banned once for posting a batch of reels in about an
  hour. A row that is due but too close to the last Instagram post goes back to
  `pending` without burning an attempt, and says so in `error_reason`.
- **Transcoding is not awaited.** An IG container takes 30 s to several minutes;
  the row parks as `processing` and the next tick checks it, so one slow video
  cannot block the queue.

## What the first live run broke (2026-10-19)

First real post: P2_cradle-cap to Instagram, media `18054181304589570`. Two
defects showed up, both fixed, both worth understanding before touching this.

1. **A bare `Date` in a `sql`` ` fragment killed every Instagram publish.** The
   pacing query compared `ig_posted_at` against `sql`…>= ${since}``. An untyped
   parameter carries no column type, so postgres-js throws
   `ERR_INVALID_ARG_TYPE: Received an instance of Date`. Because the pacing check
   runs *before* every IG publish, it failed 100% of them, not some. Use the
   typed helpers (`gte`, `lte`, `eq`) for values; keep `sql`` ` for column
   references and SQL expressions only.

2. **A soft error threw away a good container.** `resumeInstagram` treated any
   `status_code` other than `IN_PROGRESS`/`FINISHED` as fatal, and the loop's
   `catch` called `fail()`. `fail()` sends a not-yet-exhausted row to `pending`
   and nulls `ig_container_id`; the due loop then claimed it and built a *second*
   container, leaving the first orphaned at `FINISHED`. Two containers for one
   row is one unpublished leak at best and a duplicate post at worst. Now only
   `ERROR`/`EXPIRED` are fatal, a transient check failure leaves the row in
   `processing` with its container, and `publish()` refuses to build a container
   for a row that already has one.

Also worth knowing: **`POST /api/social/run` is a no-op while a tick is already
running** (`if (this.running) return`) and still answers `{"ok":true}`. If a
forced tick appears to do nothing, a scheduled tick probably holds the lock —
re-read the row before concluding anything is wrong.

And the **pacing guard only sees posts this queue made**. It reads `ig_posted_at`
from `social_posts`, so a reel posted from `fb_post.py` or the phone is invisible
to it. Reading the account's latest media timestamp from the Graph API instead
would make the ban protection cover every route. Not done yet.

## Known gaps

- Instagram rejects *Facebook CDN* video URLs (error 2207076), which is why the
  local script uses resumable upload. ImageKit URLs are ordinary CDN URLs and
  work, but if Meta ever refuses one, the fallback is porting the resumable
  upload from `D:\fb posting script\fb_post.py`.
- Facebook's reel cover endpoint is undocumented and sometimes refuses the
  image; a rejected cover is logged and the reel still publishes.
- No dashboard UI yet — the API is the interface.

## ImageKit delivery failure and recovery (2026-10-24)

Eight remaining Shoot 2 queue entries failed before Facebook publication because
ImageKit answered `403 Video transformations limit exceeded`. The cover URLs
were healthy. Delivering the existing original videos with `?tr=orig-true` returned
HTTP 206 video/mp4 and recovered access without changing the files or plan.
Use this original-file parameter for these pre-rendered social videos; Meta does
its own video processing. Reference: https://imagekit.io/docs/core-delivery-features

The eight failed combined FB+IG rows were cancelled, preserving their history.
The 12 missing Shoot 2 reels now have separate IG-only queue rows, one per day at
18:30 IST, 24 October through 4 November, all with matching cover URLs. These
explicit row schedules implement the owner's latest slow-Instagram instruction;
service-wide environment settings were not changed. Facebook is published
separately and must not be re-enqueued through those old combined rows.
Per-reel queue IDs and publication results are in the three Shoot 2 batch STATUS.md
files and `D:/fb posting script/reports/shoot2_publish_state.json`.

## MediTrust BP “Comment PDF” request — planned, not implemented (2026-10-25)

The owner chose a comment-keyword offer for the awareness reels: comment `PDF` to request a home BP measurement checklist and seven-day log. This is separate from the WhatsApp Cloud API campaign sender. The existing social scheduler publishes posts only; it currently has no Facebook/Instagram comment webhook consumer or comment-to-private-message handler. The latest recorded Meta check found no Page webhook subscriptions. Instagram messaging and Page messaging permissions were granted on the checked token, but this does not mean the webhook or reply automation exists. No comment-to-PDF automation is enabled, and no live delivery test has been done.

The guide remains a clinical-review draft with no public URL. Do not enable or advertise automatic delivery until Dr. Amit approves the guide and the flagged A2 painkiller wording, a final PDF is hosted and phone-tested, the correct comment webhooks/subscriptions and API access are confirmed, and staff test delivery on both platforms. Until then use manual fulfilment only and do not claim an automatic DM will arrive.

The main task record, prepared A1/A2 review videos, caption, guide, and proposed implementation steps are indexed at `D:\fb posting script\wjatsapp integration\BP_COMMENT_PDF_AUTOMATION.md`.

### WhatsApp keyword delivery (built 2026-10-25, deployed: no)

Comment-to-DM needs Advanced Access for `pages_messaging` /
`instagram_manage_messages`, which this app does not have — those permissions
being present on a token is not the same thing. Asking people to WhatsApp `PDF`
needs no Meta review at all, because the clinic's own WABA already sends, so that
is the delivery route: a prefilled `https://wa.me/916358240913?text=PDF` link puts
the keyword in the sender's compose box, so nobody types an unknown number.

`server/services/GuideRequestService.ts` handles it, hooked into
`processIncomingMessage` as PRIORITY 0.9 — ahead of the HIMS/OPD and lead bots (a
person who asked for the checklist wants the checklist, not an OPD menu), behind
the data-management agent (a doctor's own paperwork keeps priority). Only a short
keyword message is intercepted; every other message on the number reaches the
HIMS bot exactly as it does today, and in `log` mode even the keyword message
does. One `guide_requests` row per request (migration 0018), read back with
`GET /api/social/guide-requests` (super admin). No message text is stored — only
the matched keyword and the number needed to fulfil.

```
GUIDE_REPLY_MODE=off|log|send     off (default) inert · log records only · send replies
GUIDE_REPLY_ORG=<organization_id> required; the only tenant it acts for
GUIDE_REPLY_URL=https://...       the approved, publicly downloadable guide
GUIDE_REPLY_TEXT=...              optional, overrides the whole reply
GUIDE_REPLY_KEYWORDS=PDF          optional, comma separated
GUIDE_REPLY_NAME=bp_home_checklist
GUIDE_REPLY_COOLDOWN_HOURS=24     one automatic reply per number per guide
```

`send` refuses to reply without a URL or text, so the offer cannot go live before
the guide is approved and hosted. Keep it on `log` until then: requests are
recorded and staff fulfil them by hand. Words like `report`, `result`, `bill`,
`prescription` and `xray` disqualify a match, so a patient asking for their own
report pdf reaches staff instead of the guide.

Two things to know before touching this:

- **`AutoResponseService` is dead code, and this service exists because of it.**
  `routes.ts` constructs it with three arguments against a zero-argument
  constructor and nothing calls `setWhatsAppService()`, so `handleIncomingMessage`
  logs "No WhatsApp service set" and returns false for every inbound message. The
  build is esbuild transpile-only (`npm run check` is a separate script), so the
  argument mismatch never broke a deploy. Fixing it would switch on every dormant
  row in `auto_responses` for every tenant at once, so it needs its own decision —
  not a side effect of shipping one guide offer.
- **The reply is text with a link, not the PDF file.** `sendMediaMessage()` wants a
  local file path and nothing on the server holds one. Sending the real document
  means adding a document-by-link send (`type: document`, `document: {link}`) to
  `CloudApiSession`.
