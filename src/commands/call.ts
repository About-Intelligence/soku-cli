/** `soku call <namespace> <action> [--payload '<json>' | -p key=value ...]` */

import { Command } from 'commander'

import { apiRequest } from '../http/client.js'
import { emitError, ExitCode } from '../output/envelope.js'
import { emitActionResult } from './generated.js'

export function registerCallCommand(program: Command): void {
  program
    .command('call <namespace> <action>')
    .description('Invoke a data capability')
    .option('--payload <json>', 'Full JSON payload')
    .option(
      '-p, --param <key=value>',
      'Set one payload field (repeatable); values are parsed as JSON when possible',
      collectParam,
      {} as Record<string, unknown>,
    )
    .option(
      '--summary <text>',
      'Human-readable summary; required for review-gated write actions (becomes the HITL approval description)',
    )
    .action(
      async (
        namespace: string,
        action: string,
        opts: { payload?: string; param: Record<string, unknown>; summary?: string },
      ) => {
        let payload: Record<string, unknown> = {}
        if (opts.payload) {
          try {
            payload = JSON.parse(opts.payload) as Record<string, unknown>
          } catch {
            emitError('usage', '--payload must be valid JSON.', ExitCode.USAGE)
          }
        }
        payload = { ...payload, ...opts.param }
        // Review-gated write actions return a pending review; the server reads
        // `_summary` as the human-facing approval description.
        if (opts.summary) payload._summary = opts.summary

        const result = await apiRequest(
          `/api/cli/call/${encodeURIComponent(namespace)}/${encodeURIComponent(action)}`,
          { method: 'POST', body: payload, workspace: true },
        )
        // Use the same result normalization as the typed commands so a
        // review-gated write surfaces a unified `review_id` (with the approve
        // hint) rather than the raw `pending_review_id` wire field.
        emitActionResult(result, action)
      },
    )
}

function collectParam(entry: string, acc: Record<string, unknown>): Record<string, unknown> {
  const eq = entry.indexOf('=')
  if (eq === -1) {
    emitError('usage', `--param must be key=value, got: ${entry}`, ExitCode.USAGE)
  }
  const key = entry.slice(0, eq)
  const raw = entry.slice(eq + 1)
  let value: unknown = raw
  try {
    value = JSON.parse(raw)
  } catch {
    value = raw // keep as string
  }
  acc[key] = value
  return acc
}
