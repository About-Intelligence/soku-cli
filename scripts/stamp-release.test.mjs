import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MARKETPLACE_MANIFEST,
  PLUGIN_MANIFESTS,
  stampChangelog,
  stampMarketplace,
  stampPackage,
  stampPluginManifest,
  stampSkill,
  stampVersionTs,
  versionProblems,
} from './stamp-release.mjs'

test('stampPackage rewrites only the package version field', () => {
  const before = '{\n  "name": "@soku-ai/cli",\n  "version": "0.1.0-alpha.17",\n  "type": "module"\n}'
  const after = stampPackage(before, '0.1.0-alpha.18')
  assert.equal(JSON.parse(after).version, '0.1.0-alpha.18')
  assert.equal(JSON.parse(after).name, '@soku-ai/cli')
})

test('stampVersionTs rewrites CLI_VERSION and leaves the package name alone', () => {
  const before =
    "export const CLI_PACKAGE_NAME = '@soku-ai/cli'\nexport const CLI_VERSION = '0.1.0-alpha.17'\n"
  const after = stampVersionTs(before, '0.1.0-alpha.18')
  assert.match(after, /CLI_VERSION = '0\.1\.0-alpha\.18'/)
  assert.match(after, /CLI_PACKAGE_NAME = '@soku-ai\/cli'/)
})

test('stampSkill rewrites the cliVersion frontmatter field', () => {
  const before = 'metadata:\n  version: "0.5"\n  cliVersion: "0.1.0-alpha.17"\n'
  const after = stampSkill(before, '0.1.0-alpha.18')
  assert.match(after, /cliVersion: "0\.1\.0-alpha\.18"/)
  // The skill's own doc version is independent and must not be touched.
  assert.match(after, /version: "0\.5"/)
})

const changelog = (entries) => ({ schemaVersion: 1, historyStartsAt: '0.1.0-alpha.15', entries })

test('stampChangelog names and dates the unreleased entry, keeping its content', () => {
  const before = changelog([
    { version: 'unreleased', date: null, notes: ['did a thing'], commands: { added: ['x'] } },
    { version: '0.1.0-alpha.17', date: '2026-08-03', notes: [] },
  ])
  const after = stampChangelog(before, '0.1.0-alpha.18', '2026-08-31')

  assert.equal(after.entries[0].version, '0.1.0-alpha.18')
  assert.equal(after.entries[0].date, '2026-08-31')
  assert.deepEqual(after.entries[0].notes, ['did a thing'])
  assert.deepEqual(after.entries[0].commands, { added: ['x'] })
  // Order is preserved: newest first.
  assert.equal(after.entries[1].version, '0.1.0-alpha.17')
})

test('stampChangelog refuses a release with nothing recorded', () => {
  // Either the changelog was already stamped, or a version is going out with no
  // record of what changed in it. Both need a human, not a silent empty entry.
  assert.throws(
    () => stampChangelog(changelog([{ version: '0.1.0-alpha.17', date: '2026-08-03' }]), '0.1.0-alpha.18', '2026-08-31'),
    /no "unreleased" entry/,
  )
})

test('stampChangelog refuses to stamp a version that already exists', () => {
  assert.throws(
    () =>
      stampChangelog(
        changelog([
          { version: 'unreleased', date: null },
          { version: '0.1.0-alpha.18', date: '2026-08-30' },
        ]),
        '0.1.0-alpha.18',
        '2026-08-31',
      ),
    /already has an entry/,
  )
})

test('every marketplace plugin manifest is on disk and carries a version', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = join(import.meta.dirname, '..')
  for (const file of [...PLUGIN_MANIFESTS, MARKETPLACE_MANIFEST]) {
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'))
    assert.equal(manifest.name, 'soku', `${file} must be the soku plugin`)
    if (file === MARKETPLACE_MANIFEST) {
      assert.ok(manifest.plugins.every((p) => typeof p.version === 'string'), `${file} entries need a version`)
    } else {
      assert.match(manifest.version, /^\d+\.\d+\.\d+/, `${file} needs a semver version`)
    }
  }
})

test('stampPluginManifest rewrites only the top-level version', () => {
  const before = '{\n  "name": "soku",\n  "version": "0.1.0-alpha.17",\n  "skills": ["./skills/soku/"]\n}'
  const after = JSON.parse(stampPluginManifest(before, '0.1.0-alpha.18'))
  assert.equal(after.version, '0.1.0-alpha.18')
  assert.deepEqual(after.skills, ['./skills/soku/'])
})

test('stampMarketplace rewrites each plugin entry and leaves the catalog alone', () => {
  const before = JSON.stringify({
    name: 'soku',
    version: '1',
    plugins: [{ name: 'soku', source: './', version: '0.1.0-alpha.17' }],
  })
  const after = JSON.parse(stampMarketplace(before, '0.1.0-alpha.18'))
  assert.equal(after.version, '1')
  assert.equal(after.plugins[0].version, '0.1.0-alpha.18')
  assert.equal(after.plugins[0].source, './')
})

test('versionProblems reports a plugin manifest left on an older version', () => {
  const consistent = {
    pkg: '0.1.0-alpha.18',
    src: '0.1.0-alpha.18',
    skill: '0.1.0-alpha.18',
    changelog: changelog([{ version: '0.1.0-alpha.18', date: '2026-08-31' }]),
    plugins: [{ file: '.claude-plugin/plugin.json', version: '0.1.0-alpha.18' }],
    marketplace: [{ file: '.claude-plugin/marketplace.json (soku)', version: '0.1.0-alpha.18' }],
  }
  assert.deepEqual(versionProblems(consistent), [])

  const stale = {
    ...consistent,
    plugins: [{ file: '.cursor-plugin/plugin.json', version: '0.1.0-alpha.17' }],
  }
  assert.deepEqual(versionProblems(stale), [
    '.cursor-plugin/plugin.json version 0.1.0-alpha.17 != package.json 0.1.0-alpha.18',
  ])
})
