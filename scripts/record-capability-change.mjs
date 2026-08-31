#!/usr/bin/env node
/**
 * Fold a capability diff into the changelog's `unreleased` entry.
 *
 * Called by the monorepo's capability-sync workflow with the manifest that is
 * about to replace the committed one. Without this step the manifest would keep
 * moving between releases and the changelog would only ever describe the
 * versions someone remembered to write up by hand.
 *
 *   node scripts/record-capability-change.mjs <new-manifest.json>
 *
 * Accumulates: a second sync before the next release merges into the same
 * `unreleased` entry rather than replacing it, so no intermediate change is
 * lost. Exits 0 and writes nothing when the manifest did not move.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { diffManifests } from './capability-diff.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(REPO_ROOT, 'src/generated/capabilities.json')
const CHANGELOG_PATH = join(REPO_ROOT, 'src/generated/changelog.json')
const UNRELEASED = 'unreleased'

/** Merge a newer diff into an existing one, over the whole unreleased window.
 *
 * Cancellation is judged across the entire window, not against the newest sync
 * alone: an action that appeared and disappeared between two releases is
 * something no user of a published version can observe, so it belongs in
 * neither list.
 */
export function mergeDiffs(previous, next) {
  const dedupe = (rows) => {
    const byId = new Map()
    for (const row of rows) byId.set(row.id, row)
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  const allAdded = dedupe([...previous.added, ...next.added])
  const allRemoved = dedupe([...previous.removed, ...next.removed])
  const addedIds = new Set(allAdded.map((r) => r.id))
  const removedIds = new Set(allRemoved.map((r) => r.id))
  // Present in both lists ⇒ it came and went inside this window; net zero.
  const cancelled = new Set([...addedIds].filter((id) => removedIds.has(id)))

  const added = allAdded.filter((r) => !cancelled.has(r.id))
  const removed = allRemoved.filter((r) => !cancelled.has(r.id))

  const changedById = new Map()
  for (const row of [...previous.changed, ...next.changed]) {
    const existing = changedById.get(row.id)
    const fields = new Set([...(existing?.fields ?? []), ...row.fields])
    changedById.set(row.id, { id: row.id, fields: [...fields].sort() })
  }
  // An action that is new or gone in this window is already fully described by
  // that fact; also calling it "changed" would double-count it.
  const changed = [...changedById.values()]
    .filter((row) => !addedIds.has(row.id) && !removedIds.has(row.id))
    .sort((a, b) => a.id.localeCompare(b.id))

  return {
    counts: {
      // `before` is the oldest baseline seen; `after` is the newest state.
      before: previous.counts.before,
      after: next.counts.after,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
    },
    added,
    removed,
    changed,
  }
}

export function recordChange(changelog, diff) {
  const entries = [...changelog.entries]
  const index = entries.findIndex((entry) => entry.version === UNRELEASED)
  if (index === -1) {
    entries.unshift({
      version: UNRELEASED,
      date: null,
      notes: [],
      commands: { added: [], changed: [], removed: [] },
      capabilities: diff,
    })
    return { ...changelog, entries }
  }
  entries[index] = {
    ...entries[index],
    capabilities: mergeDiffs(entries[index].capabilities, diff),
  }
  return { ...changelog, entries }
}

function main() {
  const [newManifestPath] = process.argv.slice(2)
  if (!newManifestPath) {
    process.stderr.write('usage: record-capability-change.mjs <new-manifest.json>\n')
    process.exit(2)
  }
  const current = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const next = JSON.parse(readFileSync(newManifestPath, 'utf8'))
  const diff = diffManifests(current, next)
  if (diff.counts.added === 0 && diff.counts.removed === 0 && diff.counts.changed === 0) {
    process.stdout.write('capability manifest unchanged; changelog left alone\n')
    return
  }
  const changelog = JSON.parse(readFileSync(CHANGELOG_PATH, 'utf8'))
  writeFileSync(CHANGELOG_PATH, `${JSON.stringify(recordChange(changelog, diff), null, 2)}\n`)
  process.stdout.write(
    `changelog updated: +${diff.counts.added} -${diff.counts.removed} ~${diff.counts.changed}\n`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
