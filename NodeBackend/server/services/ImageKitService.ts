/**
 * ImageKitService — puts an asset on ImageKit and hands back a public URL.
 *
 * Meta fetches media for a post by URL, so the bytes go to ImageKit once and
 * neither Facebook nor Instagram ever downloads them from this server. Uses the
 * plain REST upload endpoint (Basic auth, private key as the username) rather
 * than the SDK, to avoid another dependency.
 *
 * Env: IMAGEKIT_PRIVATE_KEY (required), IMAGEKIT_FOLDER (default /social).
 */

import { log } from '../utils';

const UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';

export class ImageKitError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ImageKitError';
  }
}

export function imageKitConfigured(): boolean {
  return Boolean(process.env.IMAGEKIT_PRIVATE_KEY);
}

/**
 * Upload bytes and return the public URL.
 *
 * `useUniqueFileName` stays on: re-posting the same reel must not overwrite the
 * asset a live post is still serving from.
 */
export async function uploadToImageKit(
  file: Buffer,
  fileName: string,
  contentType = 'application/octet-stream',
): Promise<string> {
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey) {
    throw new ImageKitError('IMAGEKIT_PRIVATE_KEY is not set');
  }

  const form = new FormData();
  form.append('file', new Blob([file], { type: contentType }), fileName);
  form.append('fileName', fileName);
  form.append('folder', process.env.IMAGEKIT_FOLDER || '/social');
  form.append('useUniqueFileName', 'true');

  const response = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      // ImageKit wants the private key as the Basic-auth username, password empty.
      Authorization: `Basic ${Buffer.from(`${privateKey}:`).toString('base64')}`,
    },
    body: form,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ImageKitError(
      `ImageKit upload failed (${response.status}): ${text.slice(0, 300)}`,
      response.status,
    );
  }

  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ImageKitError(`ImageKit returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (!payload?.url) {
    throw new ImageKitError(`ImageKit response had no url: ${text.slice(0, 200)}`);
  }

  log(`[Social] Uploaded ${fileName} to ImageKit (${(file.length / 1e6).toFixed(1)} MB)`);
  return String(payload.url);
}
