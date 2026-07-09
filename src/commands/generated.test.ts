import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { Command } from 'commander'

import { buildGeneratedCommands, type CapabilityManifest } from './generated.js'

const fixture: CapabilityManifest = {
  actions: [
    {
      id: 'action:ads/list_ad_accounts',
      namespace: 'ads',
      action: 'list_ad_accounts',
      description: 'List ad accounts.',
      long_description: null,
      mode: 'read',
      platforms: [],
      requires_review: false,
      freshness_kind: 'synced',
      input_params: [
        { name: 'platform', type: 'string', required: false, description: 'Platform filter.' },
      ],
      output_shape: null,
      see_also: [],
    },
    {
      id: 'action:ads/query_single_dimension',
      namespace: 'ads',
      action: 'query_single_dimension',
      description: 'Query one dimension.',
      long_description: 'Long help here.',
      mode: 'read',
      platforms: [],
      requires_review: false,
      freshness_kind: 'synced',
      input_params: [
        { name: 'account_id', type: 'string', required: true, description: 'Account id.' },
        { name: 'filters', type: 'object', required: false, description: 'Filter map.' },
        { name: 'limit', type: 'integer', required: false, description: 'Row cap.' },
        { name: 'debug', type: 'boolean', required: false, description: 'Debug flag.' },
      ],
      output_shape: null,
      see_also: [],
    },
    {
      id: 'action:ads/gaql_search',
      namespace: 'ads',
      action: 'gaql_search',
      description: 'GAQL fallback.',
      long_description: null,
      mode: 'read',
      platforms: [],
      requires_review: false,
      freshness_kind: 'realtime',
      input_params: [],
      output_shape: null,
      see_also: [],
    },
    {
      id: 'action:ga4/list_properties',
      namespace: 'ga4',
      action: 'list_properties',
      description: 'List GA4 properties.',
      long_description: null,
      mode: 'read',
      platforms: [],
      requires_review: false,
      freshness_kind: 'synced',
      input_params: [],
      output_shape: null,
      see_also: [],
    },
  ],
}

function group(program: Command, name: string): Command {
  const found = program.commands.find((c) => c.name() === name)
  assert.ok(found, `namespace group "${name}" should exist`)
  return found
}

function sub(parent: Command, name: string): Command {
  const found = parent.commands.find((c) => c.name() === name)
  assert.ok(found, `subcommand "${name}" should exist`)
  return found
}

test('builds one namespace group per distinct namespace', () => {
  const program = new Command()
  buildGeneratedCommands(program, fixture)
  assert.ok(group(program, 'ads'))
  assert.ok(group(program, 'ga4'))
})

test('action names are kebab-cased under their namespace', () => {
  const program = new Command()
  buildGeneratedCommands(program, fixture)
  const ads = group(program, 'ads')
  assert.ok(sub(ads, 'list-ad-accounts'))
  assert.ok(sub(ads, 'query-single-dimension'))
  assert.ok(sub(ads, 'gaql-search'))
  assert.ok(sub(group(program, 'ga4'), 'list-properties'))
})

test('input params map to kebab-cased flags; required params are mandatory', () => {
  const program = new Command()
  buildGeneratedCommands(program, fixture)
  const cmd = sub(group(program, 'ads'), 'query-single-dimension')
  const byLong = new Map(cmd.options.map((o) => [o.long, o]))

  const accountId = byLong.get('--account-id')
  assert.ok(accountId, 'snake_case account_id should become --account-id')
  assert.equal(accountId.mandatory, true, 'required param should be a mandatory option')

  const filters = byLong.get('--filters')
  assert.ok(filters)
  assert.equal(filters.mandatory, false)

  const debug = byLong.get('--debug')
  assert.ok(debug, 'boolean param should still produce a flag')
  // A boolean flag takes no value.
  assert.equal(debug.required, false)
})

test('a command with no params still registers cleanly', () => {
  const program = new Command()
  assert.doesNotThrow(() => buildGeneratedCommands(program, fixture))
  const props = sub(group(program, 'ga4'), 'list-properties')
  assert.equal(props.name(), 'list-properties')
})

test('generated help explains typed kebab-case vs raw snake_case names', () => {
  const program = new Command()
  buildGeneratedCommands(program, fixture)
  const cmd = sub(group(program, 'ads'), 'query-single-dimension')
  const help = cmd.helpInformation()

  assert.match(help, /Typed CLI command: soku ads query-single-dimension/)
  assert.match(help, /Raw call action: soku call ads query_single_dimension/)
})

test('gaql-search help warns that GAQL is a fallback path', () => {
  const program = new Command()
  buildGeneratedCommands(program, fixture)
  const cmd = sub(group(program, 'ads'), 'gaql-search')
  const help = cmd.helpInformation()

  assert.match(help, /FALLBACK WARNING:/)
  assert.match(help, /Prefer cached ads analytics first/)
  assert.match(help, /Raw call action: soku call ads gaql_search/)
})

test('committed manifest parses and includes PostHog read commands', () => {
  // Read the source snapshot directly (the build-copied dist JSON is not
  // present in the test build output).
  const manifest = JSON.parse(
    readFileSync('src/generated/capabilities.json', 'utf8'),
  ) as CapabilityManifest
  assert.ok(Array.isArray(manifest.actions))
  assert.ok(manifest.actions.length > 0)
  const posthogActions = new Set(
    manifest.actions.filter(a => a.namespace === 'posthog').map(a => a.action),
  )
  // The resource allowlist was removed, so the manifest is the full registered
  // surface — posthog now also exposes request_change (previously gated).
  for (const action of ['list_projects', 'list_tools', 'query']) {
    assert.ok(posthogActions.has(action), `posthog/${action} should be exposed`)
  }
  const modes = new Set<string>()
  for (const a of manifest.actions) {
    assert.ok(a.namespace && a.action, 'each action has namespace + action')
    assert.ok(Array.isArray(a.input_params), 'each action has input_params')
    assert.ok(['read', 'write', 'risk'].includes(a.mode), `valid mode: ${a.mode}`)
    modes.add(a.mode)
  }
  // The manifest is the full CLI surface — read + write + risk — not the old
  // read-only v1 snapshot. Assert the write surface is present so a regression
  // back to a read-only manifest is caught here as well as in the Python guard.
  assert.ok(modes.has('write') || modes.has('risk'), 'manifest includes mutating actions')
})

test('committed manifest registers posthog typed commands', () => {
  const manifest = JSON.parse(
    readFileSync('src/generated/capabilities.json', 'utf8'),
  ) as CapabilityManifest
  const program = new Command()
  buildGeneratedCommands(program, manifest)

  assert.equal(sub(group(program, 'posthog'), 'list-projects').name(), 'list-projects')
  assert.equal(sub(group(program, 'posthog'), 'list-tools').name(), 'list-tools')
  assert.equal(sub(group(program, 'posthog'), 'query').name(), 'query')
})
