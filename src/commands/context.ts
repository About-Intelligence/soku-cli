/** `soku context` — manage the brand's Context Hub files.
 *
 * The agent can reference these files in chat. All paths are context-relative
 * (no `context/` prefix); the server pins them into the brand's context/ GCS
 * subtree. Upload is the same presigned two-step PUT the web Context Hub uses:
 * POST to mint a signed URL, then PUT the bytes straight to storage.
 */

import { basename, extname, join, relative } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'

import { Command } from 'commander'

import { apiRequest } from '../http/client.js'
import { bold, dim, emitError, emitSuccess, emitSuccessExit, ExitCode, table } from '../output/envelope.js'
const FILES_PATH = '/api/cli/context-hub/files'
const UPLOAD_PATH = '/api/cli/context-hub/upload'
const DIRECTORY_PATH = '/api/cli/context-hub/directory'
const RENAME_PATH = '/api/cli/context-hub/rename'

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
  opts: { contentType?: string },
): Promise<UploadOutcome> {
  const { localPath, targetDir, filename } = task
  const contentType = opts.contentType ?? guessContentType(filename)
  let bytes: Buffer
  try {
    bytes = readFileSync(localPath)
  } catch (err) {
    return { task, ok: false, error: `read failed: ${(err as Error).message}` }
  }

  let minted: UploadUrlResponse
  try {
    minted = await apiRequest<UploadUrlResponse>(UPLOAD_PATH, {
      method: 'POST',
      body: { filename, content_type: contentType, target_dir: targetDir },
      workspace: true,
    })
  } catch (err) {
    return { task, ok: false, error: `mint failed: ${(err as Error).message}` }
  }

  try {
    const putRes = await fetch(minted.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
    })
    if (!putRes.ok) {
      return { task, ok: false, error: `PUT failed (HTTP ${putRes.status})` }
    }
  } catch (err) {
    return { task, ok: false, error: `PUT failed: ${(err as Error).message}` }
  }
  return { task, ok: true, path: minted.path, sizeBytes: bytes.length, contentType }
}

/** Run upload tasks through a small worker pool so dozens of files don't
 * hammer the proxy/storage serially, but stay bounded. */
async function uploadAll(
  tasks: UploadTask[],
  opts: { contentType?: string; concurrency: number },
): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(opts.concurrency, tasks.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= tasks.length) return
      outcomes[i] = await uploadOne(tasks[i], opts)
    }
  })
  await Promise.all(workers)
  return outcomes
}

function renderUploadSummary(outcomes: UploadOutcome[]): string {
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
    .command('upload <paths...>')
    .description(
      'Upload one or more files (or directories) to the Context Hub. ' +
        'Directories recurse and preserve structure under --dir; globs expand. ' +
        'Runs uploads concurrently; failures are isolated and summarized.',
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
      (v: string) => {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1) {
          emitError('usage', `--concurrency must be a positive integer, got: ${v}`, ExitCode.USAGE)
        }
        return n
      },
      4,
    )
    .action(
      async (paths: string[], opts: { dir: string; name?: string; contentType?: string; concurrency: number }) => {
        if (paths.length === 0) {
          emitError('usage', 'upload requires at least one file or directory', ExitCode.USAGE)
        }
        // `--name` only makes sense for a single file; reject ambiguity early.
        if (opts.name && paths.length > 1) {
          emitError('usage', '--name can only be used with a single input file', ExitCode.USAGE)
        }

        let tasks: UploadTask[]
        try {
          tasks = expandUploadPaths(paths, { dir: opts.dir })
        } catch (err) {
          emitError('usage', (err as Error).message, ExitCode.USAGE)
        }
        if (tasks.length === 0) {
          emitError('usage', 'no files to upload (only dotfiles/cruft found?)', ExitCode.USAGE)
        }
        // Apply a single-file rename last, after expansion validated it.
        if (opts.name && tasks.length === 1) tasks[0].filename = opts.name

        const outcomes = await uploadAll(tasks, {
          contentType: opts.contentType,
          concurrency: opts.concurrency,
        })

        const ok = outcomes.filter((o) => o.ok)
        const data = {
          uploaded: ok.length,
          failed: outcomes.length - ok.length,
          total_bytes: ok.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
          files: ok.map((o) => ({ path: o.path, size_bytes: o.sizeBytes, content_type: o.contentType })),
          failures: outcomes.filter((o) => !o.ok).map((o) => ({
            path: `${o.task.targetDir}/${o.task.filename}`,
            error: o.error,
          })),
        }
        // Partial failure still emits the success-shaped summary (callers want
        // the JSON results) but exits non-zero so scripts detect the failures.
        emitSuccessExit(data, data.failed > 0 ? ExitCode.RUNTIME : ExitCode.OK, renderUploadSummary.bind(null, outcomes))
      },
    )

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
