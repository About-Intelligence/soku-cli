/** Collapse the data dispatcher's result envelope to a single layer.
 *
 * `/api/cli/call/*` returns the shared dispatcher envelope `{ ok, data, error }`.
 * Without unwrapping, the CLI's own `emitSuccess` would nest it a second time
 * (`{ ok: true, data: { ok: true, data: ... } }`). Callers pass the raw result
 * through this first so success output is a single `{ ok: true, data: ... }`.
 */

import { emitError, ExitCode, type ExitCodeValue } from './envelope.js'

interface DispatchEnvelope {
  ok: boolean
  data?: unknown
  error?: unknown
}

function isDispatchEnvelope(value: unknown): value is DispatchEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    typeof (value as { ok: unknown }).ok === 'boolean'
  )
}

/** Return the dispatcher's inner `data`, or exit with a structured error when
 * the dispatcher reported `ok: false`. Non-envelope results pass through. */
export function unwrapDispatch(result: unknown): unknown {
  if (!isDispatchEnvelope(result)) return result
  if (result.ok) return result.data ?? null

  const err = result.error
  let message = 'Action failed.'
  let type = 'action_failed'
  let hint: string | undefined
  let exitCode: ExitCodeValue = ExitCode.RUNTIME
  if (typeof err === 'string') {
    message = err
  } else if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>
    type = String(obj.code ?? type)
    message = String(obj.message ?? obj.code ?? JSON.stringify(err))
    hint = obj.hint ? String(obj.hint) : undefined
    exitCode = exitCodeForStatus(obj.status_code)
  }
  return emitError(type, message, exitCode, hint)
}

function exitCodeForStatus(status: unknown): ExitCodeValue {
  if (typeof status !== 'number') return ExitCode.RUNTIME
  if (status === 400 || status === 422) return ExitCode.USAGE
  if (status === 401 || status === 403) return ExitCode.AUTH
  if (status === 404) return ExitCode.NOT_FOUND
  return ExitCode.RUNTIME
}
