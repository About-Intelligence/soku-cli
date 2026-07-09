import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { loadConfig, resolveApiBaseUrl, resolveSkillsBaseUrl, saveConfig, updateConfig } from './config.js'

let home: string
const origHome = process.env.HOME
const origApiBase = process.env.SOKU_API_BASE
const origSkillsUrl = process.env.SOKU_SKILLS_URL

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'soku-cfg-'))
  process.env.HOME = home
  delete process.env.SOKU_API_BASE
  delete process.env.SOKU_SKILLS_URL
})

afterEach(() => {
  process.env.HOME = origHome
  if (origApiBase === undefined) delete process.env.SOKU_API_BASE
  else process.env.SOKU_API_BASE = origApiBase
  if (origSkillsUrl === undefined) delete process.env.SOKU_SKILLS_URL
  else process.env.SOKU_SKILLS_URL = origSkillsUrl
  rmSync(home, { recursive: true, force: true })
})

test('loadConfig returns empty object when no file', () => {
  assert.deepEqual(loadConfig(), {})
})

test('saveConfig + loadConfig round-trip', () => {
  saveConfig({ activeOrgId: 'org-1', activeBrandId: 'brand-1' })
  assert.deepEqual(loadConfig(), { activeOrgId: 'org-1', activeBrandId: 'brand-1' })
})

test('updateConfig merges patch over existing', () => {
  saveConfig({ activeOrgId: 'org-1', activeBrandId: 'brand-1' })
  const next = updateConfig({ activeBrandId: 'brand-2' })
  assert.equal(next.activeOrgId, 'org-1')
  assert.equal(next.activeBrandId, 'brand-2')
})

test('resolveApiBaseUrl ignores persisted endpoint config', () => {
  saveConfig({ apiBaseUrl: 'http://localhost:15386' })
  assert.equal(resolveApiBaseUrl(), 'https://api.soku.ai')
})

test('resolveApiBaseUrl precedence: flag > env > default', () => {
  process.env.SOKU_API_BASE = 'https://from-env/'
  assert.equal(resolveApiBaseUrl(), 'https://from-env')
  assert.equal(resolveApiBaseUrl('https://from-flag/'), 'https://from-flag')
})

test('resolveApiBaseUrl falls back to default', () => {
  assert.equal(resolveApiBaseUrl(), 'https://api.soku.ai')
})

test('resolveSkillsBaseUrl ignores persisted catalog config', () => {
  saveConfig({ skillsBaseUrl: 'http://localhost:18080' })
  assert.equal(resolveSkillsBaseUrl(), 'https://api.soku.ai/api/cli/skills')
})

test('resolveSkillsBaseUrl precedence: flag > env > default', () => {
  process.env.SOKU_SKILLS_URL = 'https://skills-env/'
  assert.equal(resolveSkillsBaseUrl(), 'https://skills-env')
  assert.equal(resolveSkillsBaseUrl('https://skills-flag/'), 'https://skills-flag')
})
