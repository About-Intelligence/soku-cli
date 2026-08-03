import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Command } from 'commander'

import { buildUploadImages, registerAdsEntities, resolveBudgetMicros, resolveJsonArray } from './ads.js'

function findCommand(root: Command, ...path: string[]): Command {
  let current = root
  for (const name of path) {
    const next = current.commands.find((cmd) => cmd.name() === name)
    assert.ok(next, `missing command path ${path.join(' ')}`)
    current = next!
  }
  return current
}

test('resolveBudgetMicros: USD human units convert to micros', () => {
  assert.equal(resolveBudgetMicros('50', undefined), 50_000_000)
  assert.equal(resolveBudgetMicros('1.5', undefined), 1_500_000)
})

test('resolveBudgetMicros: explicit micros wins over USD', () => {
  assert.equal(resolveBudgetMicros('50', '123'), 123)
  assert.equal(resolveBudgetMicros(undefined, '123'), 123)
})

test('resolveBudgetMicros: undefined when neither given', () => {
  assert.equal(resolveBudgetMicros(undefined, undefined), undefined)
})

test('resolveBudgetMicros: rounds fractional USD to nearest micro', () => {
  // 0.333 USD -> 333000 micros (rounds cleanly enough at this scale)
  assert.equal(resolveBudgetMicros('0.333', undefined), 333_000)
})

test('ads command tree is platform-first', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  assert.ok(findCommand(ads, 'meta'))
  assert.ok(findCommand(ads, 'google'))

  for (const oldTopLevel of ['campaign', 'adset', 'ad-group', 'ad', 'asset', 'creative', 'keyword']) {
    assert.equal(
      ads.commands.some((cmd) => cmd.name() === oldTopLevel),
      false,
      `old top-level command should be absent: ${oldTopLevel}`,
    )
  }
})

test('ads activate/pause verbs exist on platform entity groups', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  for (const path of [
    ['meta', 'campaign'],
    ['meta', 'adset'],
    ['meta', 'ad'],
    ['google', 'campaign'],
    ['google', 'ad-group'],
    ['google', 'ad'],
  ]) {
    const group = findCommand(ads, ...path)
    const verbs = group.commands.map((cmd) => cmd.name())
    assert.ok(verbs.includes('activate'), `${path.join(' ')} missing activate`)
    assert.ok(verbs.includes('pause'), `${path.join(' ')} missing pause`)
  }
})

test('ads meta asset upload-images command exposes local-file and URL upload flags', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const uploadImages = findCommand(ads, 'meta', 'asset', 'upload-images')

  const flags = uploadImages.options.map((o) => o.long)
  assert.ok(flags.includes('--account-id'))
  assert.ok(flags.includes('--url'))
  assert.ok(flags.includes('--concurrency'))
  assert.ok(flags.includes('--name-prefix'))
  assert.equal(flags.includes('--platform'), false)
})

test('buildUploadImages encodes local files directly and preserves URL items', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soku-cli-assets-'))
  try {
    const file = join(dir, 'asset.jpg')
    writeFileSync(file, Buffer.from('image-bytes'))

    const items = await buildUploadImages(
      [file],
      ['https://example.com/remote.jpg'],
      'prefix',
    )

    assert.equal(items.length, 2)
    assert.equal(items[0].client_ref, file)
    assert.equal(items[0].name, 'prefix-asset.jpg')
    assert.equal(items[0].bytes_base64, Buffer.from('image-bytes').toString('base64'))
    assert.equal(items[0].image_url, undefined)
    assert.equal(items[1].client_ref, 'https://example.com/remote.jpg')
    assert.equal(items[1].image_url, 'https://example.com/remote.jpg')
    assert.equal(items[1].bytes_base64, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ads meta creative create command exposes Meta creative fields', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const create = findCommand(ads, 'meta', 'creative', 'create')

  const flags = create.options.map((o) => o.long)
  for (const flag of [
    '--account-id',
    '--name',
    '--page-id',
    '--image-hash',
    '--image-url',
    '--video-id',
    '--child-attachments',
    '--object-story-id',
    '--link',
    '--call-to-action-type',
    '--url-tags',
    '--lead-gen-form-id',
    '--summary',
  ]) {
    assert.ok(flags.includes(flag), `missing ${flag}`)
  }
  assert.equal(flags.includes('--platform'), false)
})

test('ads google ad create uses platform-native ad-group flags', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const create = findCommand(ads, 'google', 'ad', 'create')

  const flags = create.options.map((o) => o.long)
  for (const flag of [
    '--ad-group-id',
    '--final-urls',
    '--headlines',
    '--descriptions',
    '--account-id',
    '--summary',
  ]) {
    assert.ok(flags.includes(flag), `missing ${flag}`)
  }
  assert.equal(flags.includes('--adset-id'), false)
  assert.equal(flags.includes('--platform'), false)
})

test('ads meta campaign activate exposes account-id (resolution aid) + summary', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const activate = findCommand(ads, 'meta', 'campaign', 'activate')
  const flags = activate.options.map((o) => o.long)
  assert.ok(flags.includes('--account-id'))
  assert.ok(flags.includes('--summary'))
  assert.equal(flags.includes('--platform'), false)
})

test('ads meta account pages exposes read flags without review summary', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const pages = findCommand(ads, 'meta', 'account', 'pages')
  const flags = pages.options.map((o) => o.long)
  assert.ok(flags.includes('--account-id'))
  assert.equal(flags.includes('--summary'), false)
  assert.equal(flags.includes('--platform'), false)
})

test('ads meta campaign get exposes read flags without review summary', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const get = findCommand(ads, 'meta', 'campaign', 'get')
  const flags = get.options.map((o) => o.long)
  assert.ok(flags.includes('--account-id'))
  assert.ok(flags.includes('--campaign-id'))
  assert.equal(flags.includes('--summary'), false)
  assert.equal(flags.includes('--platform'), false)
})

test('ads meta ad get exposes read flags without review summary', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const get = findCommand(ads, 'meta', 'ad', 'get')
  const flags = get.options.map((o) => o.long)
  assert.ok(flags.includes('--account-id'))
  assert.ok(flags.includes('--ad-id'))
  assert.equal(flags.includes('--summary'), false)
  assert.equal(flags.includes('--platform'), false)
})

test('ads meta adset get exposes read flags without review summary', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const get = findCommand(ads, 'meta', 'adset', 'get')
  const flags = get.options.map((o) => o.long)
  assert.ok(flags.includes('--account-id'))
  assert.ok(flags.includes('--adset-id'))
  assert.equal(flags.includes('--summary'), false)
  assert.equal(flags.includes('--platform'), false)
})

test('ads meta bulk-create commands expose items-file and review summary', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)

  for (const path of [
    ['meta', 'campaign', 'bulk-create'],
    ['meta', 'adset', 'bulk-create'],
    ['meta', 'creative', 'bulk-create'],
    ['meta', 'ad', 'bulk-create'],
  ]) {
    const cmd = findCommand(ads, ...path)
    const flags = cmd.options.map((o) => o.long)
    assert.ok(flags.includes('--account-id'), `${path.join(' ')} missing account-id`)
    assert.ok(flags.includes('--items-file'), `${path.join(' ')} missing items-file`)
    assert.ok(flags.includes('--summary'), `${path.join(' ')} missing summary`)
    assert.equal(flags.includes('--platform'), false)
  }
})

test('ads meta lead-form create decomposes privacy policy and requires follow-up url', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const create = findCommand(ads, 'meta', 'lead-form', 'create')

  const flags = create.options.map((o) => o.long)
  for (const flag of [
    '--account-id',
    '--name',
    '--page-id',
    '--questions',
    '--privacy-policy-url',
    '--privacy-policy-link-text',
    '--follow-up-action-url',
    '--thank-you-page',
    '--summary',
  ]) {
    assert.ok(flags.includes(flag), `missing ${flag}`)
  }
  // privacy_policy / follow_up_action_url are the create-time fields the backend
  // rejects when absent; surface them as required so the form is publishable.
  const required = create.options.filter((o) => o.required).map((o) => o.long)
  assert.ok(required.includes('--privacy-policy-url'), '--privacy-policy-url must be required')
  assert.ok(required.includes('--follow-up-action-url'), '--follow-up-action-url must be required')
  assert.equal(flags.includes('--platform'), false)
})

test('ads meta audience create-custom and create-lookalike expose their core flags', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)

  const custom = findCommand(ads, 'meta', 'audience', 'create-custom')
  const customFlags = custom.options.map((o) => o.long)
  for (const flag of ['--account-id', '--name', '--subtype', '--rule', '--summary']) {
    assert.ok(customFlags.includes(flag), `create-custom missing ${flag}`)
  }

  const lookalike = findCommand(ads, 'meta', 'audience', 'create-lookalike')
  const lookalikeFlags = lookalike.options.map((o) => o.long)
  for (const flag of [
    '--account-id',
    '--name',
    '--source-audience-id',
    '--country',
    '--ratio',
    '--summary',
  ]) {
    assert.ok(lookalikeFlags.includes(flag), `create-lookalike missing ${flag}`)
  }
  assert.equal(lookalikeFlags.includes('--platform'), false)
})

test('ads chatgpt command tree exposes account/campaign/ad-group/ad groups', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const chatgpt = findCommand(ads, 'chatgpt')

  const groups = chatgpt.commands.map((cmd) => cmd.name())
  for (const group of ['account', 'campaign', 'ad-group', 'ad']) {
    assert.ok(groups.includes(group), `chatgpt missing group ${group}`)
  }

  assert.ok(findCommand(chatgpt, 'account', 'info'))
  const campaignVerbs = findCommand(chatgpt, 'campaign').commands.map((cmd) => cmd.name())
  for (const verb of [
    'list',
    'get',
    'create',
    'update',
    'remove',
    'migrate-legacy',
    'activate',
    'pause',
  ]) {
    assert.ok(campaignVerbs.includes(verb), `chatgpt campaign missing ${verb}`)
  }
  const adGroupVerbs = findCommand(chatgpt, 'ad-group').commands.map((cmd) => cmd.name())
  for (const verb of ['list', 'get', 'create', 'update', 'archive', 'activate', 'pause']) {
    assert.ok(adGroupVerbs.includes(verb), `chatgpt ad-group missing ${verb}`)
  }
  const adVerbs = findCommand(chatgpt, 'ad').commands.map((cmd) => cmd.name())
  for (const verb of ['create', 'update', 'archive']) {
    assert.ok(adVerbs.includes(verb), `chatgpt ad missing ${verb}`)
  }
  // No legacy deprecated ad-unit commands in the ergonomic tree.
  assert.equal(groups.includes('ad-unit'), false)
})

test('ads chatgpt campaign create exposes inline ad-groups and required chatgpt fields', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const create = findCommand(ads, 'chatgpt', 'campaign', 'create')

  const flags = create.options.map((o) => o.long)
  for (const flag of [
    '--account-id',
    '--name',
    '--landing-page',
    '--objective',
    '--budget-daily',
    '--budget-daily-micros',
    '--ad-groups',
    '--ad-groups-file',
    '--summary',
  ]) {
    assert.ok(flags.includes(flag), `chatgpt campaign create missing ${flag}`)
  }
  assert.equal(flags.includes('--platform'), false)
})

test('ads chatgpt ad create requires authored-ad content fields', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  const create = findCommand(ads, 'chatgpt', 'ad', 'create')

  const required = create.options.filter((o) => o.mandatory).map((o) => o.long)
  for (const flag of [
    '--account-id',
    '--ad-group-id',
    '--name',
    '--headline',
    '--copy',
    '--cta',
    '--landing-page',
    '--summary',
  ]) {
    assert.ok(required.includes(flag), `chatgpt ad create should require ${flag}`)
  }
})

test('ads chatgpt activate/pause use lowercase statuses and require account id', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  for (const path of [
    ['chatgpt', 'campaign'],
    ['chatgpt', 'ad-group'],
  ]) {
    const group = findCommand(ads, ...path)
    for (const verb of ['activate', 'pause']) {
      const cmd = findCommand(group, verb)
      const accountOpt = cmd.options.find((o) => o.long === '--account-id')
      assert.ok(accountOpt, `${path.join(' ')} ${verb} missing --account-id`)
      assert.equal(accountOpt!.mandatory, true, `${path.join(' ')} ${verb} --account-id optional`)
    }
    assert.ok(
      findCommand(group, 'activate').description().includes('active'),
      `${path.join(' ')} activate should reference lowercase active status`,
    )
    assert.ok(
      findCommand(group, 'pause').description().includes('paused'),
      `${path.join(' ')} pause should reference lowercase paused status`,
    )
  }
})

test('ads google/meta activate-pause keep uppercase status literals after helper generalization', () => {
  const program = new Command()
  const ads = program.command('ads').description('ads data capabilities')
  registerAdsEntities(ads)
  assert.ok(findCommand(ads, 'google', 'campaign', 'pause').description().includes('PAUSED'))
  assert.ok(findCommand(ads, 'meta', 'campaign', 'pause').description().includes('PAUSED'))
  const googleAccountOpt = findCommand(ads, 'google', 'campaign', 'pause').options.find(
    (o) => o.long === '--account-id',
  )
  assert.ok(googleAccountOpt)
  assert.equal(googleAccountOpt!.mandatory, false)
})

test('resolveJsonArray accepts inline JSON arrays and file sources', () => {
  const inline = resolveJsonArray('ad_groups', '--ad-groups', '--ad-groups-file', [{ a: 1 }], undefined)
  assert.deepEqual(inline, [{ a: 1 }])

  const dir = mkdtempSync(join(tmpdir(), 'soku-cli-chatgpt-'))
  try {
    const file = join(dir, 'groups.json')
    writeFileSync(file, JSON.stringify([{ name: 'AG 1' }]))
    const fromFile = resolveJsonArray('ad_groups', '--ad-groups', '--ad-groups-file', undefined, file)
    assert.deepEqual(fromFile, [{ name: 'AG 1' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
