import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

import { renderHumanData } from './envelope.js'

/** Run `emitSuccess` / `emitError` in a child whose stdout and stderr are
 * pipes (what an agent or `| jq` sees) and collect everything it wrote. */
function runEmitter(call: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const moduleUrl = new URL('./envelope.js', import.meta.url).href
  const script = `import { emitSuccess, emitError } from ${JSON.stringify(moduleUrl)}\n${call}`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

test('a large success payload reaches a pipe in full before the process exits', async () => {
  const { stdout, code } = await runEmitter(
    "emitSuccess({ rows: Array.from({ length: 20000 }, (_, i) => ({ id: i, name: 'row ' + i })) })",
  )
  assert.equal(code, 0)
  const parsed = JSON.parse(stdout) as { ok: boolean; data: { rows: unknown[] } }
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.rows.length, 20000)
})

test('a large error envelope reaches a pipe in full before the process exits', async () => {
  const { stderr, code } = await runEmitter("emitError('request_failed', 'x'.repeat(200000), 5)")
  assert.equal(code, 5)
  const parsed = JSON.parse(stderr) as { ok: boolean; error: { message: string } }
  assert.equal(parsed.error.message.length, 200000)
})

test('renders a plain object as readable key-value lines', () => {
  assert.equal(
    renderHumanData({
      signed_in: true,
      owner_id: 'user_123',
      scope_type: 'user_session',
    }),
    ['Signed In: true', 'Owner Id: user_123', 'Scope Type: user_session'].join('\n'),
  )
})

test('renders a list of records as a table', () => {
  assert.equal(
    renderHumanData([
      { id: 'ads', label: 'Ads' },
      { id: 'ga4', label: 'GA4' },
    ]),
    ['ID   LABEL', 'ads  Ads  ', 'ga4  GA4  '].join('\n'),
  )
})

test('renders nested record lists without falling back to pretty JSON', () => {
  const rendered = renderHumanData({
    count: 2,
    rows: [
      { campaign: 'A', clicks: 10 },
      { campaign: 'B', clicks: 20 },
    ],
  })

  assert.match(rendered, /Count: 2/)
  assert.match(rendered, /Rows/)
  assert.match(rendered, /CAMPAIGN/)
  assert.doesNotMatch(rendered, /^\{/)
})
