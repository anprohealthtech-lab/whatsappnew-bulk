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
