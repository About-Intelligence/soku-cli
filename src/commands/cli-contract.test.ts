import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Command } from 'commander'
import { registerBrandSkillCommands } from './brand-skill.js'
import { buildGeneratedCommands, loadManifest } from './generated.js'
import { registerEgressCommands } from './egress.js'

// These fixtures follow apps/api/schemas/marketplace.py and the CLI router's
// wrapper. Stub fetch, not apiRequest, so JSON and workspace headers are tested.
const communitySkill = {
  slug: 'growth-audit', name: 'Growth audit', version: '1.0.0',
  publisher_org_name: 'Test publisher', status: 'published', price_credits: 300,
  entitlement: null, installed_version: null, update_available: false,
}

async function runCliCommand(
  t: test.TestContext,
  args: string[],
  response: unknown,
  status = 200,
  register?: (program: Command) => void,
) {
  const env = { ...process.env }
  Object.assign(process.env, {
    SOKU_TOKEN: 'test-token', SOKU_ORG_ID: 'test-org', SOKU_BRAND_ID: 'test-brand',
    SOKU_API_BASE: 'https://cli-contract.invalid', SOKU_NO_KEYCHAIN: '1',
  })
  t.after(() => { process.env = env })
  const requests: Array<{ url: string; init?: RequestInit }> = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    if (typeof response === 'function') return response(requests.length)
    return new Response(JSON.stringify(response), { status, headers: { 'Content-Type': 'application/json' } })
  })
  let output = ''
  const stdoutWrite = process.stdout.write
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...args: unknown[]) => {
    if (typeof chunk !== 'string') return Reflect.apply(stdoutWrite, process.stdout, [chunk, ...args])
    output += chunk
    return true
  })
  t.mock.method(process.stderr, 'write', (chunk: string) => { output += chunk; return true })
  const stopped = new Error('test exit')
  let code: unknown
  t.mock.method(process, 'exit', (value: unknown) => { code = value; throw stopped })
  const program = new Command().exitOverride()
  program.configureOutput({ writeErr: () => {} })
  if (register) register(program)
  else registerBrandSkillCommands(program.command('brand'))
  try {
    await program.parseAsync(register ? args : ['brand', 'skill', ...args], { from: 'user' })
    assert.fail('command must exit')
  } catch (err) {
    if (err !== stopped) throw err
  }
  return { requests, code, output: output ? JSON.parse(output) : undefined }
}

test('community list encodes filters and preserves purchase and pagination fields', async (t) => {
  const response = { brand_id: 'test-brand', skills: [communitySkill], count: 1, total: 40 }
  const result = await runCliCommand(t, ['community', 'list', '--query', 'ads & seo', '--category', 'analytics', '--sort', 'installs', '--limit', '10', '--offset', '20'], response)
  const url = new URL(result.requests[0].url)
  assert.equal(url.pathname, '/api/cli/brand-skills/community')
  assert.deepEqual(Object.fromEntries(url.searchParams), { q: 'ads & seo', category: 'analytics', sort: 'installs', limit: '10', offset: '20' })
  assert.equal(result.requests[0].init?.method, 'GET')
  assert.deepEqual(result.requests[0].init?.headers, { Authorization: 'Bearer test-token', Accept: 'application/json', 'X-Soku-Org': 'test-org', 'X-Soku-Brand': 'test-brand' })
  assert.equal(result.code, 0)
  assert.deepEqual(result.output.data, response)
})

test('community install never infers a price or retries purchase_required', async (t) => {
  const result = await runCliCommand(t, ['community', 'install', 'growth-audit'], { detail: { error: 'purchase_required', message: 'Purchase required: 300 credits', details: { slug: 'growth-audit', price_credits: 300, code: 'purchase_required' } } }, 402)
  assert.equal(result.requests.length, 1)
  assert.equal(result.requests[0].init?.body, undefined)
  assert.match(result.requests[0].url, /\/community\/growth-audit\/install$/)
  assert.equal(result.requests[0].init?.method, 'POST')
  assert.notEqual(result.code, 0)
  assert.equal(result.output.error.type, 'purchase_required')
})

test('community install sends the exact agreed price, including zero', async (t) => {
  const response = { brand_id: 'test-brand', skill: { slug: 'growth-audit', skill_meta: { name: 'Growth audit' } }, upgraded: true }
  const result = await runCliCommand(t, ['community', 'install', 'growth-audit', '--expected-price-credits', '0'], response)
  assert.deepEqual(JSON.parse(String(result.requests[0].init?.body)), { expected_price_credits: 0 })
  assert.deepEqual(result.output.data, response)
})

test('community install preserves stale-price errors without retrying', async (t) => {
  const result = await runCliCommand(t, ['community', 'install', 'growth-audit', '--expected-price-credits', '300'], { detail: { error: 'conflict', message: 'The price changed to 400 credits', details: { slug: 'growth-audit', price_credits: 400, code: 'price_changed' } } }, 409)
  assert.equal(result.requests.length, 1)
  assert.deepEqual(JSON.parse(String(result.requests[0].init?.body)), { expected_price_credits: 300 })
  assert.equal(result.output.error.type, 'conflict')
  assert.deepEqual(result.output.error.details, { slug: 'growth-audit', price_credits: 400, code: 'price_changed' })
  assert.notEqual(result.code, 0)
})

test('publish sends overrides and preserves pending review state', async (t) => {
  const response = { brand_id: 'test-brand', skill: { ...communitySkill, status: 'pending_review', pending_version: { version: '2.0.0', review_status: 'pending_review', review_note: null, published_at: '2026-09-18T00:00:00Z' } }, version: { version: '2.0.0' } }
  const result = await runCliCommand(t, ['publish', 'growth-audit', '--categories', 'SEO,analytics,seo', '--price-credits', '300'], response)
  assert.match(result.requests[0].url, /\/uploaded\/growth-audit\/publish$/)
  assert.equal(result.requests[0].init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(result.requests[0].init?.body)), { categories: ['seo', 'analytics'], price_credits: 300 })
  assert.deepEqual(result.output.data, response)
})

test('publish omission preserves the listing price instead of resetting it to free', async (t) => {
  const result = await runCliCommand(t, ['publish', 'growth-audit'], { skill: communitySkill, version: { version: '1.0.0' } })
  assert.deepEqual(JSON.parse(String(result.requests[0].init?.body)), {})
})

test('community options reject invalid prices and pagination before any request', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('must not request on invalid input') })
  for (const args of [
    ['community', 'list', '--limit', '0'], ['community', 'list', '--limit', '101'],
    ['community', 'list', '--offset', '-1'], ['community', 'list', '--sort', 'price'],
    ['community', 'install', 'growth-audit', '--expected-price-credits', '1.5'],
    ['publish', 'growth-audit', '--price-credits', '99'],
    ['publish', 'growth-audit', '--price-credits', '20001'],
  ]) {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} })
    registerBrandSkillCommands(program.command('brand'))
    await assert.rejects(program.parseAsync(['brand', 'skill', ...args], { from: 'user' }), /invalid|allowed/i)
  }
})


test('generated boolean values survive JSON serialization at the HTTP boundary', async (t) => {
  const spec = loadManifest().actions.find((action) => action.namespace === 'thinkingdata' && action.action === 'query_metric')
  assert.ok(spec)
  const baseArgs = ['thinkingdata', 'query-metric']
  for (const param of spec.input_params.filter((param) => param.required && param.type !== 'boolean')) {
    baseArgs.push(`--${param.name.replace(/_/g, '-')}`, /object|list/.test(param.type) ? '{}' : 'test-value')
  }
  for (const [flags, expected] of [[[], undefined], [['--use-cache'], true], [['--no-use-cache'], false]] as const) {
    await t.test(String(expected), async (child) => {
      const result = await runCliCommand(child, [...baseArgs, ...flags], { result: { rows: [] } }, 200, (program) => {
        buildGeneratedCommands(program, { actions: [spec] })
      })
      assert.match(result.requests[0].url, /\/call\/thinkingdata\/query_metric$/)
      const payload = JSON.parse(String(result.requests[0].init?.body))
      assert.equal(payload.use_cache, expected)
      assert.equal(Object.hasOwn(payload, 'use_cache'), expected !== undefined)
    })
  }
})


test('egress discovery preserves full card contracts while filtering', async (t) => {
  const card = { provider: 'adyntel', slug: 'linkedin_ads', title: 'LinkedIn ads', summary: 'Search ads', params: [{ name: 'company_domain', type: 'string', location: 'body' }], quote_usd_micros: 1000 }
  const result = await runCliCommand(t, ['egress', 'capabilities', '--provider', 'adyntel', '--query', 'linkedin'], { capabilities: [card, { ...card, provider: 'another' }], count: 2 }, 200, registerEgressCommands)
  assert.match(result.requests[0].url, /\/egress\/capabilities$/)
  assert.deepEqual(result.output.data, { capabilities: [card], count: 1 })
})

// The server binder returns a JSON body separately from the request headers.
const boundRequest = { method: 'POST', url: 'https://api.adyntel.com/linkedin', headers: {}, body: { company_domain: 'example.test' }, quote_usd_micros: 1000 }

test('egress dry-run only binds arguments and never executes the vendor request', async (t) => {
  const result = await runCliCommand(t, ['egress', 'call', 'adyntel', 'linkedin_ads', '--args', '{"company_domain":"example.test"}', '--dry-run'], boundRequest, 200, registerEgressCommands)
  assert.equal(result.requests.length, 1)
  assert.match(result.requests[0].url, /\/egress\/capabilities\/adyntel\/linkedin_ads\/request$/)
  assert.deepEqual(JSON.parse(String(result.requests[0].init?.body)), { arguments: { company_domain: 'example.test' } })
  assert.deepEqual(result.output.data, boundRequest)
})

test('egress call forwards the bound body through existing egress and writes raw output', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'soku-egress-contract-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const argsFile = join(dir, 'arguments.json')
  const outputFile = join(dir, 'result.json')
  writeFileSync(argsFile, '{"company_domain":"example.test"}')
  const upstream = '{"ads":[{"id":"test-ad"}]}'
  const result = await runCliCommand(t, ['egress', 'call', 'adyntel', 'linkedin_ads', '--args', `@${argsFile}`, '--output', outputFile], (index: number) => index === 1
    ? new Response(JSON.stringify(boundRequest))
    : new Response(upstream, { headers: { 'x-soku-egress': 'upstream' } }), 200, registerEgressCommands)
  assert.equal(result.requests.length, 2)
  assert.match(result.requests[1].url, /\/api\/cli\/egress$/)
  const headers = new Headers(result.requests[1].init?.headers)
  const spec = JSON.parse(Buffer.from(headers.get('X-Soku-Egress-Spec')!, 'base64').toString())
  assert.equal(spec.url, boundRequest.url)
  assert.equal(spec.method, 'POST')
  assert.equal(spec.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(String(result.requests[1].init?.body)), boundRequest.body)
  assert.equal(readFileSync(outputFile, 'utf8'), upstream)
  assert.equal(result.code, 0)
})

test('egress binder rejection stops before the metered call', async (t) => {
  const result = await runCliCommand(t, ['egress', 'call', 'adyntel', 'linkedin_ads'], { detail: { error: 'invalid_arguments', message: 'at least one search parameter is required' } }, 400, registerEgressCommands)
  assert.equal(result.requests.length, 1)
  assert.equal(result.output.error.type, 'invalid_arguments')
  assert.notEqual(result.code, 0)
})
