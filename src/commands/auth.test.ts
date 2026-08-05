import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { loadConfig } from '../config.js'
import {
  authStatusPayload,
  renderAuthStatus,
  storeTokenWorkspace,
  type AuthStatusMe,
} from './auth.js'

let home: string
const origHome = process.env.HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'soku-auth-'))
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = origHome
  rmSync(home, { recursive: true, force: true })
})

test('storeTokenWorkspace writes active org and brand ids', () => {
  const stored = storeTokenWorkspace({
    organization_id: 'org-1',
    brand_id: 'brand-1',
    organization_name: 'Acme Org',
    organization_slug: 'acme-org',
    brand_name: 'Acme Brand',
    brand_slug: 'acme-brand',
  })

  assert.equal(stored, true)
  assert.deepEqual(loadConfig(), { activeOrgId: 'org-1', activeBrandId: 'brand-1' })
})

test('storeTokenWorkspace ignores missing workspace metadata', () => {
  assert.equal(storeTokenWorkspace(undefined), false)
  assert.deepEqual(loadConfig(), {})
})

test('auth status passes session identity through the envelope', () => {
  const me: AuthStatusMe = {
    owner_id: 'user-1',
    scope_type: 'user',
  }

  assert.deepEqual(authStatusPayload(me), {
    signed_in: true,
    owner_id: 'user-1',
    scope_type: 'user',
  })
  // Colors are no-ops when stdout is not a TTY, so the render is plain text.
  assert.equal(renderAuthStatus(me), '✓ Signed in (user)\n  owner: user-1')
})
