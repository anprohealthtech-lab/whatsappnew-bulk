/**
 * Routes for the scheduled Facebook/Instagram post queue.
 *
 *  POST /api/social/assets            Upload video/cover to ImageKit, returns public URLs
 *  POST /api/social/posts             Queue a post for a given publish time
 *  GET  /api/social/posts             List queued/finished posts (?status=&limit=)
 *  POST /api/social/posts/:id/cancel  Cancel one that has not gone out yet
 *  POST /api/social/posts/:id/retry   Put a failed one back in the queue
 *  POST /api/social/run               Run a scheduler tick now (for testing)
 *
 * Super admin only: these publish to the clinic's own Page and Instagram
 * account using the server's token, not any tenant's.
 *
 * Env: see SocialPostService (Meta) and ImageKitService (asset hosting).
 */

import type { Express, Request, Response } from 'express';
import multer from 'multer';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
import { socialPosts } from '@shared/schema';
import { log } from './utils';
import { requireSuperAdmin, getTenant } from './authMiddleware';
import { imageKitConfigured, uploadToImageKit } from './services/ImageKitService';
import { socialPostService } from './services/SocialPostService';

// Reels run 20-80 MB, well past the 10 MB cap the message-attachment uploader
// uses, so this endpoint gets its own limit.
const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.SOCIAL_MAX_ASSET_BYTES) || 200 * 1024 * 1024 },
});

const enqueueSchema = z.object({
  name: z.string().min(1),
  mediaType: z.enum(['reel', 'video', 'photo']).default('reel'),
  mediaUrl: z.string().url(),
  coverUrl: z.string().url().optional(),
  caption: z.string().min(1),
  platforms: z.enum(['fb', 'ig', 'both']).default('both'),
  publishAt: z.string().min(1),
});

const CANCELLABLE = ['pending', 'failed', 'partial'];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export function registerSocialPostRoutes(app: Express) {
  app.post(
    '/api/social/assets',
    requireSuperAdmin,
    assetUpload.fields([{ name: 'media', maxCount: 1 }, { name: 'cover', maxCount: 1 }]),
    async (req: Request, res: Response) => {
      if (!imageKitConfigured()) {
        return res.status(503).json({ error: 'IMAGEKIT_PRIVATE_KEY is not configured' });
      }
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const media = files?.media?.[0];
      const cover = files?.cover?.[0];
      if (!media && !cover) {
        return res.status(400).json({ error: 'Attach a "media" and/or "cover" file' });
      }

      try {
        const out: { mediaUrl?: string; coverUrl?: string } = {};
        if (media) {
          out.mediaUrl = await uploadToImageKit(media.buffer, media.originalname, media.mimetype);
        }
        if (cover) {
          out.coverUrl = await uploadToImageKit(cover.buffer, cover.originalname, cover.mimetype);
        }
        return res.json(out);
      } catch (error) {
        log(`[Social] Asset upload failed: ${errorMessage(error)}`);
        return res.status(502).json({ error: errorMessage(error) });
      }
    },
  );

  app.post('/api/social/posts', requireSuperAdmin, async (req: Request, res: Response) => {
    const parsed = enqueueSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
    }
    const body = parsed.data;

    const publishAt = new Date(body.publishAt);
    if (Number.isNaN(publishAt.getTime())) {
      return res.status(400).json({ error: 'publishAt is not a valid date (use ISO 8601)' });
    }
    if (body.mediaType === 'photo' && body.coverUrl) {
      return res.status(400).json({ error: 'coverUrl applies to video posts only' });
    }
    if (!socialPostService.configured()) {
      return res.status(503).json({ error: 'SOCIAL_FB_PAGE_ID / SOCIAL_FB_TOKEN are not configured' });
    }

    const tenant = getTenant(req);
    const [row] = await db.insert(socialPosts).values({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      name: body.name,
      mediaType: body.mediaType,
      mediaUrl: body.mediaUrl,
      coverUrl: body.coverUrl ?? null,
      caption: body.caption,
      platforms: body.platforms,
      publishAt,
    }).returning();

    log(`[Social] Queued ${row.name} for ${publishAt.toISOString()} (${row.platforms})`);
    return res.status(201).json(row);
  });

  app.get('/api/social/posts', requireSuperAdmin, async (req: Request, res: Response) => {
    const status = req.query.status ? String(req.query.status).split(',') : null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const rows = status
      ? await db.select().from(socialPosts)
          .where(inArray(socialPosts.status, status))
          .orderBy(desc(socialPosts.publishAt)).limit(limit)
      : await db.select().from(socialPosts)
          .orderBy(desc(socialPosts.publishAt)).limit(limit);

    return res.json({ posts: rows });
  });

  app.post('/api/social/posts/:id/cancel', requireSuperAdmin, async (req: Request, res: Response) => {
    // Only rows that have not reached a platform: `processing` is already in
    // Instagram's hands and `posted` cannot be undone through the API at all.
    const [row] = await db.update(socialPosts)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(socialPosts.id, req.params.id), inArray(socialPosts.status, CANCELLABLE)))
      .returning();

    if (!row) {
      return res.status(409).json({ error: `Only ${CANCELLABLE.join('/')} posts can be cancelled` });
    }
    return res.json(row);
  });

  app.post('/api/social/posts/:id/retry', requireSuperAdmin, async (req: Request, res: Response) => {
    // `partial` is excluded on purpose: one platform already has the post, so a
    // retry would publish it there twice.
    const [row] = await db.update(socialPosts)
      .set({ status: 'pending', attempts: 0, errorReason: null, updatedAt: new Date() })
      .where(and(eq(socialPosts.id, req.params.id), inArray(socialPosts.status, ['failed', 'cancelled'])))
      .returning();

    if (!row) {
      return res.status(409).json({ error: 'Only failed or cancelled posts can be retried' });
    }
    return res.json(row);
  });

  app.post('/api/social/run', requireSuperAdmin, async (_req: Request, res: Response) => {
    try {
      await socialPostService.runDue();
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: errorMessage(error) });
    }
  });
}
