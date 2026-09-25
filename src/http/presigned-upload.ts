/** The two-step upload every Soku file surface uses: POST to mint a signed URL,
 * then PUT the bytes straight to storage.
 *
 * Shared by the Context Hub upload (`soku context upload`) and ad media uploads
 * (`soku ads meta asset upload-video`, `soku ads meta ad deploy-videos`), so a
 * transient failure is retried the same way wherever a file is sent. The mint
 * and the PUT are retried separately: a signed URL survives a failed PUT, and
 * minting again would only hand out a second key for the same bytes.
 */

import { ApiError, apiRequest } from './client.js'

/** How many attempts a single file gets before the run gives up on it. */
export const DEFAULT_UPLOAD_ATTEMPTS = 3

/** Failures worth retrying: the request never reached a decision, or the server
 * said it could not answer *right now*. A 4xx other than 408/429 is a decision
 * (bad path, unauthorized, too large) and retrying it only wastes time. */
export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/** Exponential backoff with jitter, capped so a long batch cannot stall.
 * Jitter matters here specifically: without it, a concurrent pool that trips a
 * rate limit retries in lockstep and trips it again. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000)
  return Math.round(base * (0.5 + random() * 0.5))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Retriable-failure marker, so `withRetries` can tell a transient error from a
 * permanent one without parsing message strings. */
export class TransientUploadError extends Error {}

export async function withRetries<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run()
    } catch (err) {
      lastError = err as Error
      if (!(err instanceof TransientUploadError) || attempt === attempts) throw lastError
      await sleep(retryDelayMs(attempt))
    }
  }
  throw lastError ?? new Error('upload failed')
}

/** A workspace-scoped API POST, retried when the failure was transient. */
export async function postWithRetries<T>(
  path: string,
  body: Record<string, unknown>,
  attempts: number = DEFAULT_UPLOAD_ATTEMPTS,
): Promise<T> {
  return withRetries(attempts, async () => {
    try {
      return await apiRequest<T>(path, {
        method: 'POST',
        body,
        workspace: true,
        // Without this the client exits the process on any error, so one
        // file's transient 503 would end a run of many.
        throwOnError: true,
      })
    } catch (err) {
      // status 0 means the request never reached the server.
      if (err instanceof ApiError && (err.status === 0 || isRetriableStatus(err.status))) {
        throw new TransientUploadError(err.message)
      }
      throw err
    }
  })
}

/** PUT bytes to a presigned URL. The URL carries its own auth; `contentType`
 * must be the one signed when the URL was minted. */
export async function putWithRetries(
  url: string,
  contentType: string,
  bytes: Buffer,
  attempts: number = DEFAULT_UPLOAD_ATTEMPTS,
): Promise<void> {
  await withRetries(attempts, async () => {
    let putRes: Response
    try {
      putRes = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: new Uint8Array(bytes),
      })
    } catch (err) {
      // The request never got an answer — the classic transient case.
      throw new TransientUploadError(`PUT failed: ${(err as Error).message}`)
    }
    if (putRes.ok) return
    const message = `PUT failed (HTTP ${putRes.status})`
    if (isRetriableStatus(putRes.status)) throw new TransientUploadError(message)
    throw new Error(message)
  })
}
