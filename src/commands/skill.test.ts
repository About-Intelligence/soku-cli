import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Command } from 'commander'

import { isSafeSlug, loadManifest, registerSkillCommand, saveManifest } from './skill.js'

test('accepts normal skill slugs', () => {
  for (const slug of ['account-audit', 'google-ads', 'ga4', 'a', 'skill-creator', 'meta-ads']) {
    assert.ok(isSafeSlug(slug), `expected ${slug} to be safe`)
  }
})

test('rejects traversal, separators, and malformed slugs', () => {
  for (const slug of [
    '../evil',
    'a/b',
    '..',
    'foo/',
    '/abs',
    'a\\b',
    '',
    ' ',
    'Foo', // uppercase
    '-leading', // must start alphanumeric
    'x'.repeat(65), // exceeds length cap
  ]) {
    assert.ok(!isSafeSlug(slug), `expected ${JSON.stringify(slug)} to be rejected`)
  }
})

test('removes the manifest file when all Soku-managed skills are gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soku-skill-manifest-'))
  const path = join(dir, '.soku-skills.json')

  try {
    saveManifest(dir, {
      soku: {
        sha256: '',
        installed_at: '2026-06-02T00:00:00.000Z',
        source: 'bundled',
      },
    })

    assert.equal(existsSync(path), true)
    assert.deepEqual(Object.keys(loadManifest(dir)), ['soku'])

    saveManifest(dir, {})

    assert.equal(existsSync(path), false)
    assert.deepEqual(loadManifest(dir), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installed skill listing uses status/list-installed and hides legacy installed alias', () => {
  const program = new Command()
  registerSkillCommand(program)
  const skill = program.commands.find((cmd) => cmd.name() === 'skill')
  assert.ok(skill)

  assert.equal(skill.commands.some((cmd) => cmd.name() === 'status'), true)
  assert.equal(skill.commands.some((cmd) => cmd.name() === 'list-installed'), true)
  assert.equal(skill.commands.some((cmd) => cmd.name() === 'installed'), true)
  assert.doesNotMatch(skill.helpInformation(), /\n\s+installed\s/)
})
