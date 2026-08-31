import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Command } from 'commander'

import { CLI_VERSION } from '../version.js'
import {
  UNRELEASED,
  loadChangelog,
  registerChangelogCommand,
  renderChangelog,
  selectEntries,
  type Changelog,
  type ChangelogEntry,
} from './changelog.js'

function entry(version: string, overrides: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    version,
    date: '2026-08-01',
    notes: [],
    commands: { added: [], changed: [], removed: [] },
    capabilities: {
      counts: { before: 1, after: 2, added: 1, removed: 0, changed: 0 },
      added: [{ id: 'ads/new_action', mode: 'read', description: 'A new one.' }],
      removed: [],
      changed: [],
    },
    ...overrides,
  }
}

const CHANGELOG: Changelog = {
  schemaVersion: 1,
  historyStartsAt: '0.1.0-alpha.15',
  entries: [
    entry(UNRELEASED, { date: null }),
    entry('0.1.0-alpha.17'),
    entry('0.1.0-alpha.16'),
    entry('0.1.0-alpha.15'),
  ],
}

test('selectEntries without --since returns the whole file', () => {
  const { entries, truncated } = selectEntries(CHANGELOG)
  assert.equal(entries.length, 4)
  assert.equal(truncated, false)
})

test('selectEntries returns only versions newer than --since', () => {
  const { entries } = selectEntries(CHANGELOG, '0.1.0-alpha.16')
  assert.deepEqual(
    entries.map((e) => e.version),
    [UNRELEASED, '0.1.0-alpha.17'],
  )
})

test('unreleased always counts as newer than any published version', () => {
  const { entries } = selectEntries(CHANGELOG, '0.1.0-alpha.17')
  assert.deepEqual(
    entries.map((e) => e.version),
    [UNRELEASED],
  )
})

test('selectEntries flags a --since older than the recorded history', () => {
  // The alpha.14 manifest is not in this repo, so answering for it would be a
  // guess. The flag makes the gap visible instead.
  const { truncated } = selectEntries(CHANGELOG, '0.1.0-alpha.14')
  assert.equal(truncated, true)
  assert.equal(selectEntries(CHANGELOG, '0.1.0-alpha.15').truncated, false)
})

test('renderChangelog states the history gap when the range was truncated', () => {
  const rendered = renderChangelog({
    cliVersion: '0.1.0-alpha.17',
    since: '0.1.0-alpha.14',
    truncated: true,
    historyStartsAt: '0.1.0-alpha.15',
    entries: [entry('0.1.0-alpha.16')],
  })
  assert.match(rendered, /starts at 0\.1\.0-alpha\.15/)
  assert.match(rendered, /ads\/new_action/)
})

test('renderChangelog says so plainly when nothing changed', () => {
  const rendered = renderChangelog({
    cliVersion: '0.1.0-alpha.17',
    since: '0.1.0-alpha.17',
    truncated: false,
    historyStartsAt: '0.1.0-alpha.15',
    entries: [],
  })
  assert.match(rendered, /No recorded changes/)
})

test('the bundled changelog loads and describes this repository real history', () => {
  const changelog = loadChangelog()
  assert.equal(changelog.schemaVersion, 1)
  assert.equal(changelog.historyStartsAt, '0.1.0-alpha.15')
  const versions = changelog.entries.map((e) => e.version)
  // The invariant is an entry for the version being shipped, NOT the presence
  // of an `unreleased` entry: right after a release there is none, and there is
  // one again as soon as the next capability sync records something. Asserting
  // on `unreleased` would fail on exactly the commit that cuts a release.
  assert.ok(
    versions.includes(CLI_VERSION),
    `changelog has no entry for the shipping version ${CLI_VERSION}; run scripts/stamp-release.mjs`,
  )
  assert.ok(versions.includes('0.1.0-alpha.17'))
  // Every non-baseline entry must carry a real diff, not a placeholder.
  for (const item of changelog.entries) {
    if (item.capabilities.baseline) continue
    assert.equal(
      item.capabilities.counts.added,
      item.capabilities.added.length,
      `${item.version}: added count disagrees with the listed actions`,
    )
    assert.equal(
      item.capabilities.counts.removed,
      item.capabilities.removed.length,
      `${item.version}: removed count disagrees with the listed actions`,
    )
    assert.equal(
      item.capabilities.counts.changed,
      item.capabilities.changed.length,
      `${item.version}: changed count disagrees with the listed actions`,
    )
  }
})

test('changelog is registered as a top-level command with --since', () => {
  const program = new Command()
  registerChangelogCommand(program)
  const cmd = program.commands.find((c) => c.name() === 'changelog')
  assert.ok(cmd)
  assert.ok(cmd.options.some((opt) => opt.long === '--since'))
  assert.ok(cmd.options.some((opt) => opt.long === '--summary'))
})
