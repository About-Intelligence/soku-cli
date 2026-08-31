import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeDiffs, recordChange } from './record-capability-change.mjs'

const ref = (id) => ({ id, mode: 'read', description: 'd' })
const emptyDiff = () => ({
  counts: { before: 0, after: 0, added: 0, removed: 0, changed: 0 },
  added: [],
  removed: [],
  changed: [],
})

test('mergeDiffs accumulates two syncs instead of overwriting the first', () => {
  const first = {
    counts: { before: 10, after: 11, added: 1, removed: 0, changed: 0 },
    added: [ref('ads/one')],
    removed: [],
    changed: [],
  }
  const second = {
    counts: { before: 11, after: 12, added: 1, removed: 0, changed: 0 },
    added: [ref('ads/two')],
    removed: [],
    changed: [],
  }

  const merged = mergeDiffs(first, second)

  assert.deepEqual(merged.added.map((r) => r.id), ['ads/one', 'ads/two'])
  // The window spans both syncs: oldest baseline to newest state.
  assert.equal(merged.counts.before, 10)
  assert.equal(merged.counts.after, 12)
})

test('an action added then removed before release cancels out', () => {
  // Nobody could ever have used it, so announcing both halves would describe a
  // change that never reached a published version.
  const first = {
    counts: { before: 5, after: 6, added: 1, removed: 0, changed: 0 },
    added: [ref('ads/shortlived')],
    removed: [],
    changed: [],
  }
  const second = {
    counts: { before: 6, after: 5, added: 0, removed: 1, changed: 0 },
    added: [],
    removed: [ref('ads/shortlived')],
    changed: [],
  }

  const merged = mergeDiffs(first, second)

  assert.deepEqual(merged.added, [])
  assert.deepEqual(merged.removed, [])
  assert.equal(merged.counts.added, 0)
  assert.equal(merged.counts.removed, 0)
})

test('field-level changes to the same action union rather than replace', () => {
  const first = {
    counts: { before: 3, after: 3, added: 0, removed: 0, changed: 1 },
    added: [],
    removed: [],
    changed: [{ id: 'ads/x', fields: ['mode'] }],
  }
  const second = {
    counts: { before: 3, after: 3, added: 0, removed: 0, changed: 1 },
    added: [],
    removed: [],
    changed: [{ id: 'ads/x', fields: ['output_shape'] }],
  }

  assert.deepEqual(mergeDiffs(first, second).changed, [
    { id: 'ads/x', fields: ['mode', 'output_shape'] },
  ])
})

test('a change to an action added in the same window is folded into the addition', () => {
  const first = {
    counts: { before: 1, after: 2, added: 1, removed: 0, changed: 0 },
    added: [ref('ads/fresh')],
    removed: [],
    changed: [],
  }
  const second = {
    counts: { before: 2, after: 2, added: 0, removed: 0, changed: 1 },
    added: [],
    removed: [],
    changed: [{ id: 'ads/fresh', fields: ['description'] }],
  }

  const merged = mergeDiffs(first, second)

  // It is new either way; listing it as "changed" too would double-count it.
  assert.deepEqual(merged.added.map((r) => r.id), ['ads/fresh'])
  assert.deepEqual(merged.changed, [])
})

test('recordChange creates an unreleased entry when the changelog has none', () => {
  const changelog = { schemaVersion: 1, historyStartsAt: '0.1.0-alpha.15', entries: [] }
  const diff = { ...emptyDiff(), added: [ref('ads/new')], counts: { before: 0, after: 1, added: 1, removed: 0, changed: 0 } }

  const next = recordChange(changelog, diff)

  assert.equal(next.entries[0].version, 'unreleased')
  assert.deepEqual(next.entries[0].capabilities.added.map((r) => r.id), ['ads/new'])
  assert.deepEqual(next.entries[0].commands, { added: [], changed: [], removed: [] })
})

test('recordChange keeps hand-written notes on the existing unreleased entry', () => {
  const changelog = {
    schemaVersion: 1,
    historyStartsAt: '0.1.0-alpha.15',
    entries: [
      {
        version: 'unreleased',
        date: null,
        notes: ['a note somebody wrote'],
        commands: { added: ['automation pause'], changed: [], removed: [] },
        capabilities: emptyDiff(),
      },
    ],
  }
  const diff = { ...emptyDiff(), added: [ref('ads/new')], counts: { before: 0, after: 1, added: 1, removed: 0, changed: 0 } }

  const next = recordChange(changelog, diff)

  // A bot sync must not wipe what a person wrote in the same entry.
  assert.deepEqual(next.entries[0].notes, ['a note somebody wrote'])
  assert.deepEqual(next.entries[0].commands.added, ['automation pause'])
  assert.deepEqual(next.entries[0].capabilities.added.map((r) => r.id), ['ads/new'])
})
