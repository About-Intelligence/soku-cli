import { strict as assert } from 'node:assert'
import test from 'node:test'

import { Command } from 'commander'

import { memoryListPath, registerMemoryCommands, renderMemoryEntry, renderMemoryEntries } from './memory.js'

test('memory list path encodes optional filters', () => {
  assert.equal(memoryListPath({}), '/api/cli/memory')
  assert.equal(memoryListPath({ type: 'reference' }), '/api/cli/memory?type=reference')
  assert.equal(
    memoryListPath({ type: 'reference', query: 'policy 5/31' }),
    '/api/cli/memory?type=reference&q=policy+5%2F31',
  )
})

test('memory command exposes list, search, and get', () => {
  const program = new Command()
  registerMemoryCommands(program)
  const memory = program.commands.find((cmd) => cmd.name() === 'memory')
  assert.ok(memory)
  assert.equal(memory.commands.some((cmd) => cmd.name() === 'list'), true)
  assert.equal(memory.commands.some((cmd) => cmd.name() === 'search'), true)
  assert.equal(memory.commands.some((cmd) => cmd.name() === 'get'), true)
})

test('memory renderers include provenance fields and compact previews', () => {
  const entry = {
    type: 'reference' as const,
    name: 'policy-event',
    description: 'Known Noiz policy event.',
    updated_at: '2026-06-04T00:00:00Z',
    content: 'A '.repeat(90),
  }

  const list = renderMemoryEntries([entry])
  assert.match(list, /reference/)
  assert.match(list, /policy-event/)
  assert.match(list, /\.\.\./)

  const full = renderMemoryEntry({ ...entry, content: 'Full body' })
  assert.match(full, /reference\/policy-event/)
  assert.match(full, /Known Noiz policy event/)
  assert.match(full, /Full body/)
})
