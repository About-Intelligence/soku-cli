/** Put a local ad media file in Soku and get back a `media_asset_id`.
 *
 * Ads uploads are review-gated, and a person may approve hours after the agent
 * asked. A signed link to the file (`soku files publish`) expires long before
 * that; a media asset does not. So a local file goes to Soku first — presign,
 * PUT straight to storage, confirm — and the ads write carries only the id. The
 * URL Meta downloads from is signed by the server when the approved write runs.
 *
 * Server side: `POST /api/cli/media/uploads` and `/api/cli/media/uploads/confirm`.
 */

import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

import {
  DEFAULT_UPLOAD_ATTEMPTS,
  postWithRetries,
  putWithRetries,
} from '../http/presigned-upload.js'

export type MediaKind = 'video' | 'image'

const MEDIA_UPLOAD_PATH = '/api/cli/media/uploads'
const MEDIA_CONFIRM_PATH = '/api/cli/media/uploads/confirm'

/** Extension → MIME for the formats Meta takes as ad media. The type signed at
 * presign must match the PUT header exactly, so it is decided once here. */
const MEDIA_MIME: Record<string, { kind: MediaKind; type: string }> = {
  '.mp4': { kind: 'video', type: 'video/mp4' },
  '.m4v': { kind: 'video', type: 'video/x-m4v' },
  '.mov': { kind: 'video', type: 'video/quicktime' },
  '.webm': { kind: 'video', type: 'video/webm' },
  '.png': { kind: 'image', type: 'image/png' },
  '.jpg': { kind: 'image', type: 'image/jpeg' },
  '.jpeg': { kind: 'image', type: 'image/jpeg' },
  '.gif': { kind: 'image', type: 'image/gif' },
  '.webp': { kind: 'image', type: 'image/webp' },
}

/** The Content-Type to upload `path` with, or an error message when the file
 * is not a `kind` this command can send. */
export function mediaContentType(path: string, kind: MediaKind): string | { error: string } {
  const entry = MEDIA_MIME[extname(path).toLowerCase()]
  if (!entry || entry.kind !== kind) {
    const accepted = Object.entries(MEDIA_MIME)
      .filter(([, value]) => value.kind === kind)
      .map(([ext]) => ext)
      .join(', ')
    return { error: `${basename(path)} is not a supported ${kind} file (${accepted})` }
  }
  return entry.type
}

interface PresignResponse {
  upload_url: string
  object_key: string
  content_type: string
}

export interface UploadedMedia {
  media_asset_id: string
  kind: MediaKind
  size_bytes: number
  content_type: string
  filename: string
}

/** Upload one local file; throws with a readable message when it cannot. */
export async function uploadMediaFile(
  path: string,
  kind: MediaKind,
  attempts: number = DEFAULT_UPLOAD_ATTEMPTS,
): Promise<UploadedMedia> {
  const contentType = mediaContentType(path, kind)
  if (typeof contentType !== 'string') throw new Error(contentType.error)
  const filename = basename(path)
  let bytes: Buffer
  try {
    const size = statSync(path).size
    if (size === 0) throw new Error('the file is empty')
    bytes = readFileSync(path)
  } catch (err) {
    throw new Error(`${filename}: read failed: ${(err as Error).message}`)
  }
  const presigned = await postWithRetries<PresignResponse>(
    MEDIA_UPLOAD_PATH,
    { filename, content_type: contentType, size: bytes.length, kind },
    attempts,
  )
  await putWithRetries(presigned.upload_url, presigned.content_type, bytes, attempts)
  // Registration is idempotent on the key, so a retried confirm is safe.
  return postWithRetries<UploadedMedia>(
    MEDIA_CONFIRM_PATH,
    {
      object_key: presigned.object_key,
      filename,
      kind,
      content_type: presigned.content_type,
    },
    attempts,
  )
}
