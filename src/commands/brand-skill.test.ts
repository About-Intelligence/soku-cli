import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Command } from 'commander'
import { unzipSync } from 'fflate'

import {
  brandSkillFilePath,
  packageSkillPath,
  planSkillDownloadTargets,
  registerBrandSkillCommands,
} from './brand-skill.js'

function findCommand(root: Command, ...path: string[]): Command {
  let current = root
  for (const name of path) {
    const next = current.commands.find((cmd) => cmd.name() === name)
    assert.ok(next, `missing command path ${path.join(' ')}`)
    current = next
  }
  return current
}

test('brand skill command exposes catalog, upload, and file edit workflows', () => {
  const program = new Command()
  const brand = program.command('brand').description('brand commands')
  registerBrandSkillCommands(brand)

  for (const name of [
    'list',
    'catalog',
    'install',
    'uninstall',
    'reset',
    'upload',
    'delete',
    'files',
    'download',
    'read',
    'write',
    'create-file',
    'delete-file',
  ]) {
    assert.ok(findCommand(brand, 'skill', name))
  }

  const write = findCommand(brand, 'skill', 'write')
  assert.ok(write.options.some((opt) => opt.long === '--file'))
})

test('brand skill file paths preserve nested paths while escaping segments', () => {
  assert.equal(
    brandSkillFilePath('my-skill', 'references/a b.md'),
    '/api/cli/brand-skills/uploaded/my-skill/files/references/a%20b.md',
  )
  assert.throws(() => brandSkillFilePath('my-skill', '../SKILL.md'), /unsafe segment/)
})

test('planSkillDownloadTargets maps skill files under the target directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soku-brand-skill-download-'))
  try {
    const targets = planSkillDownloadTargets(
      [
        { path: 'SKILL.md', byte_size: 10 },
        { path: 'references/guide.md', byte_size: 20 },
      ],
      dir,
    )

    assert.equal(targets[0].outputPath, join(dir, 'SKILL.md'))
    assert.equal(targets[1].outputPath, join(dir, 'references', 'guide.md'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planSkillDownloadTargets rejects unsafe paths and existing files by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soku-brand-skill-download-'))
  try {
    writeFileSync(join(dir, 'SKILL.md'), 'existing')

    assert.throws(
      () => planSkillDownloadTargets([{ path: '../SKILL.md', byte_size: 10 }], dir),
      /unsafe segment/,
    )
    assert.throws(
      () => planSkillDownloadTargets([{ path: 'SKILL.md', byte_size: 10 }], dir),
      /Refusing to overwrite/,
    )
    assert.doesNotThrow(() =>
      planSkillDownloadTargets([{ path: 'SKILL.md', byte_size: 10 }], dir, true),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('packageSkillPath zips directory contents with SKILL.md at bundle root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soku-brand-skill-'))
  try {
    writeFileSync(
      join(dir, 'SKILL.md'),
      ['---', 'name: Test Skill', 'description: Test skill', '---', '', '# Test'].join('\n'),
    )
    writeFileSync(join(dir, 'notes.md'), 'hello')
    writeFileSync(join(dir, '.DS_Store'), 'ignored')

    const result = packageSkillPath(dir)
    const zip = unzipSync(result.bytes)

    assert.equal(result.filename, `${dir.split('/').pop()}.zip`)
    assert.ok(zip['SKILL.md'])
    assert.ok(zip['notes.md'])
    assert.equal(zip['.DS_Store'], undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
