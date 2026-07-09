import { strict as assert } from 'node:assert'
import test from 'node:test'

import { Command } from 'commander'

import {
  buildPagePutPayload,
  domainConnectionPath,
  parseSeoOverride,
  parseSections,
  readCloudflareToken,
  readHtmlBody,
  renderHostingStatus,
  renderPage,
  renderPages,
  registerSeoHostingCommands,
  SeoHostingUsageError,
  seoHostingCallPath,
  workerProbeBlocker,
  type WorkerProbeResponse,
} from './seo-hosting.js'

test('seo-hosting command exposes page and domain connection workflows', () => {
  const program = new Command()
  registerSeoHostingCommands(program)

  const seoHosting = program.commands.find((cmd) => cmd.name() === 'seo-hosting')
  assert.ok(seoHosting)
  assert.deepEqual(
    seoHosting.commands.map((cmd) => cmd.name()).sort(),
    ['connections', 'pages', 'status'],
  )

  const pages = seoHosting.commands.find((cmd) => cmd.name() === 'pages')
  assert.ok(pages)
  assert.deepEqual(
    pages.commands.map((cmd) => cmd.name()).sort(),
    ['delete', 'list', 'publish', 'put', 'unpublish', 'upload-asset'],
  )

  const connections = seoHosting.commands.find((cmd) => cmd.name() === 'connections')
  assert.ok(connections)
  assert.deepEqual(connections.commands.map((cmd) => cmd.name()).sort(), [
    'connect-cname',
    'connect-worker',
    'disconnect',
    'list',
    'probe',
    'verify',
  ])
})

test('seo-hosting call paths encode action names', () => {
  assert.equal(seoHostingCallPath('put_page'), '/api/cli/call/seo_hosting/put_page')
  assert.equal(
    seoHostingCallPath('action/with/slash'),
    '/api/cli/call/seo_hosting/action%2Fwith%2Fslash',
  )
})

test('domain connection paths encode connection ids', () => {
  assert.equal(domainConnectionPath(), '/api/cli/seo-hosting/domain-connections')
  assert.equal(
    domainConnectionPath('id/with/slash', 'verify'),
    '/api/cli/seo-hosting/domain-connections/id%2Fwith%2Fslash/verify',
  )
})

test('section parsing defaults, deduplicates, and validates', () => {
  assert.deepEqual(parseSections(), ['blog'])
  assert.deepEqual(parseSections('blog,use-cases,blog'), ['blog', 'use-cases'])
  assert.throws(() => parseSections('blog,pricing'), SeoHostingUsageError)
})

test('SEO overrides must be JSON objects', () => {
  assert.deepEqual(parseSeoOverride('{"keywords":["seo"]}'), { keywords: ['seo'] })
  assert.throws(() => parseSeoOverride('not-json'), SeoHostingUsageError)
  assert.throws(() => parseSeoOverride('["seo"]'), SeoHostingUsageError)
})

test('HTML body input requires exactly one non-empty source', async () => {
  await assert.rejects(() => readHtmlBody({}), /exactly one HTML source/)
  await assert.rejects(
    () => readHtmlBody({ html: 'a', htmlFile: 'page.html' }),
    /exactly one HTML source/,
  )
  await assert.rejects(
    () => readHtmlBody({ htmlFile: '/tmp/soku-missing-page.html' }),
    /Could not read HTML file/,
  )
  await assert.rejects(() => readHtmlBody({ html: '   ' }), /cannot be empty/)
  assert.equal(await readHtmlBody({ html: '<h1>Hi</h1>' }), '<h1>Hi</h1>')
})

test('page put payload maps CLI options to seo_hosting put_page', async () => {
  assert.deepEqual(
    await buildPagePutPayload({
      section: 'blog',
      slug: 'launch-plan',
      title: 'Launch Plan',
      html: '<!doctype html><html><body><h1>Launch</h1></body></html>',
      description: 'Short',
      template: 'article',
      seo: '{"metaTitle":"Launch Plan","keywords":["launch"]}',
    }),
    {
      section: 'blog',
      slug: 'launch-plan',
      title: 'Launch Plan',
      html: '<!doctype html><html><body><h1>Launch</h1></body></html>',
      description: 'Short',
      template: 'article',
      seo: { metaTitle: 'Launch Plan', keywords: ['launch'] },
    },
  )
})

test('page renderers handle list and detail shapes without undefined', () => {
  assert.match(
    renderPages([
      {
        section: 'blog',
        slug: 'launch',
        title: 'Launch',
        status: 'draft',
        url_path: '/blog/launch',
      },
    ]),
    /Launch/,
  )
  const detail = renderPage({
    section: 'blog',
    slug: 'launch',
    title: 'Launch',
    status: 'published',
    url_path: '/blog/launch',
    public_url: 'https://blog.example.com/blog/launch',
    served: true,
  })
  assert.match(detail, /\/blog\/launch/)
  assert.match(detail, /published/)
  assert.doesNotMatch(detail, /undefined/)

  // Advisory link warnings (from publish) are surfaced; absent → not shown.
  assert.doesNotMatch(detail, /Link warnings/)
  const withWarnings = renderPage({
    section: 'blog',
    slug: 'launch',
    title: 'Launch',
    status: 'published',
    url_path: '/blog/launch',
    link_warnings: ["Link '/contact' targets '/contact', which is not a hosted section"],
  })
  assert.match(withWarnings, /Link warnings/)
  assert.match(withWarnings, /\/contact/)
})

test('hosting status renderer lists domains and contract', () => {
  const out = renderHostingStatus({
    domains: [
      {
        hostname: 'blog.example.com',
        method: 'cname',
        status: 'live',
        live: true,
        url_contract: 'subdomain',
        served_sections: ['blog', 'use-cases'],
        public_base_url: 'https://blog.example.com',
      },
    ],
    allowed_sections: ['blog', 'use-cases', 'alternatives'],
    asset_cdn_base_url: 'https://cdn.soku.ai',
    workspace_dir: '/brand/seo-hosting',
    note: 'author pages as files',
  })
  assert.match(out, /blog\.example\.com/)
  assert.match(out, /subdomain/)
  assert.match(out, /cdn\.soku\.ai/)
})

test('Cloudflare token source must be explicit and non-empty', async () => {
  await assert.rejects(() => readCloudflareToken({}), /exactly one Cloudflare token source/)
  await assert.rejects(
    () => readCloudflareToken({ cfTokenEnv: 'SEO_HOSTING_EMPTY_TEST_TOKEN' }),
    /empty or unset/,
  )

  const prev = process.env.SEO_HOSTING_TEST_TOKEN
  process.env.SEO_HOSTING_TEST_TOKEN = '  token-from-env  '
  try {
    assert.equal(
      await readCloudflareToken({ cfTokenEnv: 'SEO_HOSTING_TEST_TOKEN' }),
      'token-from-env',
    )
  } finally {
    if (prev === undefined) {
      delete process.env.SEO_HOSTING_TEST_TOKEN
    } else {
      process.env.SEO_HOSTING_TEST_TOKEN = prev
    }
  }
})

test('worker probe blockers enforce Cloudflare and explicit risk acknowledgements', () => {
  const base: WorkerProbeResponse = {
    is_cloudflare: true,
    conflicts: [],
    serves_next_assets: false,
    is_vercel: false,
  }

  assert.match(
    workerProbeBlocker({ ...base, is_cloudflare: false, is_vercel: true }, {})?.hint ?? '',
    /Vercel/,
  )
  assert.match(
    workerProbeBlocker({ ...base, conflicts: ['blog'] }, {})?.message ?? '',
    /Mount paths/,
  )
  assert.match(
    workerProbeBlocker({ ...base, serves_next_assets: true }, {})?.message ?? '',
    /Next\.js/,
  )
  assert.equal(
    workerProbeBlocker(
      { ...base, conflicts: ['blog'], serves_next_assets: true },
      { acceptConflicts: true, acceptNextAssetsWarning: true },
    ),
    null,
  )
})
