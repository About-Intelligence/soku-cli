import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { Command } from 'commander'

import { checkForUpdate, compareSemverish, maybeNotifyUpdate } from './update-check.js'
import { registerUpdateCheckCommand } from './update-check.js'

let home: string
const origHome = process.env.HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'soku-update-'))
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = origHome
  rmSync(home, { recursive: true, force: true })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('compareSemverish orders core versions and stable releases', () => {
  assert.equal(compareSemverish('0.1.1', '0.1.0-alpha.0') > 0, true)
  assert.equal(compareSemverish('0.1.0-alpha.1', '0.1.0-alpha.0') > 0, true)
  assert.equal(compareSemverish('0.1.0', '0.1.0-alpha.0') > 0, true)
  assert.equal(compareSemverish('0.1.0-alpha.0', '0.1.0') < 0, true)
  assert.equal(compareSemverish('0.1.0', '0.1.0'), 0)
})

test('checkForUpdate reports a newer published npm version', async () => {
  let requestedUrl = ''
  const result = await checkForUpdate({
    currentVersion: '0.1.0',
    fetchImpl: async (url) => {
      requestedUrl = String(url)
      return jsonResponse(200, { version: '0.1.1' })
    },
  })

  assert.equal(requestedUrl, 'https://registry.npmjs.org/%40soku-ai%2Fcli/latest')
  assert.equal(result.published, true)
  assert.equal(result.latestVersion, '0.1.1')
  assert.equal(result.updateAvailable, true)
})

test('checkForUpdate treats npm 404 as unpublished package', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.1.0-alpha.0',
    fetchImpl: async () => jsonResponse(404, { error: 'not found' }),
  })

  assert.equal(result.published, false)
  assert.equal(result.latestVersion, null)
  assert.equal(result.updateAvailable, false)
})

test('checkForUpdate fetches every time and does not write a cache file', async () => {
  let calls = 0
  const first = await checkForUpdate({
    currentVersion: '0.1.0',
    fetchImpl: async () => {
      calls += 1
      return jsonResponse(200, { version: '0.1.1' })
    },
  })

  const second = await checkForUpdate({
    currentVersion: '0.1.0',
    fetchImpl: async () => {
      calls += 1
      return jsonResponse(200, { version: '0.1.2' })
    },
  })

  assert.equal(calls, 2)
  assert.equal(first.latestVersion, '0.1.1')
  assert.equal(second.latestVersion, '0.1.2')
  assert.equal(existsSync(join(home, '.soku', 'update-check.json')), false)
})

test('maybeNotifyUpdate checks every invocation and writes advisory notices to stderr', async () => {
  const origFetch = globalThis.fetch
  const origWrite = process.stderr.write.bind(process.stderr)
  const origCi = process.env.CI
  const origDisabled = process.env.SOKU_NO_UPDATE_CHECK
  let calls = 0
  let stderr = ''

  globalThis.fetch = (async () => {
    calls += 1
    return jsonResponse(200, { version: '9.0.0' })
  }) as typeof fetch
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  delete process.env.CI
  delete process.env.SOKU_NO_UPDATE_CHECK

  try {
    await maybeNotifyUpdate()
    await maybeNotifyUpdate()
  } finally {
    globalThis.fetch = origFetch
    process.stderr.write = origWrite
    process.env.CI = origCi
    process.env.SOKU_NO_UPDATE_CHECK = origDisabled
  }

  assert.equal(calls, 2)
  assert.match(stderr, /Update available: @soku-ai\/cli/)
  assert.match(stderr, /Run soku update cli/)
})

test('legacy update-check is hidden from top-level help', () => {
  const program = new Command()
  registerUpdateCheckCommand(program)

  assert.equal(program.commands.some((cmd) => cmd.name() === 'update-check'), true)
  assert.doesNotMatch(program.helpInformation(), /update-check/)
})
