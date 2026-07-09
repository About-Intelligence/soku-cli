import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { expandUploadPaths } from './context.js'

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
