import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveActiveWorkspace } from './workspace.js'

/** Config resolves under $HOME, so each case gets its own home directory. */
function isolateHome(config?: Record<string, string>): void {
  const home = mkdtempSync(join(tmpdir(), 'soku-ws-'))
  process.env.HOME = home
  if (config) {
    mkdirSync(join(home, '.soku'), { recursive: true })
    writeFileSync(join(home, '.soku', 'config.json'), JSON.stringify(config))
  }
  delete process.env.SOKU_ORG_ID
  delete process.env.SOKU_BRAND_ID
}

test('falls back to saved config when no env override is set', () => {
  isolateHome({ activeOrgId: 'org-cfg', activeBrandId: 'brand-cfg' })
  assert.deepEqual(resolveActiveWorkspace(), {
    orgId: 'org-cfg',
    brandId: 'brand-cfg',
    source: 'config',
  })
})

test('env overrides win, exactly as they do for the actual requests', () => {
  // This is the case that used to report "(none)" while every write went to the
  // env-specified brand — the pre-write check could not see the real target.
  isolateHome({ activeOrgId: 'org-cfg', activeBrandId: 'brand-cfg' })
  process.env.SOKU_ORG_ID = 'org-env'
  process.env.SOKU_BRAND_ID = 'brand-env'
  assert.deepEqual(resolveActiveWorkspace(), {
    orgId: 'org-env',
    brandId: 'brand-env',
    source: 'env',
  })
})

test('an env override with no saved config at all still resolves', () => {
  isolateHome()
  process.env.SOKU_ORG_ID = 'org-env'
  process.env.SOKU_BRAND_ID = 'brand-env'
  assert.deepEqual(resolveActiveWorkspace(), {
    orgId: 'org-env',
    brandId: 'brand-env',
    source: 'env',
  })
})

test('one override alone still makes the effective workspace env-decided', () => {
  // Either variable alone changes where requests go, so reporting "config"
  // would tell an operator that `use-brand` controls the target when it does not.
  isolateHome({ activeOrgId: 'org-cfg', activeBrandId: 'brand-cfg' })
  process.env.SOKU_BRAND_ID = 'brand-env'
  assert.deepEqual(resolveActiveWorkspace(), {
    orgId: 'org-cfg',
    brandId: 'brand-env',
    source: 'env',
  })
})

test('nothing configured anywhere resolves to nulls, not a crash', () => {
  isolateHome()
  assert.deepEqual(resolveActiveWorkspace(), {
    orgId: null,
    brandId: null,
    source: 'config',
  })
})
