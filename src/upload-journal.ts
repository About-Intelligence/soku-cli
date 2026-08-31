/** Durable record of one `soku context upload` run.
 *
 * A bulk upload of hundreds of files will lose some of them to transient
 * failures no matter how many times it retries. Without a record of what the
 * run intended to do, the only recovery is to re-run the whole command and
 * hope, which is what forced manual batching and hand-checking of file counts.
 * The journal makes a run resumable: it stores every planned file and the
 * outcome of each one, so a later `--resume <run-id>` re-attempts exactly the
 * files that never landed.
 *
 * Journals live under `~/.soku/uploads/` and are pruned by age, not by count,
 * so a resume is still possible days later.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { configDir } from './config.js'

export type UploadEntryStatus = 'pending' | 'done' | 'failed'

export interface UploadJournalEntry {
  localPath: string
  targetDir: string
  filename: string
  status: UploadEntryStatus
  error?: string
  sizeBytes?: number
  contentType?: string
}

export interface UploadJournal {
  runId: string
  createdAt: string
  updatedAt: string
  /** Workspace the run targeted; a resume into a different brand is refused. */
  orgId: string | null
  brandId: string | null
  dir: string
  entries: UploadJournalEntry[]
}

/** Journals older than this are pruned on the next run. */
export const JOURNAL_RETENTION_DAYS = 14

export function journalDir(): string {
  return join(configDir(), 'uploads')
}

function journalPath(runId: string): string {
  return join(journalDir(), `${runId}.json`)
}

export function newRunId(): string {
  return randomUUID()
}

export function saveJournal(journal: UploadJournal): void {
  const path = journalPath(journal.runId)
  mkdirSync(journalDir(), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...journal, updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  })
}

export function loadJournal(runId: string): UploadJournal | null {
  try {
    return JSON.parse(readFileSync(journalPath(runId), 'utf8')) as UploadJournal
  } catch {
    return null
  }
}

export function deleteJournal(runId: string): void {
  try {
    rmSync(journalPath(runId))
  } catch {
    // Already gone; a finished run leaving no journal behind is the goal.
  }
}

/** Entries a resume should re-attempt: everything that is not confirmed done. */
export function pendingEntries(journal: UploadJournal): UploadJournalEntry[] {
  return journal.entries.filter((entry) => entry.status !== 'done')
}

export function listJournals(): UploadJournal[] {
  let names: string[]
  try {
    names = readdirSync(journalDir())
  } catch {
    return []
  }
  const journals: UploadJournal[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const journal = loadJournal(name.slice(0, -'.json'.length))
    if (journal) journals.push(journal)
  }
  journals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return journals
}

/** Drop journals past the retention window so the directory cannot grow forever. */
export function pruneJournals(now = Date.now()): number {
  const cutoff = now - JOURNAL_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let names: string[]
  try {
    names = readdirSync(journalDir())
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(journalDir(), name)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path)
        removed += 1
      }
    } catch {
      // A journal that vanished mid-prune needs no further attention.
    }
  }
  return removed
}
