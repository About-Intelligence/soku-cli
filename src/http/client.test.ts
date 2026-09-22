import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ApiError, apiRequest } from './client.js'

/** Run one request against a fetch stub that answers with `status` + `body`,
 * and return the ApiError the client raises for it. */
async function errorFor(status: number, body: unknown): Promise<ApiError> {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.SOKU_TOKEN
  process.env.SOKU_TOKEN = 'test-token'
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
  try {
    await apiRequest('/api/cli/call/ads/create_adset', {
      method: 'POST',
      body: {},
      apiBase: 'https://api.test',
      throwOnError: true,
    })
  } catch (err) {
    assert.ok(err instanceof ApiError)
    return err
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.SOKU_TOKEN
    else process.env.SOKU_TOKEN = originalToken
  }
  assert.fail('expected the request to fail')
}

test('flat /api/cli error body: code becomes the type and message survives', async () => {
  // `_error()` in the API's CLI router answers every 4xx with this shape.
  // Before this test the code was printed AS the message and the actionable
  // detail (which field the Ads validator rejected) was dropped, so a user
  // saw `request_failed: invalid_ads_payload` and nothing to correct.
  const err = await errorFor(422, {
    error: 'invalid_ads_payload',
    message:
      '_summary must restate the target campaign id campaign_id=120210000000001 (read the object back and quote its current name and id)',
  })
  assert.equal(err.type, 'invalid_ads_payload')
  assert.equal(err.status, 422)
  assert.match(err.message, /campaign_id=120210000000001/)
  assert.equal(err.hint, undefined)
})

test('flat error body without a message falls back to the code', async () => {
  const err = await errorFor(400, { error: 'workspace_required' })
  assert.equal(err.type, 'workspace_required')
  assert.equal(err.message, 'workspace_required')
})

test('flat error body carries an optional hint', async () => {
  const err = await errorFor(400, {
    error: 'summary_required',
    message: 'review-gated actions require a `_summary`',
    hint: 'Pass --summary.',
  })
  assert.equal(err.type, 'summary_required')
  assert.equal(err.hint, 'Pass --summary.')
})

test('dispatcher error object shape is unchanged', async () => {
  const err = await errorFor(422, {
    success: false,
    error: { code: 'invalid_batch', message: 'op-1: platform is required', hint: 'see docs' },
  })
  assert.equal(err.type, 'invalid_batch')
  assert.equal(err.message, 'op-1: platform is required')
  assert.equal(err.hint, 'see docs')
})

test('FastAPI detail wrapper shape is unchanged', async () => {
  const err = await errorFor(422, {
    detail: { error: 'invalid_ads_payload', message: 'budget_daily_micros must be greater than 0' },
  })
  assert.equal(err.type, 'invalid_ads_payload')
  assert.equal(err.message, 'budget_daily_micros must be greater than 0')
})

test('non-JSON body keeps the HTTP status fallback', async () => {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.SOKU_TOKEN
  process.env.SOKU_TOKEN = 'test-token'
  globalThis.fetch = (async () => new Response('Bad Gateway', { status: 502 })) as typeof fetch
  try {
    await assert.rejects(
      apiRequest('/api/cli/me', { apiBase: 'https://api.test', throwOnError: true }),
      (err: unknown) =>
        err instanceof ApiError && err.type === 'request_failed' && err.message === 'HTTP 502',
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.SOKU_TOKEN
    else process.env.SOKU_TOKEN = originalToken
  }
})
