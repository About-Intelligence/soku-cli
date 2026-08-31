import { mkdtempSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  JOURNAL_RETENTION_DAYS,
  deleteJournal,
  journalDir,
  listJournals,
  loadJournal,
  newRunId,
  pendingEntries,
  pruneJournals,
  saveJournal,
  type UploadJournal,
} from './upload-journal.js'

/** Journals resolve under $HOME, so each test gets its own home directory. */
function isolateHome(): void {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'soku-journal-'))
}

function makeJournal(overrides: Partial<UploadJournal> = {}): UploadJournal {
  const now = new Date().toISOString()
  return {
    runId: newRunId(),
    createdAt: now,
    updatedAt: now,
    orgId: 'org-1',
    brandId: 'brand-1',
    dir: 'docs',
    entries: [
      { localPath: '/x/a.md', targetDir: 'docs', filename: 'a.md', status: 'done' },
      { localPath: '/x/b.md', targetDir: 'docs', filename: 'b.md', status: 'failed', error: 'boom' },
      { localPath: '/x/c.md', targetDir: 'docs', filename: 'c.md', status: 'pending' },
    ],
    ...overrides,
  }
}

test('a saved journal round-trips through disk', () => {
  isolateHome()
  const journal = makeJournal()
  saveJournal(journal)

  const loaded = loadJournal(journal.runId)
  assert.ok(loaded)
  assert.equal(loaded.runId, journal.runId)
  assert.equal(loaded.brandId, 'brand-1')
  assert.equal(loaded.entries.length, 3)
})

test('pendingEntries returns everything not confirmed done', () => {
  // A failed file and a file the run never reached are both work left to do;
  // only a confirmed upload may be skipped on resume.
  assert.deepEqual(
    pendingEntries(makeJournal()).map((e) => e.filename),
    ['b.md', 'c.md'],
  )
})

test('loading an unknown run id returns null rather than throwing', () => {
  isolateHome()
  assert.equal(loadJournal('no-such-run'), null)
})

test('deleteJournal removes the file and is safe to call twice', () => {
  isolateHome()
  const journal = makeJournal()
  saveJournal(journal)
  deleteJournal(journal.runId)
  assert.equal(loadJournal(journal.runId), null)
  deleteJournal(journal.runId)
})

test('listJournals returns newest first', () => {
  isolateHome()
  const older = makeJournal({ createdAt: '2026-08-01T00:00:00.000Z' })
  const newer = makeJournal({ createdAt: '2026-08-30T00:00:00.000Z' })
  saveJournal(older)
  saveJournal(newer)

  assert.deepEqual(
    listJournals().map((j) => j.runId),
    [newer.runId, older.runId],
  )
})

test('pruneJournals drops entries past the retention window and keeps fresh ones', () => {
  isolateHome()
  const stale = makeJournal()
  const fresh = makeJournal()
  saveJournal(stale)
  saveJournal(fresh)

  const staleAgeSeconds = (JOURNAL_RETENTION_DAYS + 1) * 24 * 60 * 60
  const staleTime = Date.now() / 1000 - staleAgeSeconds
  utimesSync(join(journalDir(), `${stale.runId}.json`), staleTime, staleTime)

  assert.equal(pruneJournals(), 1)
  assert.deepEqual(readdirSync(journalDir()), [`${fresh.runId}.json`])
})

test('pruning an absent journal directory is a no-op, not a crash', () => {
  isolateHome()
  assert.equal(pruneJournals(), 0)
  assert.deepEqual(listJournals(), [])
})
