import assert from 'node:assert/strict'
import { test } from 'node:test'

import { matchRef } from './resolve.js'

const items = [
  { id: 'id-a', slug: 'acme-1', name: 'Acme' },
  { id: 'id-b', slug: 'acme-2', name: 'Acme' }, // same name as id-a
  { id: 'id-c', slug: 'globex', name: 'Globex' },
]

test('exact id wins', () => {
  const r = matchRef(items, 'id-c')
  assert.equal(r.kind, 'match')
  assert.equal(r.kind === 'match' && r.item.id, 'id-c')
})

test('exact slug wins (even when names collide)', () => {
  const r = matchRef(items, 'acme-2')
  assert.equal(r.kind, 'match')
  assert.equal(r.kind === 'match' && r.item.id, 'id-b')
})

test('unique name matches case-insensitively', () => {
  const r = matchRef(items, 'globex')
  assert.equal(r.kind, 'match')
  assert.equal(r.kind === 'match' && r.item.id, 'id-c')
})

test('duplicate name is ambiguous, not silently first', () => {
  const r = matchRef(items, 'Acme')
  assert.equal(r.kind, 'ambiguous')
  assert.equal(r.kind === 'ambiguous' && r.matches.length, 2)
})

test('unknown ref is none', () => {
  assert.equal(matchRef(items, 'nope').kind, 'none')
})
