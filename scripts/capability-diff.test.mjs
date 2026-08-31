import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMPARED_FIELDS, diffManifests } from './capability-diff.mjs'

const action = (namespace, name, overrides = {}) => ({
  id: `action:${namespace}/${name}`,
  namespace,
  action: name,
  description: 'desc',
  mode: 'read',
  platforms: [namespace],
  requires_review: false,
  freshness_kind: 'realtime',
  see_also: [],
  long_description: 'long',
  input_params: [],
  output_shape: 'data.rows[]',
  ...overrides,
})

test('diffManifests reports additions, removals, and per-field changes', () => {
  const before = { actions: [action('ads', 'keep'), action('ads', 'drop')] }
  const after = {
    actions: [
      action('ads', 'keep', { mode: 'write', output_shape: 'data.id' }),
      action('ga4', 'brand_new'),
    ],
  }

  const diff = diffManifests(before, after)

  assert.deepEqual(diff.counts, { before: 2, after: 2, added: 1, removed: 1, changed: 1 })
  assert.deepEqual(diff.added.map((a) => a.id), ['ga4/brand_new'])
  assert.deepEqual(diff.removed.map((a) => a.id), ['ads/drop'])
  assert.deepEqual(diff.changed, [{ id: 'ads/keep', fields: ['mode', 'output_shape'] }])
})

test('an identical manifest produces an empty diff, not a false positive', () => {
  const manifest = { actions: [action('ads', 'same'), action('ga4', 'same')] }
  const diff = diffManifests(manifest, structuredClone(manifest))
  assert.deepEqual(diff.counts, { before: 2, after: 2, added: 0, removed: 0, changed: 0 })
})

test('every compared field is actually compared', () => {
  // Guards against a field being added to the manifest and silently escaping
  // the diff, which is exactly how a capability change goes unannounced.
  for (const field of COMPARED_FIELDS) {
    const before = { actions: [action('ads', 'x')] }
    const after = { actions: [action('ads', 'x', { [field]: 'MUTATED' })] }
    const diff = diffManifests(before, after)
    assert.deepEqual(
      diff.changed,
      [{ id: 'ads/x', fields: [field] }],
      `${field} was not detected as changed`,
    )
  }
})

test('an empty predecessor makes every action an addition', () => {
  const diff = diffManifests({ actions: [] }, { actions: [action('ads', 'first')] })
  assert.equal(diff.counts.added, 1)
  assert.equal(diff.counts.before, 0)
})

test('a manifest with no actions key is treated as empty, not a crash', () => {
  const diff = diffManifests({}, { actions: [action('ads', 'only')] })
  assert.equal(diff.counts.added, 1)
})
