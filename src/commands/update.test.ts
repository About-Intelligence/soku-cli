import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadManifest, saveManifest, SOKU_META, type SkillIndex } from './skill.js'
import {
  discoverInstalledTargets,
  isAutoUpdateDue,
  targetsWithMetaSkill,
  updateSkillTarget,
  type SkillTarget,
} from './update.js'

function target(baseDir: string): SkillTarget {
  return { agent: 'claude', global: true, baseDir }
}

function emptyIndex(): SkillIndex {
  return {
    schema: 1,
    generated_at: '2026-06-04T00:00:00.000Z',
    source_commit: 'test',
    base_url: 'http://skills.example',
    count: 0,
    skills: [],
  }
}

test('auto update is due when missing, malformed, or older than the interval', () => {
  const now = new Date('2026-06-04T12:00:00.000Z')

  assert.equal(isAutoUpdateDue(undefined, now, 24), true)
  assert.equal(isAutoUpdateDue('not-a-date', now, 24), true)
  assert.equal(isAutoUpdateDue('2026-06-04T00:30:00.000Z', now, 24), false)
  assert.equal(isAutoUpdateDue('2026-06-03T12:00:00.000Z', now, 24), true)
})

test('updateSkillTarget refreshes bundled meta-skill without fetching the catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soku-update-meta-'))
  try {
    saveManifest(dir, {
      [SOKU_META]: {
        sha256: '',
        installed_at: '2026-06-01T00:00:00.000Z',
        source: 'bundled',
      },
    })

    const result = await updateSkillTarget(target(dir), 'http://skills.example', emptyIndex())

    assert.equal(result.metaUpdated, true)
    assert.deepEqual(result.updated, [])
    assert.equal(existsSync(join(dir, SOKU_META, 'SKILL.md')), true)
    assert.equal(loadManifest(dir)[SOKU_META]?.source, 'bundled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('targetsWithMetaSkill reports only targets with an on-disk SKILL.md', () => {
  const withSkill = mkdtempSync(join(tmpdir(), 'soku-meta-present-'))
  const withoutSkill = mkdtempSync(join(tmpdir(), 'soku-meta-absent-'))
  try {
    mkdirSync(join(withSkill, SOKU_META), { recursive: true })
    writeFileSync(join(withSkill, SOKU_META, 'SKILL.md'), '# soku\n')

    const paths = targetsWithMetaSkill([target(withSkill), target(withoutSkill)])

    assert.deepEqual(paths, [join(withSkill, SOKU_META, 'SKILL.md')])
  } finally {
    rmSync(withSkill, { recursive: true, force: true })
    rmSync(withoutSkill, { recursive: true, force: true })
  }
})

test('discoverInstalledTargets finds legacy meta-only project installs without a manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soku-discover-legacy-'))
  const previousCwd = process.cwd()
  try {
    const skillDir = join(dir, '.claude', 'skills', SOKU_META)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# legacy\n')

    process.chdir(dir)
    const targets = discoverInstalledTargets('claude', 'project')

    assert.equal(targets.length, 1)
    assert.equal(targets[0]?.agent, 'claude')
    assert.equal(targets[0]?.global, false)
    assert.equal(targets[0]?.baseDir, join('.claude', 'skills'))
  } finally {
    process.chdir(previousCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateSkillTarget refreshes legacy meta-only installs with references and manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soku-update-legacy-meta-'))
  try {
    const skillDir = join(dir, SOKU_META)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# old bundled skill\n')

    const result = await updateSkillTarget(target(dir), 'http://skills.example', emptyIndex())

    assert.equal(result.metaUpdated, true)
    assert.equal(existsSync(join(dir, SOKU_META, 'SKILL.md')), true)
    assert.equal(existsSync(join(dir, SOKU_META, 'references', 'auth-workspace.md')), true)
    assert.equal(loadManifest(dir)[SOKU_META]?.source, 'bundled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateSkillTarget leaves current catalog skills unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soku-update-current-'))
  const index = emptyIndex()
  index.skills.push({
    slug: 'ads-report',
    name: 'Ads Report',
    description: 'Generate ads reports.',
    version: '1.0.0',
    zip: 'ads-report.zip',
    sha256: 'abc123',
    bytes: 10,
  })

  try {
    saveManifest(dir, {
      'ads-report': {
        version: '1.0.0',
        sha256: 'abc123',
        installed_at: '2026-06-01T00:00:00.000Z',
        source: 'catalog',
      },
    })

    const result = await updateSkillTarget(target(dir), 'http://skills.example', index)

    assert.equal(result.metaUpdated, true)
    assert.deepEqual(result.updated, [])
    assert.deepEqual(result.unchanged, ['ads-report'])
    assert.equal(loadManifest(dir)['ads-report']?.sha256, 'abc123')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
