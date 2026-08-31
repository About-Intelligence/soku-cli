/** Thin fetch wrapper that injects the bearer token + active workspace headers,
 * and translates the server's auth errors into the CLI's exit-code contract. */

import { clearToken, loadToken } from '../auth/store.js'
import { loadConfig, resolveApiBaseUrl } from '../config.js'
import { emitError, ExitCode, type ExitCodeValue } from '../output/envelope.js'

interface RequestOptions {
  method?: string
  body?: unknown
  /** Require the active org/brand headers (data endpoints). */
  workspace?: boolean
  apiBase?: string
  /**
   * Throw {@link ApiError} instead of printing and exiting.
   *
   * The default is to exit, which is right for a one-shot command: the error
   * envelope is the output. It is wrong inside a batch, where one file's
   * transient 503 would take down a run of hundreds and leave the caller no
   * chance to retry it. Batch callers set this and handle the error themselves.
   */
  throwOnError?: boolean
}

/** A failed request, raised only when the caller asked for `throwOnError`. */
export class ApiError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = await loadToken()
  if (!token) {
    emitError(
      'not_authenticated',
      'No Soku session found.',
      ExitCode.AUTH,
      'Run `soku auth login` (or set SOKU_TOKEN).',
    )
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
  // FormData (multipart, e.g. asset upload) sets its own Content-Type with the
  // boundary — leave it unset so fetch fills it in; JSON bodies are stringified.
  const isFormData = opts.body instanceof FormData
  if (opts.body !== undefined && !isFormData) headers['Content-Type'] = 'application/json'

  if (opts.workspace) {
    const cfg = loadConfig()
    const orgId = process.env.SOKU_ORG_ID || cfg.activeOrgId
    const brandId = process.env.SOKU_BRAND_ID || cfg.activeBrandId
    if (!orgId || !brandId) {
      emitError(
        'no_workspace',
        'No active workspace selected.',
        ExitCode.USAGE,
        'Run `soku org use <id>` then `soku brand use <id>`.',
      )
    }
    headers['X-Soku-Org'] = orgId
    headers['X-Soku-Brand'] = brandId
  }

  const base = resolveApiBaseUrl(opts.apiBase)
  // Status 0 marks a failure that never reached the server, so a caller
  // classifying retriability sees "no answer" rather than a fabricated code.
  const fail = (type: string, message: string, status: number, code: ExitCodeValue, hint?: string): never => {
    if (opts.throwOnError) throw new ApiError(type, message, status, hint)
    return emitError(type, message, code, hint)
  }
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body:
        opts.body === undefined
          ? undefined
          : isFormData
            ? (opts.body as FormData)
            : JSON.stringify(opts.body),
    })
  } catch (err) {
    return fail(
      'network_error',
      `Could not reach ${base}: ${(err as Error).message}`,
      0,
      ExitCode.RUNTIME,
      'Behind a proxy? Set ALL_PROXY.',
    )
  }

  const text = await res.text()
  const parsed = text ? safeJson(text) : null

  if (res.status === 401) {
    // Any 401 means this token is no longer usable (expired, revoked, deleted
    // key, or rotated signing key). Drop it so the next run re-authenticates
    // cleanly instead of looping on a dead credential.
    const code = (parsed as { error?: string } | null)?.error ?? 'unauthorized'
    await clearToken()
    return fail(
      'unauthorized',
      `Authentication failed (${code}).`,
      res.status,
      ExitCode.AUTH,
      'Run `soku auth login`.',
    )
  }
  if (res.status === 403) {
    return fail('forbidden', describeError(parsed) ?? 'Access denied.', res.status, ExitCode.AUTH)
  }
  if (res.status === 404) {
    return fail(
      'not_found',
      describeError(parsed) ?? 'Not found.',
      res.status,
      ExitCode.NOT_FOUND,
    )
  }
  if (res.status >= 400) {
    return fail(
      describeCode(parsed) ?? 'request_failed',
      describeError(parsed) ?? `HTTP ${res.status}`,
      res.status,
      exitCodeForStatus(res.status),
      describeHint(parsed) ?? undefined,
    )
  }

  return parsed as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function describeError(parsed: unknown): string | null {
  const detail = detailObject(parsed)
  const responseErr = responseSchemaError(detail)
  if (responseErr?.message) return String(responseErr.message)
  if (detail?.message) return String(detail.message)
  const err = dispatcherErrorObject(parsed)
  if (err?.message) return String(err.message)
  if (err?.code) return String(err.code)
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (obj.error) return String(obj.error)
    if (obj.message) return String(obj.message)
  }
  return null
}

function describeCode(parsed: unknown): string | null {
  const detail = detailObject(parsed)
  const responseErr = responseSchemaError(detail)
  if (responseErr?.code) return String(responseErr.code)
  if (detail?.error) return String(detail.error)
  if (detail?.code) return String(detail.code)
  const err = dispatcherErrorObject(parsed)
  if (err?.code) return String(err.code)
  return null
}

function describeHint(parsed: unknown): string | null {
  const detail = detailObject(parsed)
  const responseErr = responseSchemaError(detail)
  if (responseErr?.hint) return String(responseErr.hint)
  if (detail?.hint) return String(detail.hint)
  const err = dispatcherErrorObject(parsed)
  if (err?.hint) return String(err.hint)
  return null
}

function detailObject(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const detail = (parsed as Record<string, unknown>).detail
  return detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : null
}

function dispatcherErrorObject(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const error = (parsed as Record<string, unknown>).error
  return error && typeof error === 'object' ? (error as Record<string, unknown>) : null
}

function responseSchemaError(detail: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!detail) return null
  const error = detail.error
  return error && typeof error === 'object' ? (error as Record<string, unknown>) : null
}

function exitCodeForStatus(status: number): ExitCodeValue {
  if (status === 400 || status === 422) return ExitCode.USAGE
  if (status === 401 || status === 403) return ExitCode.AUTH
  if (status === 404) return ExitCode.NOT_FOUND
  return ExitCode.RUNTIME
}
