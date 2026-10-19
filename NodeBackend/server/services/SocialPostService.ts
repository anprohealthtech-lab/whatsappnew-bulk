/**
 * SocialPostService — publishes queued Facebook/Instagram posts at their due time.
 *
 * Rows land in `social_posts` (see socialPostRoutes). A periodic tick picks up
 * anything due and publishes it, so a scheduled post no longer depends on
 * someone's PC being awake.
 *
 * Facebook can schedule natively, but Instagram cannot — the Graph API has no
 * scheduling for IG at all, which is the whole reason this queue exists.
 * Publishing to Instagram is also asynchronous: you create a container, Meta
 * transcodes the video (seconds to minutes), and only then can you publish it.
 * Waiting inside one tick would block every other row, so a row that is mid
 * transcode is parked as `processing` with its container id and re-checked on
 * the next tick.
 *
 * Media is never streamed from this server: both platforms fetch the asset from
 * the public ImageKit URL stored on the row. The one exception is a reel cover
 * on Facebook, whose endpoint only takes an uploaded file — those are ~200 KB.
 *
 * Env: SOCIAL_FB_PAGE_ID, SOCIAL_FB_TOKEN (long-lived user token),
 *      SOCIAL_IG_USER_ID, SOCIAL_TICK_MS (default 5 min),
 *      IG_MAX_POSTS_PER_DAY (default 3), IG_MIN_GAP_MINUTES (default 180).
 */

import { and, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import { socialPosts } from '@shared/schema';
import type { SocialPost } from '@shared/schema';
import { log } from '../utils';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const RUPLOAD_BASE = `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}`;

const DEFAULT_TICK_MS = 5 * 60 * 1000;
// A row that cannot be published after this many tries is parked, not retried forever.
const MAX_ATTEMPTS = 4;
// Instagram transcoding that has not finished by now is never going to.
const CONTAINER_STALE_MS = 45 * 60 * 1000;

export class SocialPostError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function graph(
  method: 'GET' | 'POST',
  pathname: string,
  params: Record<string, string>,
): Promise<any> {
  const url = new URL(`${GRAPH_BASE}/${pathname}`);
  const init: RequestInit = { method };

  if (method === 'GET') {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  } else {
    init.body = new URLSearchParams(params);
  }

  const response = await fetch(url.toString(), init);
  const text = await response.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new SocialPostError(`Graph returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok || payload?.error) {
    const err = payload?.error || {};
    const parts = [err.message || `HTTP ${response.status}`];
    if (err.code) parts.push(`code ${err.code}`);
    if (err.error_subcode) parts.push(`subcode ${err.error_subcode}`);
    throw new SocialPostError(parts.join(' · '));
  }
  return payload;
}

export class SocialPostService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pageTokenCache: { pageId: string; token: string } | null = null;

  configured(): boolean {
    return Boolean(process.env.SOCIAL_FB_PAGE_ID && process.env.SOCIAL_FB_TOKEN);
  }

  startScheduler(): void {
    if (this.timer) return;
    if (!this.configured()) {
      log('⚠️ Social post scheduler not started — SOCIAL_FB_PAGE_ID / SOCIAL_FB_TOKEN not set');
      return;
    }
    const tick = Number(process.env.SOCIAL_TICK_MS) || DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      this.runDue().catch((error) => log(`❌ Social post tick failed: ${errorMessage(error)}`));
    }, tick);
    log(`⏰ Social post scheduler started (${Math.round(tick / 1000)}s tick)`);
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * The Page token is derived from the long-lived user token, exactly as the
   * local fb_post.py does. Both never expire, so one lookup per process is enough.
   */
  private async pageToken(): Promise<string> {
    const pageId = String(process.env.SOCIAL_FB_PAGE_ID);
    const userToken = String(process.env.SOCIAL_FB_TOKEN);
    if (this.pageTokenCache?.pageId === pageId) return this.pageTokenCache.token;

    const result = await graph('GET', pageId, {
      fields: 'access_token',
      access_token: userToken,
    });
    if (!result?.access_token) {
      throw new SocialPostError(`No Page token returned for page ${pageId} — check the token's pages_* scopes`);
    }
    this.pageTokenCache = { pageId, token: String(result.access_token) };
    return this.pageTokenCache.token;
  }

  // ---- the tick ------------------------------------------------------------

  async runDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Containers already handed to Instagram come first: they are closer to
      // done than anything still pending, and each only costs a status check.
      const processing = await db.select().from(socialPosts)
        .where(eq(socialPosts.status, 'processing'));
      for (const row of processing) {
        try {
          await this.resumeInstagram(row);
        } catch (error) {
          await this.fail(row, `instagram publish: ${errorMessage(error)}`);
        }
      }

      const due = await db.select().from(socialPosts)
        .where(and(eq(socialPosts.status, 'pending'), lte(socialPosts.publishAt, new Date())))
        .orderBy(socialPosts.publishAt);

      for (const row of due) {
        // Conditional update = the claim. Two app instances during a deploy
        // would otherwise both publish the row, and an Instagram post cannot be
        // deleted through the API.
        const [claimed] = await db.update(socialPosts)
          .set({
            status: 'claimed',
            attempts: sql`${socialPosts.attempts} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(socialPosts.id, row.id), eq(socialPosts.status, 'pending')))
          .returning();
        if (!claimed) continue;

        try {
          await this.publish(claimed);
        } catch (error) {
          await this.fail(claimed, errorMessage(error));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async publish(row: SocialPost): Promise<void> {
    const wantsFb = row.platforms === 'fb' || row.platforms === 'both';
    const wantsIg = row.platforms === 'ig' || row.platforms === 'both';

    // Facebook first: it is synchronous, so a failure there is known before
    // Instagram (which cannot be undone) is touched.
    if (wantsFb && !row.fbVideoId) {
      const fbId = await this.postToFacebook(row);
      await db.update(socialPosts)
        .set({ fbVideoId: fbId, fbPostedAt: new Date(), updatedAt: new Date() })
        .where(eq(socialPosts.id, row.id));
      log(`[Social] ${row.name}: Facebook ${fbId}`);
    }

    if (!wantsIg) {
      await db.update(socialPosts)
        .set({ status: 'posted', errorReason: null, updatedAt: new Date() })
        .where(eq(socialPosts.id, row.id));
      return;
    }

    const hold = await this.instagramPacingHold();
    if (hold) {
      // Back to pending: the row is due, Instagram simply is not ready for it.
      // Don't burn an attempt on a deliberate wait.
      await db.update(socialPosts)
        .set({
          status: 'pending',
          attempts: sql`greatest(${socialPosts.attempts} - 1, 0)`,
          errorReason: hold,
          updatedAt: new Date(),
        })
        .where(eq(socialPosts.id, row.id));
      log(`[Social] ${row.name}: holding Instagram — ${hold}`);
      return;
    }

    const containerId = await this.createInstagramContainer(row);
    await db.update(socialPosts)
      .set({ status: 'processing', igContainerId: containerId, errorReason: null, updatedAt: new Date() })
      .where(eq(socialPosts.id, row.id));
    log(`[Social] ${row.name}: Instagram container ${containerId} transcoding`);
  }

  // ---- Facebook ------------------------------------------------------------

  private async postToFacebook(row: SocialPost): Promise<string> {
    const token = await this.pageToken();
    const pageId = String(process.env.SOCIAL_FB_PAGE_ID);

    if (row.mediaType === 'photo') {
      const result = await graph('POST', `${pageId}/photos`, {
        url: row.mediaUrl,
        caption: row.caption,
        access_token: token,
      });
      return String(result.post_id || result.id);
    }

    if (row.mediaType === 'video') {
      const result = await graph('POST', `${pageId}/videos`, {
        file_url: row.mediaUrl,
        description: row.caption,
        access_token: token,
      });
      return String(result.id);
    }

    // Reels are a three-phase upload. The transfer phase accepts a `file_url`
    // header, so Facebook pulls the file from ImageKit itself.
    const start = await graph('POST', `${pageId}/video_reels`, {
      upload_phase: 'start',
      access_token: token,
    });
    const videoId = String(start.video_id);

    const transfer = await fetch(`${RUPLOAD_BASE}/${videoId}`, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${token}`,
        file_url: row.mediaUrl,
      },
    });
    if (!transfer.ok) {
      const body = await transfer.text();
      throw new SocialPostError(`Reel transfer failed (${transfer.status}): ${body.slice(0, 300)}`);
    }

    if (row.coverUrl) await this.setReelCover(videoId, row.coverUrl, token);

    await graph('POST', `${pageId}/video_reels`, {
      upload_phase: 'finish',
      video_id: videoId,
      video_state: 'PUBLISHED',
      description: row.caption,
      access_token: token,
    });
    return videoId;
  }

  /**
   * The thumbnails endpoint takes an uploaded file, not a URL, so the cover is
   * the only asset this server fetches. It is undocumented for Reels and
   * Facebook sometimes refuses it — a rejected cover must not lose the reel.
   */
  private async setReelCover(videoId: string, coverUrl: string, token: string): Promise<void> {
    try {
      const image = await fetch(coverUrl);
      if (!image.ok) throw new SocialPostError(`cover fetch failed (${image.status})`);
      const bytes = Buffer.from(await image.arrayBuffer());

      const form = new FormData();
      form.append('is_preferred', 'true');
      form.append('access_token', token);
      form.append('source', new Blob([bytes], { type: 'image/jpeg' }), 'cover.jpg');

      const response = await fetch(`${GRAPH_BASE}/${videoId}/thumbnails`, {
        method: 'POST',
        body: form,
      });
      if (!response.ok) {
        const body = await response.text();
        log(`[Social] Facebook did not accept the cover for ${videoId}: ${body.slice(0, 200)}`);
      }
    } catch (error) {
      log(`[Social] Cover upload skipped for ${videoId}: ${errorMessage(error)}`);
    }
  }

  // ---- Instagram -----------------------------------------------------------

  /**
   * @meditrust.clinics was banned once for posting a batch of reels in about an
   * hour, so the pacing rule is enforced here rather than trusted to whoever
   * fills the queue.
   */
  private async instagramPacingHold(): Promise<string | null> {
    const maxPerDay = Number(process.env.IG_MAX_POSTS_PER_DAY ?? 3);
    const minGapMinutes = Number(process.env.IG_MIN_GAP_MINUTES ?? 180);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(socialPosts)
      // gte(), not a sql`` fragment: a bare Date interpolated into sql`` carries no
      // column type, and postgres-js then refuses to serialise it ("Received an
      // instance of Date"). That failed every Instagram publish on 2026-10-19.
      .where(and(isNotNull(socialPosts.igPostedAt), gte(socialPosts.igPostedAt, since)));
    if (count >= maxPerDay) {
      return `Instagram daily cap reached (${count}/${maxPerDay} in the last 24 h)`;
    }

    const [last] = await db.select({ at: socialPosts.igPostedAt })
      .from(socialPosts)
      .where(isNotNull(socialPosts.igPostedAt))
      .orderBy(desc(socialPosts.igPostedAt))
      .limit(1);
    if (last?.at) {
      const gapMinutes = (Date.now() - new Date(last.at).getTime()) / 60000;
      if (gapMinutes < minGapMinutes) {
        return `last Instagram post was ${Math.round(gapMinutes)} min ago, minimum gap is ${minGapMinutes} min`;
      }
    }
    return null;
  }

  private async createInstagramContainer(row: SocialPost): Promise<string> {
    const igUserId = process.env.SOCIAL_IG_USER_ID;
    if (!igUserId) throw new SocialPostError('SOCIAL_IG_USER_ID is not set');
    const token = await this.pageToken();

    const params: Record<string, string> = { caption: row.caption, access_token: token };
    if (row.mediaType === 'photo') {
      params.image_url = row.mediaUrl;
    } else {
      params.media_type = 'REELS';
      params.video_url = row.mediaUrl;
      if (row.coverUrl) params.cover_url = row.coverUrl;
    }

    const result = await graph('POST', `${igUserId}/media`, params);
    if (!result?.id) throw new SocialPostError('Instagram did not return a container id');
    return String(result.id);
  }

  /** Check a transcoding container and publish it once Meta says it is ready. */
  private async resumeInstagram(row: SocialPost): Promise<void> {
    if (!row.igContainerId) {
      await this.fail(row, 'row is processing but has no Instagram container id');
      return;
    }
    const igUserId = String(process.env.SOCIAL_IG_USER_ID);
    const token = await this.pageToken();

    const status = await graph('GET', row.igContainerId, {
      fields: 'status_code,status',
      access_token: token,
    });
    const code = String(status.status_code || '');

    if (code === 'IN_PROGRESS') {
      const age = Date.now() - new Date(row.updatedAt || row.createdAt || Date.now()).getTime();
      if (age > CONTAINER_STALE_MS) {
        await this.fail(row, `Instagram container stuck in IN_PROGRESS for ${Math.round(age / 60000)} min`);
      }
      return;
    }
    if (code !== 'FINISHED') {
      await this.fail(row, `Instagram container ${code || 'unknown'}: ${status.status || ''}`.trim());
      return;
    }

    const published = await graph('POST', `${igUserId}/media_publish`, {
      creation_id: row.igContainerId,
      access_token: token,
    });
    const mediaId = String(published.id);

    let permalink: string | null = null;
    try {
      const info = await graph('GET', mediaId, { fields: 'permalink', access_token: token });
      permalink = info?.permalink ? String(info.permalink) : null;
    } catch {
      // A missing permalink is cosmetic; the post is already live.
    }

    await db.update(socialPosts)
      .set({
        status: 'posted',
        igMediaId: mediaId,
        igPermalink: permalink,
        igPostedAt: new Date(),
        igContainerId: null,
        errorReason: null,
        updatedAt: new Date(),
      })
      .where(eq(socialPosts.id, row.id));
    log(`[Social] ${row.name}: Instagram ${mediaId}${permalink ? ` ${permalink}` : ''}`);
  }

  // ---- failure handling ----------------------------------------------------

  private async fail(row: SocialPost, reason: string): Promise<void> {
    const attempts = row.attempts ?? 0;
    const exhausted = attempts >= MAX_ATTEMPTS;
    // A post that reached one platform but not the other is `partial`, never
    // `pending` — retrying would publish the successful side twice.
    const half = Boolean(row.fbVideoId) && row.platforms === 'both';
    const status = exhausted || half ? (half ? 'partial' : 'failed') : 'pending';

    await db.update(socialPosts)
      .set({ status, errorReason: reason, igContainerId: null, updatedAt: new Date() })
      .where(eq(socialPosts.id, row.id));
    log(`[Social] ${row.name}: ${status} — ${reason}`);
  }
}

export const socialPostService = new SocialPostService();
