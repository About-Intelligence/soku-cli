import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CurlUsageError,
  buildUrlEncodedSegment,
  curlEscape,
  expandShortBundle,
  parseCurl,
  responseSink,
  stripPlaceholderAuth,
} from './egress.js'

test('parses method, url, headers, and body from a curl command', () => {
  const r = parseCurl([
    'curl',
    '-X',
    'POST',
    '-H',
    'Authorization: Bearer abc',
    '-H',
    'Content-Type: application/json',
    'https://api.ahrefs.com/v3/x',
    '-d',
    '{"a":1}',
  ])
  assert.equal(r.method, 'POST')
  assert.equal(r.url, 'https://api.ahrefs.com/v3/x')
  assert.equal(r.headers['authorization'], 'Bearer abc')
  assert.equal(r.headers['content-type'], 'application/json')
  assert.equal(r.body?.toString(), '{"a":1}')
})

test('infers GET with no body and POST when a body is present', () => {
  assert.equal(parseCurl(['curl', 'https://x.test/a']).method, 'GET')
  assert.equal(parseCurl(['curl', 'https://x.test/a', '-d', 'k=v']).method, 'POST')
})

test('accepts --url alongside output-only flags', () => {
  const r = parseCurl(['curl', '-s', '--url', 'https://x.test/a', '-H', 'X-Key: v'])
  assert.equal(r.url, 'https://x.test/a')
  assert.equal(r.headers['x-key'], 'v')
})

test('-G folds data into the query string', () => {
  const r = parseCurl(['curl', '-G', 'https://x.test/a', '-d', 'q=hello&n=2'])
  assert.equal(r.method, 'GET')
  assert.equal(r.body, undefined)
  const u = new URL(r.url as string)
  assert.equal(u.searchParams.get('q'), 'hello')
  assert.equal(u.searchParams.get('n'), '2')
})

test('strips empty / bare-scheme auth headers but keeps real credentials', () => {
  const out = stripPlaceholderAuth({
    authorization: 'Bearer ', // unset $X expansion
    'x-apptweak-key': '', // empty raw key
    'x-real': 'Bearer real-token',
    'content-type': 'application/json',
  })
  assert.ok(!('authorization' in out))
  assert.ok(!('x-apptweak-key' in out))
  assert.equal(out['x-real'], 'Bearer real-token')
  assert.equal(out['content-type'], 'application/json')
})


// ── Regression: the reported incident ────────────────────────────────────────

/** The command from the bug report, verbatim.
 *
 * It used to produce a bare URL with no query at all: `--data-urlencode` was not
 * in the switch, the `default:` branch skipped it without consuming its value,
 * and the value then fell through as a stray token. Ahrefs answered
 * `missing argument 'select'` — naming only the first thing it checked — so the
 * report read as "one parameter is lost" when every parameter was.
 */
const REPORTED_COMMAND = [
  'curl', '-sS', '-i', '-G', 'https://api.ahrefs.com/v3/keywords-explorer/overview',
  '--data-urlencode', 'country=us',
  '--data-urlencode', 'keywords=concert tickets',
  '--data-urlencode', 'select=keyword,volume',
  '--data-urlencode', 'limit=1',
]

test('regression: the reported command sends all four parameters', () => {
  const r = parseCurl(REPORTED_COMMAND)

  assert.equal(r.method, 'GET')
  assert.equal(r.body, undefined)
  assert.equal(
    r.url,
    'https://api.ahrefs.com/v3/keywords-explorer/overview' +
      '?country=us&keywords=concert+tickets&select=keyword%2cvolume&limit=1',
  )
  // Asserted through a parser too, so the test fails on a malformed query even
  // if the exact string above is ever legitimately reordered.
  const u = new URL(r.url as string)
  assert.equal(u.searchParams.get('country'), 'us')
  assert.equal(u.searchParams.get('keywords'), 'concert tickets')
  assert.equal(u.searchParams.get('select'), 'keyword,volume')
  assert.equal(u.searchParams.get('limit'), '1')
})

test('regression: the query is byte-identical to what real curl sends', () => {
  // Measured against curl 8.7.1, not assumed: `--data-urlencode` is FORM
  // encoding, so a space is `+` (not `%20`) and hex digits are lowercase
  // (`%2c`, not `%2C`). Encoding it any other way would change the bytes the
  // third party receives, which is exactly what `soku egress` promises not to do.
  const r = parseCurl(REPORTED_COMMAND)
  assert.match(r.url as string, /keywords=concert\+tickets/)
  assert.match(r.url as string, /select=keyword%2cvolume/)
})

// ── Contract: repeated data flags accumulate ─────────────────────────────────

test('multiple -d flags join with &, they do not overwrite each other', () => {
  const r = parseCurl([
    'curl', '-G', 'https://x.test/a',
    '-d', 'country=us',
    '-d', 'keywords=tickets',
    '-d', 'select=keyword',
    '-d', 'limit=1',
  ])
  // Previously each -d assigned over the last, so only `limit=1` survived.
  assert.equal(r.url, 'https://x.test/a?country=us&keywords=tickets&select=keyword&limit=1')
})

test('mixed -d and --data-urlencode accumulate in argument order', () => {
  const r = parseCurl([
    'curl', '-G', 'https://x.test/a',
    '-d', 'raw=a b',
    '--data-urlencode', 'enc=a b',
  ])
  // -d is passed through verbatim (curl does not encode it); only
  // --data-urlencode encodes. Both must survive.
  assert.equal(r.url, 'https://x.test/a?raw=a b&enc=a+b')
})

test('data flags append to a URL that already has a query', () => {
  const r = parseCurl(['curl', '-G', 'https://x.test/a?existing=1', '-d', 'added=2'])
  assert.equal(r.url, 'https://x.test/a?existing=1&added=2')
})

test('without -G the accumulated data becomes a POST body', () => {
  const r = parseCurl(['curl', 'https://x.test/a', '-d', 'a=1', '-d', 'b=2'])
  assert.equal(r.method, 'POST')
  assert.equal(r.body?.toString(), 'a=1&b=2')
})

// ── --data-urlencode: curl's four forms ──────────────────────────────────────

test('buildUrlEncodedSegment implements each of curl four forms', () => {
  const readFile = (path: string) => {
    if (path === 'body.txt') return 'from file'
    throw new Error(`unexpected read: ${path}`)
  }
  // content -> whole thing encoded, no name
  assert.equal(buildUrlEncodedSegment('a b', readFile), 'a+b')
  // =content -> encoded, leading = dropped, no name
  assert.equal(buildUrlEncodedSegment('=a b', readFile), 'a+b')
  // name=content -> name kept literal, content encoded
  assert.equal(buildUrlEncodedSegment('q=a b', readFile), 'q=a+b')
  // @file -> file content encoded, no name
  assert.equal(buildUrlEncodedSegment('@body.txt', readFile), 'from+file')
  // name@file -> name kept literal, file content encoded
  assert.equal(buildUrlEncodedSegment('q@body.txt', readFile), 'q=from+file')
})

test('an = before an @ picks the name=content form, matching curl', () => {
  // `q=a@b.com` is a value containing @, not a filename reference.
  assert.equal(buildUrlEncodedSegment('q=a@b.com'), 'q=a%40b.com')
})

test('an unreadable --data-urlencode file is an error, not a dropped parameter', () => {
  assert.throws(
    () => buildUrlEncodedSegment('q@/no/such/file/here.txt'),
    CurlUsageError,
  )
})

test('curlEscape reproduces curl 8.7.1 byte for byte', () => {
  // Every expectation below was read off a real `curl --data-urlencode` request
  // against a local echo server, not derived from a spec.
  assert.equal(curlEscape('a b'), 'a+b') // space is `+`, not %20
  assert.equal(curlEscape('a,b'), 'a%2cb') // lowercase hex, not %2C
  assert.equal(curlEscape('a/b'), 'a%2fb')
  assert.equal(curlEscape('a+b'), 'a%2bb') // a literal plus must survive
  assert.equal(curlEscape('a~b'), 'a~b') // ~ is unreserved
  assert.equal(curlEscape("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2af')
  assert.equal(curlEscape('safe-._~'), 'safe-._~')
  // Non-ASCII is percent-encoded per UTF-8 byte.
  assert.equal(curlEscape('é'), '%c3%a9')
})

// ── Unknown flags are refused, not skipped ───────────────────────────────────

test('a flag that would change the request is refused, and named', () => {
  // The old default: branch skipped these and sent the request anyway.
  // The message must name the FLAG: without that assertion this test also
  // passes when the reject branch is gone, because the flag then becomes the
  // URL and its value trips the stray-token check instead — the right outcome
  // reached for the wrong reason, which is how a real regression slips through.
  for (const flag of ['-F', '-u', '--cookie', '-T', '--form-string']) {
    assert.throws(
      () => parseCurl(['curl', flag, 'x', 'https://x.test/a']),
      (err: unknown) =>
        err instanceof CurlUsageError && err.message === `Unsupported curl flag: ${flag}`,
      `${flag} should be refused by name`,
    )
  }
})

test('a misspelled data flag is refused instead of silently dropping its value', () => {
  // This is the exact shape of the incident: one unrecognised flag, the request
  // sent anyway, and an upstream error about something else.
  assert.throws(
    () => parseCurl(['curl', '-G', 'https://x.test/a', '--data-urlencodee', 'country=us']),
    (err: unknown) =>
      err instanceof CurlUsageError &&
      err.message === 'Unsupported curl flag: --data-urlencodee',
  )
})

test('a stray token after the URL is refused', () => {
  assert.throws(() => parseCurl(['curl', 'https://x.test/a', 'country=us']), CurlUsageError)
})

test('a flag missing its value is refused rather than reading past the end', () => {
  assert.throws(() => parseCurl(['curl', 'https://x.test/a', '-H']), CurlUsageError)
  assert.throws(() => parseCurl(['curl', 'https://x.test/a', '--data-urlencode']), CurlUsageError)
})

// ── Flags that are accepted and deliberately ignored ─────────────────────────

test('the retry flags the published skill contract emits keep working', () => {
  // packages/services/marketplace/cli_bundle.py injects exactly this into every
  // generated skill, so refusing it would break the published guidance.
  const r = parseCurl([
    'curl', '--retry', '3', '--retry-delay', '1', '--retry-all-errors',
    'https://x.test/a',
  ])
  assert.equal(r.url, 'https://x.test/a')
  assert.equal(r.method, 'GET')
})

test('output-only and timeout flags are accepted and consume their value', () => {
  const r = parseCurl([
    'curl', '-sS', '-i', '-v', '--max-time', '120', '--connect-timeout', '5',
    '-w', '%{http_code}', '-L', '--compressed', '--fail',
    '-G', 'https://x.test/a', '--data-urlencode', 'q=1',
  ])
  // Every value above must have been consumed by its own flag; a leaked one
  // would have been refused as a stray token.
  assert.equal(r.url, 'https://x.test/a?q=1')
})

test('bundled short flags expand only when every letter takes no value', () => {
  assert.deepEqual(expandShortBundle('-sS'), ['-s', '-S'])
  assert.deepEqual(expandShortBundle('-fsSL'), ['-f', '-s', '-S', '-L'])
  assert.deepEqual(expandShortBundle('-sSG'), ['-s', '-S', '-G'])
  // -o takes a value, so the bundle is not split apart and guessed at.
  assert.equal(expandShortBundle('-so'), null)
  assert.equal(expandShortBundle('-s'), null)
  assert.equal(expandShortBundle('--silent'), null)
})

test('a bundle containing a value-taking flag is refused, not misparsed', () => {
  assert.throws(
    () => parseCurl(['curl', '-so', 'out.json', 'https://x.test/a']),
    (err: unknown) =>
      err instanceof CurlUsageError && err.message === 'Unsupported curl flag: -so',
  )
})

test('-G inside a bundle still folds data into the query', () => {
  const r = parseCurl(['curl', '-sSG', 'https://x.test/a', '--data-urlencode', 'q=a b'])
  assert.equal(r.method, 'GET')
  assert.equal(r.url, 'https://x.test/a?q=a+b')
})

// ── -o / --output ────────────────────────────────────────────────────────────

test('-o records the output path instead of being ignored', () => {
  // The ScreenshotOne skills download a binary to a file; ignoring -o would put
  // the bytes on stdout while the next step looked for a file.
  const r = parseCurl([
    'curl', '-sS', '-L', '-G', 'https://api.screenshotone.com/take',
    '--data-urlencode', 'url=https://a.test',
    '-o', 'shot.png',
  ])
  assert.equal(r.output, 'shot.png')
  assert.equal(r.url, 'https://api.screenshotone.com/take?url=https%3a%2f%2fa.test')
})

test('-I requests a HEAD', () => {
  assert.equal(parseCurl(['curl', '-I', 'https://x.test/a']).method, 'HEAD')
})


// ── Where the upstream body is written ───────────────────────────────────────

test('responseSink writes to the -o file, and to stdout without one', async () => {
  // "Silently wrote to the wrong place" is the same failure class as this whole
  // incident, so the choice is a named function rather than an inline branch
  // that no test can reach.
  const target = join(mkdtempSync(join(tmpdir(), 'egress-out-')), 'shot.bin')

  const sink = responseSink(target)
  await new Promise<void>((resolve, reject) => {
    sink.on('finish', () => resolve())
    sink.on('error', reject)
    sink.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })
  assert.deepEqual([...readFileSync(target)], [0x89, 0x50, 0x4e, 0x47])

  assert.equal(responseSink(undefined), process.stdout)
})
