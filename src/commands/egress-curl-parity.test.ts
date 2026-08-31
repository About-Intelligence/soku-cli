/**
 * Does `soku egress -- curl X` carry the same request as plain `curl X`?
 *
 * That equivalence is the entire promise of the command — the docs tell agents
 * to prefix an existing skill's curl and expect nothing else to change — and it
 * is the property that broke: `--data-urlencode` was unhandled, so the request
 * went out with every parameter missing while the upstream complained about
 * something unrelated.
 *
 * This runs a real `curl` and the parser's output against the same local server
 * and compares what arrived. It exists because unit tests alone were not
 * enough: they were first written from an assumption about curl's encoding
 * (`%20` for a space, uppercase hex) and passed, while real curl sends `+` and
 * lowercase hex. Only the measurement caught it. Anything asserted from memory
 * about another program's behaviour is a guess until it is run.
 */

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { parseCurl } from './egress.js'

const run = promisify(execFile)

interface Seen {
  method: string
  /** The raw request target, before any parsing — what the upstream receives. */
  target: string
  body: string
}

function curlAvailable(): boolean {
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Cases are (name, argv-after-`curl`) given the base URL of the local server. */
const CASES: Array<[string, (base: string) => string[]]> = [
  ['the reported Ahrefs command', (b) => [
    '-sS', '-i', '-G', `${b}/v3/keywords-explorer/overview`,
    '--data-urlencode', 'country=us',
    '--data-urlencode', 'keywords=concert tickets',
    '--data-urlencode', 'select=keyword,volume',
    '--data-urlencode', 'limit=1',
  ]],
  ['repeated -d flags', (b) => [
    '-sS', '-G', `${b}/x`, '-d', 'a=1', '-d', 'b=2', '-d', 'c=3',
  ]],
  ['POST body from repeated -d', (b) => [
    '-sS', '-X', 'POST', `${b}/x`, '-d', 'a=1', '-d', 'b=2',
  ]],
  ['characters that encode differently in each scheme', (b) => [
    '-sS', '-G', `${b}/x`, '--data-urlencode', "q=a b&c=d!e'f(g)h*i~j+k/l,m",
  ]],
  ['non-ASCII values', (b) => [
    '-sS', '-G', `${b}/x`, '--data-urlencode', 'q=café 北京',
  ]],
  ['a URL that already carries a query', (b) => [
    '-sS', '-G', `${b}/x?existing=1`, '--data-urlencode', 'added=2',
  ]],
  ['the PageSpeed skill shape', (b) => [
    '-sS', '--max-time', '120', '-G', `${b}/runPagespeed`,
    '--data-urlencode', 'url=https://example.com',
    '--data-urlencode', 'strategy=mobile',
  ]],
  ['mixed -d and --data-urlencode', (b) => [
    '-sS', '-G', `${b}/x`, '-d', 'raw=1', '--data-urlencode', 'enc=a b',
  ]],
]

test('every supported curl shape reaches the server byte-identically', {
  skip: curlAvailable() ? false : 'curl is not installed',
}, async () => {
  const seen: Seen[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    seen.push({
      method: req.method ?? '',
      target: req.url ?? '',
      body: Buffer.concat(chunks).toString(),
    })
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  try {
    for (const [name, build] of CASES) {
      const args = build(base)
      const start = seen.length

      // Must be async: the echo server runs in THIS process, so a
      // synchronous spawn would block the event loop and the server would never
      // accept curl's connection — the two would deadlock.
      await run('curl', [...args, '-o', '/dev/null'], {
        // This machine forces an HTTP proxy; a loopback call must not use it.
        env: { ...process.env, NO_PROXY: '*', no_proxy: '*' },
      })

      const parsed = parseCurl(['curl', ...args])
      const res = await fetch(parsed.url as string, {
        method: parsed.method,
        headers: { ...parsed.headers, connection: 'close' },
        body: parsed.body ? new Uint8Array(parsed.body) : undefined,
      })
      await res.arrayBuffer()

      const real = seen[start]
      const mine = seen[start + 1]
      assert.ok(real && mine, `${name}: both requests should have arrived`)
      assert.equal(mine.method, real.method, `${name}: method differs from curl`)
      assert.equal(mine.target, real.target, `${name}: request target differs from curl`)
      assert.equal(mine.body, real.body, `${name}: body differs from curl`)
    }
  } finally {
    // fetch pools its sockets, so closing the listener alone would leave the
    // process alive until the keep-alive timeout and hang the run.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
