import { strict as assert } from 'node:assert'
import test from 'node:test'

import { Command } from 'commander'

import { registerFilesCommands } from './files.js'

test('files command exposes publish', () => {
  const program = new Command()
  registerFilesCommands(program)
  const files = program.commands.find((cmd) => cmd.name() === 'files')
  assert.ok(files)
  const publish = files!.commands.find((cmd) => cmd.name() === 'publish')
  assert.ok(publish)
  assert.equal(publish!.name(), 'publish')
})
