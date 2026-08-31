import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Command } from 'commander'

import {
  buildVerifyReport,
  expandUploadPaths,
  isRetriableStatus,
  md5Base64,
  registerContextCommands,
  retryDelayMs,
  verificationClean,
} from './context.js'

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'ctx-upload-'))
  writeFileSync(join(root, 'a.md'), 'a')
  writeFileSync(join(root, 'b.json'), 'b')
  writeFileSync(join(root, '.hidden'), 'x')
  writeFileSync(join(root, '.DS_Store'), 'x')
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub', 'c.md'), 'c')
  mkdirSync(join(root, 'sub', 'deep'))
  writeFileSync(join(root, 'sub', 'deep', 'd.png'), 'd')
  return root
}

test('expandUploadPaths: single file → one task at --dir', () => {
  const root = makeTree()
  const tasks = expandUploadPaths([join(root, 'a.md')], { dir: 'docs' })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].filename, 'a.md')
  assert.equal(tasks[0].targetDir, 'docs')
})

test('expandUploadPaths: explicit multiple files keep --dir', () => {
  const root = makeTree()
  const tasks = expandUploadPaths([join(root, 'a.md'), join(root, 'b.json')], { dir: 'docs' })
  assert.equal(tasks.length, 2)
  assert.deepEqual(
    tasks.map((t) => t.filename).sort(),
    ['a.md', 'b.json'],
  )
})

test('expandUploadPaths: directory recursion preserves structure under --dir', () => {
  const root = makeTree()
  const tasks = expandUploadPaths([root], { dir: 'docs' })
  const mapped = tasks
    .map((t) => `${t.targetDir}/${t.filename}`)
    .sort()
  assert.deepEqual(mapped, [
    'docs/a.md',
    'docs/b.json',
    'docs/sub/c.md',
    'docs/sub/deep/d.png',
  ])
})

test('expandUploadPaths: skips dotfiles and OS cruft', () => {
  const root = makeTree()
  const tasks = expandUploadPaths([root], { dir: 'docs' })
  const names = tasks.map((t) => t.filename)
  assert.ok(!names.includes('.hidden'))
  assert.ok(!names.includes('.DS_Store'))
})

test('expandUploadPaths: dedupes identical target keys', () => {
  const root = makeTree()
  // same file passed twice → same docs/a.md key → one task
  const tasks = expandUploadPaths([join(root, 'a.md'), join(root, 'a.md')], { dir: 'docs' })
  assert.equal(tasks.length, 1)
})

test('expandUploadPaths: throws on missing path', () => {
  assert.throws(() => expandUploadPaths(['/no/such/path.md'], { dir: 'docs' }), /No such file/)
})

test('isRetriableStatus: retries only what a retry can fix', () => {
  // No answer yet, or the server said "not right now".
  assert.equal(isRetriableStatus(408), true)
  assert.equal(isRetriableStatus(429), true)
  assert.equal(isRetriableStatus(500), true)
  assert.equal(isRetriableStatus(503), true)
  // A decision the server already made — retrying it just wastes the batch.
  assert.equal(isRetriableStatus(400), false)
  assert.equal(isRetriableStatus(403), false)
  assert.equal(isRetriableStatus(413), false)
})

test('retryDelayMs: backs off exponentially, caps, and jitters', () => {
  // Fixed random keeps the assertion exact; the jitter range is [0.5, 1.0).
  assert.equal(retryDelayMs(1, () => 0), 500)
  assert.equal(retryDelayMs(2, () => 0), 1000)
  assert.equal(retryDelayMs(3, () => 0), 2000)
  // Capped so one file cannot stall a long batch.
  assert.equal(retryDelayMs(10, () => 0), 4000)
  assert.equal(retryDelayMs(10, () => 0.999), 8000 - 4)
  // Jitter actually moves the value, so a concurrent pool does not retry in lockstep.
  assert.notEqual(retryDelayMs(2, () => 0), retryDelayMs(2, () => 0.9))
})

test('md5Base64 matches the base64 digest shape the server reports', () => {
  // Cross-language fixture: the same value Python's
  // base64.b64encode(hashlib.md5(b"reconcile me").digest()) produces, which is
  // what the manifest endpoint returns. Reconciliation is only meaningful if
  // both sides agree on this exact encoding, so it is pinned on both sides —
  // see test_context_hub_manifest_returns_md5_matching_the_uploaded_bytes.
  assert.equal(md5Base64(Buffer.from('reconcile me')), 'Btg1VsWBZsecb9ChWx26cA==')
})

test('buildVerifyReport: separates missing, wrong size, wrong bytes, and unverifiable', () => {
  const tasks = [
    { localPath: '/x/ok.md', targetDir: 'docs', filename: 'ok.md' },
    { localPath: '/x/gone.md', targetDir: 'docs', filename: 'gone.md' },
    { localPath: '/x/short.md', targetDir: 'docs', filename: 'short.md' },
    { localPath: '/x/corrupt.md', targetDir: 'docs', filename: 'corrupt.md' },
    { localPath: '/x/nohash.md', targetDir: 'docs', filename: 'nohash.md' },
  ]
  const report = buildVerifyReport(
    tasks,
    {
      dir: 'docs',
      checksums: true,
      count: 4,
      total_bytes: 40,
      files: [
        { path: 'docs/ok.md', name: 'ok.md', size_bytes: 10, md5: 'HASH-OK' },
        { path: 'docs/short.md', name: 'short.md', size_bytes: 3, md5: 'HASH-SHORT' },
        { path: 'docs/corrupt.md', name: 'corrupt.md', size_bytes: 10, md5: 'HASH-OTHER' },
        { path: 'docs/nohash.md', name: 'nohash.md', size_bytes: 10, md5: null },
      ],
    },
    (task) => ({
      sizeBytes: 10,
      md5: task.filename === 'corrupt.md' ? 'HASH-MINE' : `HASH-${task.filename === 'ok.md' ? 'OK' : 'X'}`,
    }),
  )

  assert.deepEqual(
    report.rows.map((r) => [r.path, r.status]),
    [
      ['docs/ok.md', 'ok'],
      ['docs/gone.md', 'missing'],
      ['docs/short.md', 'size_mismatch'],
      ['docs/corrupt.md', 'checksum_mismatch'],
      // A file the server reports no hash for is NOT proof of a good upload.
      ['docs/nohash.md', 'unverified'],
    ],
  )
  assert.equal(report.ok, 1)
  assert.equal(report.missing, 1)
  assert.equal(report.mismatched, 2)
  assert.equal(report.unverified, 1)
})

test('verificationClean: an unverifiable file is not a clean result', () => {
  const base = { dir: '', checked: 1, ok: 0, mismatched: 0, missing: 0, unverified: 0, rows: [] }
  assert.equal(verificationClean(null), true)
  assert.equal(verificationClean({ ...base, ok: 1 }), true)
  assert.equal(verificationClean({ ...base, missing: 1 }), false)
  assert.equal(verificationClean({ ...base, mismatched: 1 }), false)
  assert.equal(verificationClean({ ...base, unverified: 1 }), false)
})

test('context command exposes verify and resumable upload runs', () => {
  const program = new Command()
  registerContextCommands(program)
  const context = program.commands.find((cmd) => cmd.name() === 'context')
  assert.ok(context)
  assert.deepEqual(
    context.commands.map((cmd) => cmd.name()).sort(),
    ['list', 'mkdir', 'rename', 'rm', 'upload', 'uploads', 'verify'],
  )
  const upload = context.commands.find((cmd) => cmd.name() === 'upload')
  const flags = upload?.options.map((opt) => opt.long) ?? []
  assert.ok(flags.includes('--resume'))
  assert.ok(flags.includes('--retries'))
  assert.ok(flags.includes('--verify'))
})
