import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  stampChangelog,
  stampPackage,
  stampSkill,
  stampVersionTs,
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
