/** Typed data-action sub-commands, generated from the capability manifest.
 *
 * The manifest (`src/generated/capabilities.json`, produced by
 * `scripts/gen_cli_capabilities.py`) is an offline snapshot of the backend
 * ActionSpec registry's full CLI surface — read + write + risk actions across
 * every granted resource. It is generated in-process (no live API / auth), and
 * a CI guard (`tests/unit/test_cli_capability_manifest_sync.py`) fails if it
 * drifts from the registry. Each action becomes a sub-command under its
 * namespace (e.g. `soku ads query-single-dimension`), with one flag per input
 * param; review-gated writes get an injected `--summary`. `--help` on any
 * command is the shell-native equivalent of the old `capabilities describe`.
 * The raw `soku call` command remains as a forward-compat escape hatch for
 * actions not yet in a published manifest.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Command } from 'commander'

import { apiRequest } from '../http/client.js'
import { dim, emitError, emitSuccess, ExitCode, renderHumanData } from '../output/envelope.js'
import { unwrapDispatch } from '../output/unwrap.js'

export interface ManifestParam {
  name: string
  type: string
  required: boolean
  description: string
  example?: unknown
}

export interface ManifestAction {
  id: string
  namespace: string
  action: string
  description: string
  long_description: string | null
  mode: string
  platforms: string[]
  requires_review: boolean
  freshness_kind: string
  input_params: ManifestParam[]
  output_shape: string | null
  see_also: string[]
}

export interface CapabilityManifest {
  actions: ManifestAction[]
}

function toKebab(name: string): string {
  return name.replace(/_/g, '-')
}

function toCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function isJsonType(type: string): boolean {
  // object / list, plus unions that include either (e.g. "string|list").
  return /\b(object|list)\b/.test(type)
}

function isNumberType(type: string): boolean {
  return type === 'integer' || type === 'number'
}

function parseJsonFlag(param: string, raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return emitError('usage', `--${toKebab(param)} must be valid JSON.`, ExitCode.USAGE)
  }
}

function parseNumberFlag(param: string, raw: string): number {
  const n = Number(raw)
  if (Number.isNaN(n)) {
    return emitError('usage', `--${toKebab(param)} must be a number.`, ExitCode.USAGE)
  }
  return n
}

/** Short tag describing an action's write semantics, shown in `--help`. */
function modeBadge(spec: ManifestAction): string {
  if (spec.mode === 'risk') {
    return '[risk] mutates live ad state — proposes a review; approve with `soku review approve <id>`'
  }
  if (spec.mode === 'write') {
    return spec.requires_review
      ? '[write] proposes a review; approve with `soku review approve <id>`'
      : '[write] executes immediately'
  }
  return ''
}

/** POST a data action and emit its result. Shared by the generated commands and
 * the hand-written Tier-2 entity commands (`commands/ads.ts`). */
export async function callTypedAction(
  namespace: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<never> {
  const result = await apiRequest(
    `/api/cli/call/${encodeURIComponent(namespace)}/${encodeURIComponent(action)}`,
    { method: 'POST', body: payload, workspace: true },
  )
  return emitActionResult(result, action)
}

/** Normalize a data-action result and emit it. Review-gated writes return 202 +
 * a pending-review id; we surface a unified `review_id` (not the wire
 * `pending_review_id`) with the approve hint, instead of letting
 * `unwrapDispatch` treat the non-envelope body as opaque data. Non-review
 * writes and reads pass through. Exported so `soku call` reuses the same
 * normalization. */
export function emitActionResult(result: unknown, action?: string): never {
  if (
    result &&
    typeof result === 'object' &&
    (result as { status?: unknown }).status === 'pending_review'
  ) {
    const r = result as { pending_review_id?: string; summary?: string }
    return emitSuccess(
      { status: 'pending_review', review_id: r.pending_review_id, summary: r.summary },
      (d) =>
        `Pending review ${d.review_id}\n  ${dim('Approve with:')} soku review approve ${d.review_id}`,
    )
  }
  // An empty `rows` array on a query action is usually "no spend/activities in
  // range" or "wrong dimension/metric selection" — surface a hint so the caller
  // (human or agent) doesn't mistake it for a broken query. gaql_search returns
  // `columns`/`rows` too but its own help already warns; limit to cached queries.
  if (action && action.startsWith('query_') && isEmptyRowsResult(result)) {
    const data = unwrapDispatch(result)
    return emitSuccess(data, () =>
      `${renderHumanData(data)}\n${dim('(no rows — try --mode summary, widen the date range, or run `soku ads list-dimensions` to confirm the dimension)')}`,
    )
  }
  return emitSuccess(unwrapDispatch(result))
}

/** True when a query result body has a `rows` array that is present but empty. */
function isEmptyRowsResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const rows = (result as { rows?: unknown }).rows
  return Array.isArray(rows) && rows.length === 0
}

function actionHelpSuffix(spec: ManifestAction): string {
  const typedName = `${spec.namespace} ${toKebab(spec.action)}`
  const rawName = `${spec.namespace} ${spec.action}`
  const naming = `Typed CLI command: soku ${typedName}\nRaw call action: soku call ${rawName}`
  if (spec.namespace === 'ads' && spec.action === 'gaql_search') {
    return [
      'FALLBACK WARNING:',
      'Prefer cached ads analytics first: `soku ads list-dimensions`, then `soku ads query-single-dimension` or `soku ads query-multi-dimension`.',
      'Use GAQL only for Google-native fields or segment combinations not covered by cached query actions. If fields are unknown, run `soku ads get-resource-metadata` before this command.',
      '',
      naming,
    ].join('\n')
  }
  return naming
}

/** Load the committed manifest shipped alongside the compiled CLI. */
export function loadManifest(): CapabilityManifest {
  const path = fileURLToPath(new URL('../generated/capabilities.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as CapabilityManifest
}

export interface BuildOptions {
  /** Only render these namespaces (allowlist). */
  namespaces?: string[]
  /** Skip these namespaces (e.g. `ads`, which has a dedicated registrar). */
  exclude?: string[]
}

/** Register one namespace group + typed sub-command per manifest action.
 *
 * Returns the namespace → group map so a caller (e.g. `commands/ads.ts`) can
 * attach extra hand-written sub-commands to the same group instead of creating
 * a second, conflicting `command(namespace)`.
 */
export function buildGeneratedCommands(
  program: Command,
  manifest: CapabilityManifest,
  opts: BuildOptions = {},
): Map<string, Command> {
  const groups = new Map<string, Command>()
  const groupFor = (namespace: string): Command => {
    let group = groups.get(namespace)
    if (!group) {
      group = program.command(namespace).description(`${namespace} data capabilities`)
      groups.set(namespace, group)
    }
    return group
  }

  const actions = manifest.actions.filter((spec) => {
    if (opts.namespaces && !opts.namespaces.includes(spec.namespace)) return false
    if (opts.exclude && opts.exclude.includes(spec.namespace)) return false
    return true
  })

  for (const spec of actions) {
    const cmd = groupFor(spec.namespace).command(toKebab(spec.action))
    cmd.description(
      [modeBadge(spec), spec.description, spec.long_description, actionHelpSuffix(spec)]
        .filter(Boolean)
        .join('\n\n'),
    )

    for (const param of spec.input_params) {
      const flag = `--${toKebab(param.name)}`
      const desc = param.description || param.name
      if (param.type === 'boolean') {
        cmd.option(flag, desc)
        continue
      }
      const valueFlag = `${flag} <value>`
      const coerce = isJsonType(param.type)
        ? (v: string) => parseJsonFlag(param.name, v)
        : isNumberType(param.type)
          ? (v: string) => parseNumberFlag(param.name, v)
          : undefined
      if (param.required) {
        if (coerce) cmd.requiredOption(valueFlag, desc, coerce)
        else cmd.requiredOption(valueFlag, desc)
      } else {
        if (coerce) cmd.option(valueFlag, desc, coerce)
        else cmd.option(valueFlag, desc)
      }
    }

    // Review-gated actions carry a mandatory `--summary`: the server stores it
    // as the human-readable review card header (`_summary`). Non-review writes
    // (e.g. upload_image) and reads never get this flag.
    if (spec.requires_review) {
      cmd.requiredOption(
        '--summary <text>',
        'Human-readable description of this write; becomes the review approval card header',
      )
    }

    cmd.action(async (opts: Record<string, unknown>) => {
      const payload: Record<string, unknown> = {}
      for (const param of spec.input_params) {
        const value = opts[toCamel(param.name)]
        if (value !== undefined) payload[param.name] = value
      }
      if (spec.requires_review && typeof opts.summary === 'string') {
        payload._summary = opts.summary
      }
      await callTypedAction(spec.namespace, spec.action, payload)
    })
  }

  return groups
}

export function registerGeneratedCommands(program: Command): void {
  // `ads` has a dedicated registrar (commands/ads.ts) that owns the `ads` group
  // and adds Tier-2 entity sub-commands, so it is excluded here to avoid a
  // duplicate `command('ads')`.
  buildGeneratedCommands(program, loadManifest(), { exclude: ['ads'] })
}
