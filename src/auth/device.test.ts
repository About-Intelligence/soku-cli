import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_RESOURCE_SCOPE, requestDeviceCode } from './device.js'

async function captureDeviceCodeRequest(scope?: string): Promise<unknown> {
  const originalFetch = globalThis.fetch
  let requestBody: unknown = null
  globalThis.fetch = (async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        device_code: 'device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://app.test/device',
        verification_uri_complete: 'https://app.test/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 5,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    await requestDeviceCode({ apiBase: 'https://api.test', scope })
  } finally {
    globalThis.fetch = originalFetch
  }

  return requestBody
}

test('requestDeviceCode requests the full default resource scope', async () => {
  const requestBody = await captureDeviceCodeRequest()

  assert.deepEqual(requestBody, {
    client_id: 'soku-cli',
    scope: DEFAULT_RESOURCE_SCOPE,
    client_capabilities: ['workspace_selection_v1'],
  })
})

test('requestDeviceCode preserves an explicit restricted scope', async () => {
  const requestBody = await captureDeviceCodeRequest('data-infra')

  assert.deepEqual(requestBody, {
    client_id: 'soku-cli',
    scope: 'data-infra',
    client_capabilities: ['workspace_selection_v1'],
  })
})
