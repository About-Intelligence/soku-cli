import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ExitCode } from './envelope.js'
import { unwrapDispatch } from './unwrap.js'

test('unwraps a successful dispatcher envelope to its inner data', () => {
  assert.deepEqual(unwrapDispatch({ ok: true, data: { rows: [] }, error: null }), { rows: [] })
})

test('successful envelope with no data yields null', () => {
  assert.equal(unwrapDispatch({ ok: true }), null)
})

test('non-envelope values pass through unchanged', () => {
  assert.deepEqual(unwrapDispatch({ rows: [1, 2] }), { rows: [1, 2] })
  assert.equal(unwrapDispatch('plain'), 'plain')
})

test('ok:false routes to emitError and exits with semantic code', () => {
  const origExit = process.exit
  const origWrite = process.stderr.write.bind(process.stderr)
  let captured: number | undefined
  // Test stub: make exit observable without killing the runner.
  process.exit = ((code?: number): never => {
    captured = code
    throw new Error('__exit__')
  }) as typeof process.exit
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    assert.throws(
      () => unwrapDispatch({ ok: false, error: { message: 'boom' } }),
      /__exit__/,
    )
  } finally {
    process.exit = origExit
    process.stderr.write = origWrite
  }
  assert.equal(captured, ExitCode.RUNTIME)
})

test('ok:false with dispatcher bad request exits as USAGE', () => {
  const origExit = process.exit
  const origWrite = process.stderr.write.bind(process.stderr)
  let captured: number | undefined
  process.exit = ((code?: number): never => {
    captured = code
    throw new Error('__exit__')
  }) as typeof process.exit
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    assert.throws(
      () => unwrapDispatch({ ok: false, error: { code: 'gaql_invalid_query', message: 'bad query', status_code: 400 } }),
      /__exit__/,
    )
  } finally {
    process.exit = origExit
    process.stderr.write = origWrite
  }
  assert.equal(captured, ExitCode.USAGE)
})
