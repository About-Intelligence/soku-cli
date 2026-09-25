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

test('Meta generated writes reach HTTP without TikTok fields', async (t) => {
  const payloads = [
    ['create_adset', { platform: 'meta', account_id: 'test-account', campaign_id: 'test-campaign', name: 'test', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS', targeting: { geo_locations: { countries: ['US'] } } }],
    ['create_ad', { platform: 'meta', account_id: 'test-account', adset_id: 'test-adset', creative_id: 'test-creative', name: 'test' }],
  ] as const
  for (const [action, payload] of payloads) {
    await t.test(action, async child => {
      const args = ['ads', action.replace(/_/g, '-'), '--summary', 'test']
      for (const [key, value] of Object.entries(payload)) {
        args.push(`--${key.replace(/_/g, '-')}`, typeof value === 'object' ? JSON.stringify(value) : value)
      }
      const result = await runCliCommand(child, args, { status: 'pending_review', pending_review_id: 'test-review' }, 202,
        program => { buildGeneratedCommands(program, loadManifest()) })
      assert.equal(result.requests.length, 1)
      assert.equal(result.requests[0].url, `https://cli-contract.invalid/api/cli/call/ads/${action}`)
      assert.deepEqual(JSON.parse(String(result.requests[0].init?.body)), { ...payload, _summary: 'test' })
      assert.equal(result.output.data.review_id, 'test-review')
      assert.equal(result.code, 0)
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

// ── Review-gated writes: summaries, approval links, Always rules ─────────────

const gatedActions = new Set(
  loadManifest().actions.filter((a) => a.requires_review).map((a) => `${a.namespace}/${a.action}`),
)

test('every hand-written ads call to a review-gated action sends a _summary', () => {
  // The server refuses a review-gated call without `_summary` (400
  // summary_required). Generated commands inject `--summary` from the
  // manifest; hand-written ones must add it themselves, and `upload-images`
  // once did not — every call failed. This reads the source so a new
  // hand-written call site cannot reintroduce that.
  const source = ['src/commands/ads.ts', 'src/commands/ads-video.ts']
    .map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
    .join('\n')
  const literalCalls = [...source.matchAll(/callTypedAction\('(\w+)', '(\w+)', \{([\s\S]*?)\n\s*\}\)/g)]
  assert.ok(literalCalls.length > 0, 'expected literal callTypedAction sites')
  for (const [, namespace, action, body] of literalCalls) {
    if (gatedActions.has(`${namespace}/${action}`)) {
      assert.match(body, /_summary:/, `${namespace}/${action} is review-gated but sends no _summary`)
    }
  }
  for (const [, action] of source.matchAll(/runChatgptRead\('(\w+)'/g)) {
    assert.ok(!gatedActions.has(`ads/${action}`), `runChatgptRead reaches review-gated ads/${action}`)
  }
  const runAdsWrite = source.slice(source.indexOf('function runAdsWrite('))
  assert.match(runAdsWrite.slice(0, runAdsWrite.indexOf('\n}\n')), /payload\._summary = opts\.summary/)
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Server answers for one stored-media upload (presign, PUT, confirm), shaped
 * like apps/api/routers/cli/media.py. */
function mediaUploadResponses(assetId: string, contentType: string): Response[] {
  return [
    json({
      upload_url: `https://storage.invalid/put/${assetId}`,
      object_key: `media-assets/o/cli/b/${assetId}.bin`,
      content_type: contentType,
      expires_in_seconds: 3600,
    }),
    new Response(null, { status: 200 }),
    json({ media_asset_id: assetId, kind: contentType.split('/')[0], size_bytes: 9, content_type: contentType, filename: 'f' }),
  ]
}

function scripted(responses: Response[]): (n: number) => Response {
  return (n: number) => {
    const next = responses[n - 1]
    if (!next) throw new Error(`unexpected request #${n}`)
    return next
  }
}

test('upload-images stores a local image in Soku and sends its id, not its bytes', async (t) => {
  const { registerAdsCommands } = await import('./ads.js')
  const dir = mkdtempSync(join(tmpdir(), 'soku-upload-images-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const image = join(dir, 'hero.png')
  writeFileSync(image, 'png-bytes')
  const result = await runCliCommand(
    t,
    ['ads', 'meta', 'asset', 'upload-images', '--account-id', 'act_1', image],
    scripted([
      ...mediaUploadResponses('img-1', 'image/png'),
      json({ status: 'pending_review', pending_review_id: 'test-review' }, 202),
    ]),
    200,
    registerAdsCommands,
  )
  const [presign, put, confirm, call] = result.requests
  assert.equal(new URL(presign.url).pathname, '/api/cli/media/uploads')
  assert.deepEqual(JSON.parse(String(presign.init?.body)), {
    filename: 'hero.png', content_type: 'image/png', size: 9, kind: 'image',
  })
  assert.equal(put.init?.method, 'PUT')
  assert.deepEqual(put.init?.headers, { 'Content-Type': 'image/png' })
  assert.equal(new URL(confirm.url).pathname, '/api/cli/media/uploads/confirm')
  const payload = JSON.parse(String(call.init?.body))
  assert.equal(new URL(call.url).pathname, '/api/cli/call/ads/upload_images')
  assert.deepEqual(payload.images, [{ client_ref: image, media_asset_id: 'img-1', name: 'hero.png' }])
  assert.equal(payload._summary, 'Upload 1 image to Meta ad account act_1: hero.png')
  assert.equal(result.code, 0)
})

test('upload-images sends the bytes inline when the server has no media upload', async (t) => {
  const { registerAdsCommands } = await import('./ads.js')
  const dir = mkdtempSync(join(tmpdir(), 'soku-upload-images-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const image = join(dir, 'hero.png')
  writeFileSync(image, 'png-bytes')
  const result = await runCliCommand(
    t,
    ['ads', 'meta', 'asset', 'upload-images', '--account-id', 'act_1', image],
    scripted([
      json({ detail: 'Not Found' }, 404),
      json({ status: 'pending_review', pending_review_id: 'test-review' }, 202),
    ]),
    200,
    registerAdsCommands,
  )
  const payload = JSON.parse(String(result.requests[1].init?.body))
  assert.equal(payload.images[0].bytes_base64, Buffer.from('png-bytes').toString('base64'))
  assert.equal(payload.images[0].media_asset_id, undefined)
  assert.equal(result.code, 0)
})

test('deploy-videos uploads each file and asks for one approval for the whole batch', async (t) => {
  const { registerAdsCommands } = await import('./ads.js')
  const dir = mkdtempSync(join(tmpdir(), 'soku-deploy-videos-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const first = join(dir, 'TalkingHead_01.mp4')
  const second = join(dir, 'TalkingHead_02.MOV')
  writeFileSync(first, 'mp4-bytes')
  writeFileSync(second, 'mov-bytes')
  const links = {
    approve_url: 'https://soku.test/o/acme/b/blue/approvals/test-review',
    inbox_url: 'https://soku.test/o/acme/b/blue/approvals',
  }
  const result = await runCliCommand(
    t,
    [
      'ads', 'meta', 'ad', 'deploy-videos', first, second,
      '--account-id', 'act_1', '--adset-id', '120250667120980043', '--page-id', '555',
      '--video-id', '9001', '--message', 'Watch this',
    ],
    scripted([
      ...mediaUploadResponses('vid-1', 'video/mp4'),
      ...mediaUploadResponses('vid-2', 'video/quicktime'),
      json({ status: 'pending_review', pending_review_id: 'test-review', summary: 's', ...links }, 202),
    ]),
    200,
    registerAdsCommands,
  )
  assert.equal(result.requests.length, 7)
  assert.equal(JSON.parse(String(result.requests[0].init?.body)).kind, 'video')
  assert.deepEqual(result.requests[4].init?.headers, { 'Content-Type': 'video/quicktime' })
  const call = result.requests[6]
  assert.equal(new URL(call.url).pathname, '/api/cli/call/ads/deploy_video_ads_batch')
  const payload = JSON.parse(String(call.init?.body))
  assert.deepEqual(payload.items, [
    { client_ref: 'TalkingHead_01', name: 'TalkingHead_01', media_asset_id: 'vid-1' },
    { client_ref: 'TalkingHead_02', name: 'TalkingHead_02', media_asset_id: 'vid-2' },
    { client_ref: 'video-9001', name: 'Video 9001', video_id: '9001' },
  ])
  assert.equal(payload.adset_id, '120250667120980043')
  assert.equal(payload.message, 'Watch this')
  // The server requires every literal target id in the summary.
  assert.match(payload._summary, /\b120250667120980043\b/)
  assert.equal(result.output.data.approve_url, links.approve_url)
  assert.equal(result.code, 0)
})

test('deploy-videos refuses a file it cannot send before uploading anything', async (t) => {
  const { registerAdsCommands } = await import('./ads.js')
  const result = await runCliCommand(
    t,
    ['ads', 'meta', 'ad', 'deploy-videos', 'notes.txt', '--account-id', 'a', '--adset-id', 'b', '--page-id', 'c'],
    scripted([]),
    200,
    registerAdsCommands,
  )
  assert.equal(result.requests.length, 0)
  assert.notEqual(result.code, 0)
})

test('upload-video asks for one approval per file and hands over the inbox', async (t) => {
  const { registerAdsCommands } = await import('./ads.js')
  const dir = mkdtempSync(join(tmpdir(), 'soku-upload-video-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const clips = ['a.mp4', 'b.mp4'].map((name) => {
    const path = join(dir, name)
    writeFileSync(path, 'bytes')
    return path
  })
  const inbox = 'https://soku.test/o/acme/b/blue/approvals'
  const pending = (id: string) =>
    json({ status: 'pending_review', pending_review_id: id, approve_url: `${inbox}/${id}`, inbox_url: inbox }, 202)
  const result = await runCliCommand(
    t,
    ['ads', 'meta', 'asset', 'upload-video', ...clips, '--account-id', 'act_1'],
    scripted([
      ...mediaUploadResponses('vid-a', 'video/mp4'),
      pending('r-a'),
      ...mediaUploadResponses('vid-b', 'video/mp4'),
      pending('r-b'),
    ]),
    200,
    registerAdsCommands,
  )
  const calls = result.requests.filter((r) => r.url.includes('/api/cli/call/'))
  assert.deepEqual(
    calls.map((c) => JSON.parse(String(c.init?.body)).media_asset_id),
    ['vid-a', 'vid-b'],
  )
  assert.equal(JSON.parse(String(calls[0].init?.body))._summary, 'Upload video a.mp4 to Meta ad account act_1')
  assert.deepEqual(result.output.data.review_ids, ['r-a', 'r-b'])
  assert.equal(result.output.data.inbox_url, inbox)
  assert.equal(result.code, 0)
})

test('a pending review hands the agent the approval links', async (t) => {
  const spec = loadManifest().actions.find((a) => a.namespace === 'ads' && a.action === 'create_ad')
  assert.ok(spec)
  const links = {
    approve_url: 'https://soku.test/o/acme/b/blue/approvals/test-review',
    inbox_url: 'https://soku.test/o/acme/b/blue/approvals',
  }
  const result = await runCliCommand(
    t,
    ['ads', 'create-ad', '--summary', 'test', '--platform', 'meta', '--account-id', 'a', '--adset-id', 'b', '--creative-id', 'c', '--name', 'n'],
    { status: 'pending_review', pending_review_id: 'test-review', summary: 'test', ...links },
    202,
    (program) => { buildGeneratedCommands(program, { actions: [spec] }) },
  )
  assert.deepEqual(result.output.data, {
    status: 'pending_review', review_id: 'test-review', summary: 'test', ...links,
  })
})

test('a write an Always rule approved prints its result, not a pending review', async (t) => {
  const spec = loadManifest().actions.find((a) => a.namespace === 'ads' && a.action === 'create_ad')
  assert.ok(spec)
  const result = await runCliCommand(
    t,
    ['ads', 'create-ad', '--summary', 'test', '--platform', 'meta', '--account-id', 'a', '--adset-id', 'b', '--creative-id', 'c', '--name', 'n'],
    { ok: true, data: { ad_id: '42' }, error: null, review_id: 'test-review', auto_approved: true },
    200,
    (program) => { buildGeneratedCommands(program, { actions: [spec] }) },
  )
  assert.deepEqual(result.output.data, { ad_id: '42' })
  assert.equal(result.code, 0)
})

test('review wait exits non-zero when the person denies the write', async (t) => {
  const { registerReviewCommands } = await import('./review.js')
  const denied = { id: 'r1', namespace: 'ads', action: 'create_ad', status: 'rejected', summary: 's' }
  const result = await runCliCommand(t, ['review', 'wait', 'r1'], denied, 200, registerReviewCommands)
  assert.match(result.requests[0].url, /\/api\/cli\/reviews\/r1$/)
  assert.deepEqual(result.output.data.reviews.map((r: { status: string }) => r.status), ['rejected'])
  assert.equal(result.code, 5)
})
