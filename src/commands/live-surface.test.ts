import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Command } from 'commander'

import { registerLiveSurfaceCommands } from './live-surface.js'

function findCommand(root: Command, ...path: string[]): Command {
  let current = root
  for (const name of path) {
    const next = current.commands.find((cmd) => cmd.name() === name)
    assert.ok(next, `missing command path ${path.join(' ')}`)
    current = next
  }
  return current
}

test('live-surfaces exposes the four operations the server routes offer', () => {
  // The server surface shipped before this command did, so the docs and the
  // dispatcher's refusal message pointed at `soku live-surfaces` while nothing
  // by that name existed. Each of these has a route behind it.
  const program = new Command()
  registerLiveSurfaceCommands(program)

  for (const name of ['open', 'list', 'revoke', 'rotate-credential']) {
    const command = findCommand(program, 'live-surfaces', name)
    assert.ok(command.description(), `${name} has no description`)
  }
})

test('open can hand over a link that cannot be edited or approved from', () => {
  // A preview link is the right shape when showing work rather than inviting
  // changes, and `--no-approvals` is what withholds the credential entirely.
  const program = new Command()
  registerLiveSurfaceCommands(program)
  const open = findCommand(program, 'live-surfaces', 'open')

  const flags = open.options.map((option) => option.long)
  assert.ok(flags.includes('--read-only'))
  assert.ok(flags.includes('--no-approvals'))
  assert.ok(flags.includes('--ttl-hours'))
})

test('revoking a link and rotating its code are separate commands', () => {
  // A credential seen by the wrong person should not cost the right person
  // their work surface, so rotating never revokes.
  const program = new Command()
  registerLiveSurfaceCommands(program)

  const revoke = findCommand(program, 'live-surfaces', 'revoke')
  const rotate = findCommand(program, 'live-surfaces', 'rotate-credential')

  assert.notEqual(revoke.name(), rotate.name())
  assert.match(rotate.description(), /leaving the link itself alive/i)
})
