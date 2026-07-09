import { strict as assert } from 'node:assert'
import test from 'node:test'

import { zipSync } from 'fflate'

import { safeUnzip, UnzipError } from './unzip.js'

function makeZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder()
  const obj: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) obj[name] = enc.encode(content)
  return zipSync(obj)
}

test('strips a single top folder and exposes SKILL.md at root', () => {
  const zip = makeZip({
    'account-audit/SKILL.md': '# Audit',
    'account-audit/references/notes.md': 'ref',
  })
  const out = safeUnzip(zip)
  assert.ok(out.has('SKILL.md'), 'SKILL.md should be at stripped root')
  assert.ok(out.has('references/notes.md'))
  assert.equal(new TextDecoder().decode(out.get('SKILL.md')), '# Audit')
})

test('keeps a flat layout when there is no single top folder', () => {
  const zip = makeZip({ 'SKILL.md': '# Flat', 'extra.md': 'x' })
  const out = safeUnzip(zip)
  assert.ok(out.has('SKILL.md'))
  assert.ok(out.has('extra.md'))
})

test('rejects a bundle missing SKILL.md', () => {
  const zip = makeZip({ 'my-skill/other.md': 'x' })
  assert.throws(() => safeUnzip(zip), UnzipError)
})

test('rejects path traversal', () => {
  const zip = makeZip({ 'SKILL.md': 'x', '../evil.md': 'pwned' })
  assert.throws(() => safeUnzip(zip), UnzipError)
})

test('rejects a disallowed extension', () => {
  const zip = makeZip({ 'SKILL.md': 'x', 'run.sh': '#!/bin/sh' })
  assert.throws(() => safeUnzip(zip), UnzipError)
})

test('rejects corrupt zip bytes', () => {
  assert.throws(() => safeUnzip(new Uint8Array([1, 2, 3, 4])), UnzipError)
})
