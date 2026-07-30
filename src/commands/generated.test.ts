import { strict as assert } from 'node:assert'
import test from 'node:test'

import { Command } from 'commander'

import { buildGeneratedCommands, type CapabilityManifest } from './generated.js'
import { registerOrgCommands } from './org.js'

function manifestWith(namespace: string, action: string): CapabilityManifest {
  return {
    actions: [
      {
        id: `${namespace}.${action}`,
        namespace,
        action,
        description: `${action} description`,
        long_description: null,
        mode: 'read',
        platforms: [],
        requires_review: false,
        freshness_kind: 'live',
        input_params: [],
        output_shape: null,
        see_also: [],
      },
    ],
  }
}

test('generated commands reuse a pre-registered hand-written namespace group', () => {
  const program = new Command()
  registerOrgCommands(program)

  buildGeneratedCommands(program, manifestWith('org', 'get_overview'))

  const orgs = program.commands.filter((cmd) => cmd.name() === 'org')
  assert.equal(orgs.length, 1, 'must not create a second top-level org command')
  assert.deepEqual(
    orgs[0].commands.map((cmd) => cmd.name()).sort(),
    ['get-overview', 'list', 'use'],
  )
})

test('generated commands create a new group when no hand-written command exists', () => {
  const program = new Command()

  buildGeneratedCommands(program, manifestWith('shopify', 'get_overview'))

  const shopify = program.commands.find((cmd) => cmd.name() === 'shopify')
  assert.ok(shopify)
  assert.deepEqual(
    shopify.commands.map((cmd) => cmd.name()),
    ['get-overview'],
  )
})
