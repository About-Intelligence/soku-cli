#!/usr/bin/env node
/**
 * Diff two capability manifests and print the change set as JSON.
 *
 * The manifest is regenerated from the monorepo whenever the capability surface
 * moves, but a bare "253 actions now, 183 before" tells nobody what to do. This
 * turns two manifests into the list an upgrader actually needs: what appeared,
 * what disappeared, and which fields of a surviving action changed.
 *
 *   node scripts/capability-diff.mjs <old.json> <new.json>
 *
 * Reads `-` as stdin for either argument. Exits 0 whether or not anything
 * changed; an empty diff is a valid answer, not a failure.
 */

import { readFileSync } from 'node:fs'

/** Fields whose change an upgrader must notice. Ordered for stable output. */
export const COMPARED_FIELDS = [
  'description',
  'long_description',
  'mode',
  'platforms',
  'requires_review',
  'freshness_kind',
  'input_params',
  'output_shape',
  'see_also',
]

function actionKey(action) {
  return `${action.namespace}/${action.action}`
}

function byKey(manifest) {
  const map = new Map()
  for (const action of manifest.actions ?? []) map.set(actionKey(action), action)
  return map
}

/** Deep value comparison via canonical JSON; manifest values are plain data. */
function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

export function diffManifests(oldManifest, newManifest) {
  const before = byKey(oldManifest)
  const after = byKey(newManifest)

  const added = []
  const removed = []
  const changed = []

  for (const [key, action] of after) {
    if (!before.has(key)) {
      added.push({ id: key, mode: action.mode ?? null, description: action.description ?? null })
      continue
    }
    const previous = before.get(key)
    const fields = COMPARED_FIELDS.filter((field) => !sameValue(previous[field], action[field]))
    if (fields.length > 0) changed.push({ id: key, fields })
  }
  for (const [key, action] of before) {
    if (!after.has(key)) {
      removed.push({ id: key, mode: action.mode ?? null, description: action.description ?? null })
    }
  }

  const sortById = (a, b) => a.id.localeCompare(b.id)
  added.sort(sortById)
  removed.sort(sortById)
  changed.sort(sortById)

  return {
    counts: {
      before: before.size,
      after: after.size,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
    },
    added,
    removed,
    changed,
  }
}

function readManifest(path) {
  const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8')
  return JSON.parse(text)
}

function main() {
  const [oldPath, newPath] = process.argv.slice(2)
  if (!oldPath || !newPath) {
    process.stderr.write('usage: capability-diff.mjs <old.json> <new.json>\n')
    process.exit(2)
  }
  const diff = diffManifests(readManifest(oldPath), readManifest(newPath))
  process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`)
}

// Only run when invoked directly, so the diff stays importable from tests.
if (import.meta.url === `file://${process.argv[1]}`) main()
