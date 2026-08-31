/** `soku context` — manage the brand's Context Hub files.
 *
 * The agent can reference these files in chat. All paths are context-relative
 * (no `context/` prefix); the server pins them into the brand's context/ GCS
 * subtree. Upload is the same presigned two-step PUT the web Context Hub uses:
 * POST to mint a signed URL, then PUT the bytes straight to storage.
 */

import { basename, extname, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'

import { Command } from 'commander'

import { loadConfig } from '../config.js'
import { ApiError, apiRequest } from '../http/client.js'
import {
  deleteJournal,
  listJournals,
  loadJournal,
  newRunId,
  pendingEntries,
  pruneJournals,
  saveJournal,
  type UploadJournal,
} from '../upload-journal.js'
import { bold, dim, emitError, emitSuccess, emitSuccessExit, ExitCode, table } from '../output/envelope.js'
const FILES_PATH = '/api/cli/context-hub/files'
const UPLOAD_PATH = '/api/cli/context-hub/upload'
const DIRECTORY_PATH = '/api/cli/context-hub/directory'
const RENAME_PATH = '/api/cli/context-hub/rename'
const MANIFEST_PATH = '/api/cli/context-hub/manifest'

interface ContextFile {
  path: string
  name: string
  content_type: string
  file_type: string
  size_bytes: number
  updated_at: string
}

interface ListResponse {
  dir: string
  files: ContextFile[]
  directories: string[]
}

interface UploadUrlResponse {
  path: string
  upload_url: string
}

/** Minimal extension → MIME map. The content-type signed in the POST must match
 * the PUT header exactly, so we compute it once and reuse it for both. */
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

function guessContentType(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

function renderList(data: ListResponse): string {
  const here = data.dir ? `context-hub:/${data.dir}` : 'context-hub:/'
  const parts: string[] = [bold(here)]
  if (data.directories.length > 0) {
    parts.push(data.directories.map((d) => `${dim('dir')}  ${d}/`).join('\n'))
  }
  if (data.files.length > 0) {
    parts.push(
      table(
        data.files.map((f) => ({
          name: f.name,
          type: f.file_type,
          size: f.size_bytes,
          path: f.path,
        })),
        [
          { key: 'name', header: 'NAME' },
          { key: 'type', header: 'TYPE' },
          { key: 'size', header: 'BYTES' },
          { key: 'path', header: 'PATH' },
        ],
      ),
    )
  }
  if (data.directories.length === 0 && data.files.length === 0) {
    parts.push(dim('(empty)'))
  }
  return parts.join('\n')
}

/** Files the CLI refuses to upload (operating-system cruft / editor state). */
const IGNORED_UPLOAD_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.gitignore'])

/** One planned upload: local file → Context Hub (target_dir + stored name). */
export interface UploadTask {
  localPath: string
  targetDir: string
  filename: string
}

/** Expand CLI args (globs, explicit files, and directories) into concrete
 * upload tasks. Directories recurse, preserving their structure under `--dir`
 * (so `upload ./assets --dir assets` lays out `assets/a/b.png` → `assets/a/b.png`).
 * Dotfiles and OS cruft are skipped. */
export function expandUploadPaths(
  rawPaths: string[],
  opts: { dir: string },
): UploadTask[] {
  const tasks: UploadTask[] = []
  const seen = new Set<string>()
  const push = (localPath: string, targetDir: string, filename: string): void => {
    if (IGNORED_UPLOAD_NAMES.has(filename)) return
    if (filename.startsWith('.')) return
    const key = `${targetDir}/${filename}`
    if (seen.has(key)) return
    seen.add(key)
    tasks.push({ localPath, targetDir, filename })
  }

  for (const raw of rawPaths) {
    let info
    try {
      info = statSync(raw)
    } catch {
      throw new Error(`No such file or directory: ${raw}`)
    }
    if (info.isFile()) {
      // Shell-expanded globs land here as plain files. `--name` is applied by
      // the caller only in the single-file case.
      push(raw, opts.dir, basename(raw))
      continue
    }
    if (info.isDirectory()) {
      walk(raw, (abs) => {
        const rel = relative(raw, abs) // preserve structure: a/b.png
        const dir = join(opts.dir, rel.slice(0, Math.max(0, rel.lastIndexOf('/'))))
        push(abs, dir.replace(/\\/g, '/'), basename(abs))
      })
      continue
    }
    throw new Error(`Not a file or directory: ${raw}`)
  }
  return tasks
}

/** Synchronous recursive directory walk over regular files (no globs/deps). */
function walk(root: string, visit: (absPath: string) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, entry.name)
    if (entry.isDirectory()) walk(abs, visit)
    else if (entry.isFile()) visit(abs)
  }
}

/** How many attempts a single file gets before the run gives up on it. */
export const DEFAULT_UPLOAD_ATTEMPTS = 3

/** Failures worth retrying: the request never reached a decision, or the server
 * said it could not answer *right now*. A 4xx other than 408/429 is a decision
 * (bad path, unauthorized, too large) and retrying it only wastes time. */
export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/** Exponential backoff with jitter, capped so a long batch cannot stall.
 * Jitter matters here specifically: without it, a concurrent pool that trips a
 * rate limit retries in lockstep and trips it again. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000)
  return Math.round(base * (0.5 + random() * 0.5))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Retriable-failure marker, so `withRetries` can tell a transient error from a
 * permanent one without parsing message strings. */
class TransientUploadError extends Error {}

async function withRetries<T>(
  attempts: number,
  run: () => Promise<T>,
): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run()
    } catch (err) {
      lastError = err as Error
      if (!(err instanceof TransientUploadError) || attempt === attempts) throw lastError
      await sleep(retryDelayMs(attempt))
    }
  }
  throw lastError ?? new Error('upload failed')
}

/** Base64 MD5 of a local file, in the same shape the server reports. */
export function md5Base64(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('base64')
}

interface ManifestFile {
  path: string
  name: string
  size_bytes: number
  md5?: string | null
}

interface ManifestResponse {
  dir: string
  checksums: boolean
  count: number
  total_bytes: number
  files: ManifestFile[]
}

export type VerifyStatus = 'ok' | 'missing' | 'size_mismatch' | 'checksum_mismatch' | 'unverified'

export interface VerifyRow {
  path: string
  status: VerifyStatus
  localBytes: number
  remoteBytes?: number
}

export interface VerifyReport {
  dir: string
  checked: number
  ok: number
  mismatched: number
  missing: number
  unverified: number
  rows: VerifyRow[]
}

/** Compare planned local files against the server's manifest.
 *
 * Size alone catches a truncated upload; only the checksum catches bytes that
 * arrived intact but wrong. When the server reports no checksum for a file the
 * row is `unverified` rather than `ok`, so a missing hash never reads as proof.
 */
export function buildVerifyReport(
  tasks: UploadTask[],
  manifest: ManifestResponse,
  localOf: (task: UploadTask) => { sizeBytes: number; md5: string },
): VerifyReport {
  const remote = new Map(manifest.files.map((file) => [file.path, file]))
  const rows: VerifyRow[] = []
  for (const task of tasks) {
    const path = task.targetDir ? `${task.targetDir}/${task.filename}` : task.filename
    const local = localOf(task)
    const found = remote.get(path)
    if (!found) {
      rows.push({ path, status: 'missing', localBytes: local.sizeBytes })
      continue
    }
    if (found.size_bytes !== local.sizeBytes) {
      rows.push({
        path,
        status: 'size_mismatch',
        localBytes: local.sizeBytes,
        remoteBytes: found.size_bytes,
      })
      continue
    }
    if (!found.md5) {
      rows.push({
        path,
        status: 'unverified',
        localBytes: local.sizeBytes,
        remoteBytes: found.size_bytes,
      })
      continue
    }
    rows.push({
      path,
      status: found.md5 === local.md5 ? 'ok' : 'checksum_mismatch',
      localBytes: local.sizeBytes,
      remoteBytes: found.size_bytes,
    })
  }
  return {
    dir: manifest.dir,
    checked: rows.length,
    ok: rows.filter((r) => r.status === 'ok').length,
    mismatched: rows.filter(
      (r) => r.status === 'size_mismatch' || r.status === 'checksum_mismatch',
    ).length,
    missing: rows.filter((r) => r.status === 'missing').length,
    unverified: rows.filter((r) => r.status === 'unverified').length,
    rows,
  }
}

/** Result of attempting one upload. Errors are captured, not thrown, so a
 * batch run keeps going after a single failure and reports a summary. */
interface UploadOutcome {
  task: UploadTask
  ok: boolean
  path?: string
  sizeBytes?: number
  contentType?: string
  error?: string
}

/** Mint a presigned PUT URL then PUT the bytes — the two-step Context Hub
 * upload, isolated to one file. The presigned URL carries its own auth; the
 * Content-Type MUST match the one signed at mint time. */
async function uploadOne(
  task: UploadTask,
  opts: { contentType?: string; attempts?: number },
): Promise<UploadOutcome> {
  const { localPath, targetDir, filename } = task
  const contentType = opts.contentType ?? guessContentType(filename)
  const attempts = opts.attempts ?? DEFAULT_UPLOAD_ATTEMPTS
  let bytes: Buffer
  try {
    bytes = readFileSync(localPath)
  } catch (err) {
    // A local read failure is never transient in the way a network call is:
    // the file is missing or unreadable and will be on the next attempt too.
    return { task, ok: false, error: `read failed: ${(err as Error).message}` }
  }

  let minted: UploadUrlResponse
  try {
    minted = await withRetries(attempts, async () => {
      try {
        return await apiRequest<UploadUrlResponse>(UPLOAD_PATH, {
          method: 'POST',
          body: { filename, content_type: contentType, target_dir: targetDir },
          workspace: true,
          // Without this the client exits the process on any error, so one
          // file's transient 503 would end a run of hundreds.
          throwOnError: true,
        })
      } catch (err) {
        // status 0 means the request never reached the server.
        if (err instanceof ApiError && (err.status === 0 || isRetriableStatus(err.status))) {
          throw new TransientUploadError(err.message)
        }
        throw err
      }
    })
  } catch (err) {
    return { task, ok: false, error: `mint failed: ${(err as Error).message}` }
  }

  try {
    await withRetries(attempts, async () => {
      let putRes: Response
      try {
        putRes = await fetch(minted.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body: new Uint8Array(bytes),
        })
      } catch (err) {
        // The request never got an answer — the classic transient case.
        throw new TransientUploadError(`PUT failed: ${(err as Error).message}`)
      }
      if (putRes.ok) return
      const message = `PUT failed (HTTP ${putRes.status})`
      if (isRetriableStatus(putRes.status)) throw new TransientUploadError(message)
      throw new Error(message)
    })
  } catch (err) {
    return { task, ok: false, error: (err as Error).message }
  }
  return { task, ok: true, path: minted.path, sizeBytes: bytes.length, contentType }
}

/** Run upload tasks through a small worker pool so dozens of files don't
 * hammer the proxy/storage serially, but stay bounded. */
async function uploadAll(
  tasks: UploadTask[],
  opts: {
    contentType?: string
    concurrency: number
    attempts?: number
    /** Called after each file settles, so the run's journal stays current even
     * if the process is killed mid-batch. */
    onSettled?: (outcome: UploadOutcome) => void
  },
): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(opts.concurrency, tasks.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= tasks.length) return
      outcomes[i] = await uploadOne(tasks[i], opts)
      opts.onSettled?.(outcomes[i])
    }
  })
  await Promise.all(workers)
  return outcomes
}

function parsePositiveIntFlag(raw: string, flag: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    emitError('usage', `${flag} must be a positive integer, got: ${raw}`, ExitCode.USAGE)
  }
  return n
}

/** Snapshot the plan so a killed run can be finished later. */
function startJournal(tasks: UploadTask[], dir: string): UploadJournal {
  const cfg = loadConfig()
  const now = new Date().toISOString()
  return {
    runId: newRunId(),
    createdAt: now,
    updatedAt: now,
    orgId: process.env.SOKU_ORG_ID || cfg.activeOrgId || null,
    brandId: process.env.SOKU_BRAND_ID || cfg.activeBrandId || null,
    dir,
    entries: tasks.map((task) => ({
      localPath: task.localPath,
      targetDir: task.targetDir,
      filename: task.filename,
      status: 'pending' as const,
    })),
  }
}

/** Refuse a resume that would push a recorded run into a different brand.
 *
 * Silently retargeting is the exact failure the run journal is supposed to
 * prevent: the files would land, in the wrong workspace, and look successful. */
function assertSameWorkspace(journal: UploadJournal): void {
  const cfg = loadConfig()
  const orgId = process.env.SOKU_ORG_ID || cfg.activeOrgId || null
  const brandId = process.env.SOKU_BRAND_ID || cfg.activeBrandId || null
  if (journal.brandId && journal.brandId !== brandId) {
    emitError(
      'workspace_mismatch',
      `Run ${journal.runId} uploaded to brand ${journal.brandId}, but the active brand is ${brandId ?? '(none)'}.`,
      ExitCode.USAGE,
      `Switch back with \`soku workspace use-brand ${journal.brandId}\` before resuming.`,
    )
  }
  if (journal.orgId && journal.orgId !== orgId) {
    emitError(
      'workspace_mismatch',
      `Run ${journal.runId} uploaded to org ${journal.orgId}, but the active org is ${orgId ?? '(none)'}.`,
      ExitCode.USAGE,
    )
  }
}

function recordOutcome(journal: UploadJournal, outcome: UploadOutcome): void {
  const entry = journal.entries.find(
    (item) =>
      item.targetDir === outcome.task.targetDir && item.filename === outcome.task.filename,
  )
  if (!entry) return
  entry.status = outcome.ok ? 'done' : 'failed'
  entry.error = outcome.ok ? undefined : outcome.error
  entry.sizeBytes = outcome.sizeBytes
  entry.contentType = outcome.contentType
}

/** Fetch the server manifest and compare it against what was just uploaded. */
async function verifyUploaded(tasks: UploadTask[], dir: string): Promise<VerifyReport | null> {
  if (tasks.length === 0) return null
  const query = new URLSearchParams({ checksums: 'true' })
  if (dir) query.set('dir', dir)
  const manifest = await apiRequest<ManifestResponse>(`${MANIFEST_PATH}?${query.toString()}`, {
    workspace: true,
  })
  return buildVerifyReport(tasks, manifest, (task) => {
    const bytes = readFileSync(task.localPath)
    return { sizeBytes: bytes.length, md5: md5Base64(bytes) }
  })
}

export function verificationClean(report: VerifyReport | null): boolean {
  if (report === null) return true
  return report.missing === 0 && report.mismatched === 0 && report.unverified === 0
}

export function renderVerifyReport(report: VerifyReport): string {
  const problems = report.rows.filter((row) => row.status !== 'ok')
  const head = `${bold('Verified')} ${report.ok}/${report.checked} file${
    report.checked === 1 ? '' : 's'
  }`
  if (problems.length === 0) return `${head}\n${dim('All sizes and checksums match.')}`
  return [
    head,
    table(
      problems.map((row) => ({
        status: row.status,
        path: row.path,
        local: row.localBytes,
        remote: row.remoteBytes ?? '-',
      })),
      [
        { key: 'status', header: 'STATUS' },
        { key: 'path', header: 'PATH' },
        { key: 'local', header: 'LOCAL BYTES' },
        { key: 'remote', header: 'REMOTE BYTES' },
      ],
    ),
  ].join('\n')
}

function renderUploadSummary(
  outcomes: UploadOutcome[],
  resumeCommand?: string | null,
  verification?: VerifyReport | null,
): string {
  const ok = outcomes.filter((o) => o.ok)
  const failed = outcomes.filter((o) => !o.ok)
  const head = `${bold('Uploaded')} ${ok.length}/${outcomes.length} file${
    outcomes.length === 1 ? '' : 's'
  }`
  const lines = [head]
  for (const o of ok) {
    lines.push(`  ${dim('+')} ${o.path} (${o.sizeBytes} bytes)`)
  }
  for (const o of failed) {
    lines.push(`  ${dim('x')} ${o.task.targetDir}/${o.task.filename} — ${o.error}`)
  }
  if (resumeCommand) {
    lines.push('')
    lines.push(`${bold('Resume the rest with')}: ${resumeCommand}`)
  }
  if (verification) {
    lines.push('')
    lines.push(renderVerifyReport(verification))
  }
  return lines.join('\n')
}

export function registerContextCommands(program: Command): void {
  const context = program
    .command('context')
    .description("Manage the brand's Context Hub files (requires the context-hub resource)")

  context
    .command('list')
    .description('List Context Hub files and directories')
    .option('--dir <dir>', 'Context-relative directory (e.g. docs)', '')
    .action(async (opts: { dir: string }) => {
      const q = opts.dir ? `?dir=${encodeURIComponent(opts.dir)}` : ''
      const data = await apiRequest<ListResponse>(`${FILES_PATH}${q}`, { workspace: true })
      emitSuccess(data, renderList)
    })

  context
    .command('upload [paths...]')
    .description(
      'Upload one or more files (or directories) to the Context Hub. ' +
        'Directories recurse and preserve structure under --dir; globs expand. ' +
        'Runs uploads concurrently, retries transient failures, and records a ' +
        'resumable run so a partial batch can be finished with --resume.',
    )
    .option('--dir <dir>', 'Context-relative target directory (e.g. docs)', '')
    .option(
      '--name <name>',
      'Override the stored filename (only valid with a single input file)',
    )
    .option('--content-type <type>', 'Override the content type (defaults to a guess by extension)')
    .option(
      '--concurrency <n>',
      'Max simultaneous uploads (default 4)',
      (v: string) => parsePositiveIntFlag(v, '--concurrency'),
      4,
    )
    .option(
      '--retries <n>',
      `Attempts per file before giving up (default ${DEFAULT_UPLOAD_ATTEMPTS})`,
      (v: string) => parsePositiveIntFlag(v, '--retries'),
      DEFAULT_UPLOAD_ATTEMPTS,
    )
    .option('--resume <run_id>', 'Finish a previous run, re-uploading only the files that never landed')
    .option('--verify', 'After uploading, reconcile the uploaded files against the server by size and checksum')
    .action(
      async (
        paths: string[] | undefined,
        opts: {
          dir: string
          name?: string
          contentType?: string
          concurrency: number
          retries: number
          resume?: string
          verify?: boolean
        },
      ) => {
        pruneJournals()
        const inputPaths = paths ?? []

        let journal: UploadJournal
        let tasks: UploadTask[]

        if (opts.resume) {
          if (inputPaths.length > 0) {
            emitError(
              'usage',
              '--resume replays a recorded run; do not also pass paths.',
              ExitCode.USAGE,
              `Run: soku context upload --resume ${opts.resume}`,
            )
          }
          const loaded = loadJournal(opts.resume)
          if (!loaded) {
            emitError(
              'not_found',
              `No upload run recorded with id ${opts.resume}.`,
              ExitCode.NOT_FOUND,
              'List recorded runs with `soku context uploads`.',
            )
          }
          assertSameWorkspace(loaded)
          journal = loaded
          const pending = pendingEntries(journal)
          if (pending.length === 0) {
            emitSuccess(
              { run_id: journal.runId, uploaded: 0, failed: 0, remaining: 0, files: [], failures: [] },
              () => `${bold('Nothing to resume')} — run ${journal.runId} already completed.`,
            )
            return
          }
          tasks = pending.map((entry) => ({
            localPath: entry.localPath,
            targetDir: entry.targetDir,
            filename: entry.filename,
          }))
        } else {
          if (inputPaths.length === 0) {
            emitError(
              'usage',
              'upload requires at least one file or directory (or --resume <run_id>)',
              ExitCode.USAGE,
            )
          }
          // `--name` only makes sense for a single file; reject ambiguity early.
          if (opts.name && inputPaths.length > 1) {
            emitError('usage', '--name can only be used with a single input file', ExitCode.USAGE)
          }
          try {
            tasks = expandUploadPaths(inputPaths, { dir: opts.dir })
          } catch (err) {
            emitError('usage', (err as Error).message, ExitCode.USAGE)
          }
          if (tasks.length === 0) {
            emitError('usage', 'no files to upload (only dotfiles/cruft found?)', ExitCode.USAGE)
          }
          // Apply a single-file rename last, after expansion validated it.
          if (opts.name && tasks.length === 1) tasks[0].filename = opts.name
          journal = startJournal(tasks, opts.dir)
        }

        // Persist before the first byte moves: a run killed mid-batch must
        // still be resumable, which needs the plan on disk up front.
        saveJournal(journal)

        const outcomes = await uploadAll(tasks, {
          contentType: opts.contentType,
          concurrency: opts.concurrency,
          attempts: opts.retries,
          onSettled: (outcome) => {
            recordOutcome(journal, outcome)
            saveJournal(journal)
          },
        })

        const ok = outcomes.filter((o) => o.ok)
        const failures = outcomes.filter((o) => !o.ok)
        const remaining = pendingEntries(journal).length
        // Only a fully settled run may drop its journal; anything left pending
        // is exactly what --resume exists to pick up.
        if (remaining === 0) deleteJournal(journal.runId)

        // The journal's dir, not `opts.dir`: on a resume the caller passes only
        // --resume, so `opts.dir` is the empty default and would widen the
        // manifest query to the whole hub.
        const verification = opts.verify
          ? await verifyUploaded(ok.map((o) => o.task), journal.dir)
          : null

        const data = {
          run_id: journal.runId,
          uploaded: ok.length,
          failed: failures.length,
          remaining,
          total_bytes: ok.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
          files: ok.map((o) => ({ path: o.path, size_bytes: o.sizeBytes, content_type: o.contentType })),
          failures: failures.map((o) => ({
            path: `${o.task.targetDir}/${o.task.filename}`,
            error: o.error,
          })),
          resume_command: remaining > 0 ? `soku context upload --resume ${journal.runId}` : null,
          verification,
        }
        // Partial failure still emits the success-shaped summary (callers want
        // the JSON results) but exits non-zero so scripts detect the failures.
        const clean = data.failed === 0 && (verification === null || verificationClean(verification))
        emitSuccessExit(
          data,
          clean ? ExitCode.OK : ExitCode.RUNTIME,
          () => renderUploadSummary(outcomes, data.resume_command, verification),
        )
      },
    )

  context
    .command('verify <paths...>')
    .description(
      'Reconcile local files against the Context Hub by size and checksum, ' +
        'without uploading anything.',
    )
    .option('--dir <dir>', 'Context-relative directory the files were uploaded to', '')
    .action(async (paths: string[], opts: { dir: string }) => {
      let tasks: UploadTask[]
      try {
        tasks = expandUploadPaths(paths, { dir: opts.dir })
      } catch (err) {
        emitError('usage', (err as Error).message, ExitCode.USAGE)
      }
      if (tasks.length === 0) {
        emitError('usage', 'no local files to verify (only dotfiles/cruft found?)', ExitCode.USAGE)
      }
      const report = await verifyUploaded(tasks, opts.dir)
      if (report === null) {
        emitError('usage', 'no local files to verify', ExitCode.USAGE)
      }
      emitSuccessExit(
        report,
        verificationClean(report) ? ExitCode.OK : ExitCode.RUNTIME,
        renderVerifyReport,
      )
    })

  context
    .command('uploads')
    .description('List upload runs that recorded unfinished files and can be resumed')
    .action(() => {
      pruneJournals()
      const runs = listJournals().map((journal) => ({
        run_id: journal.runId,
        created_at: journal.createdAt,
        dir: journal.dir,
        total: journal.entries.length,
        remaining: pendingEntries(journal).length,
      }))
      emitSuccess({ runs, count: runs.length }, (d) =>
        d.runs.length === 0
          ? dim('No resumable upload runs.')
          : table(d.runs, [
              { key: 'run_id', header: 'RUN ID' },
              { key: 'created_at', header: 'CREATED' },
              { key: 'dir', header: 'DIR' },
              { key: 'total', header: 'FILES' },
              { key: 'remaining', header: 'REMAINING' },
            ]),
      )
    })

  context
    .command('rm <path>')
    .description('Delete a Context Hub file')
    .action(async (path: string) => {
      const data = await apiRequest<{ deleted: string }>(
        `${FILES_PATH}?path=${encodeURIComponent(path)}`,
        { method: 'DELETE', workspace: true },
      )
      emitSuccess(data, (d) => `${bold('Deleted')} ${d.deleted}`)
    })

  context
    .command('mkdir <path>')
    .description('Create a Context Hub directory')
    .action(async (path: string) => {
      const data = await apiRequest<{ created: string }>(DIRECTORY_PATH, {
        method: 'POST',
        body: { path },
        workspace: true,
      })
      emitSuccess(data, (d) => `${bold('Created')} ${d.created}/`)
    })

  context
    .command('rename <oldPath> <newPath>')
    .description('Rename or move a Context Hub file or directory')
    .action(async (oldPath: string, newPath: string) => {
      const data = await apiRequest<{ renamed: string; to: string }>(RENAME_PATH, {
        method: 'POST',
        body: { old_path: oldPath, new_path: newPath },
        workspace: true,
      })
      emitSuccess(data, (d) => `${bold('Renamed')} ${d.renamed} → ${d.to}`)
    })
}
