import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCurl, stripPlaceholderAuth } from './egress.js'

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

test('accepts --url and is tolerant of unknown flags', () => {
  const r = parseCurl(['curl', '-s', '--url', 'https://x.test/a', '-H', 'X-Key: v'])
  assert.equal(r.url, 'https://x.test/a')
  assert.equal(r.headers['x-key'], 'v')
})

test('parses glued --flag=value the same as the space form', () => {
  const r = parseCurl(['curl', '--request=POST', '--url=https://x.test/a', '--header=X-Key: v', '--data={"a":1}'])
  assert.equal(r.method, 'POST')
  assert.equal(r.url, 'https://x.test/a')
  assert.equal(r.headers['x-key'], 'v')
  assert.equal(r.body?.toString(), '{"a":1}')
})

test('splits glued --header on the first = only', () => {
  const r = parseCurl(['curl', '--url=https://x.test/a', '--header=X-Foo: a=b'])
  assert.equal(r.headers['x-foo'], 'a=b')
})

test('does not expand glued unknown options over the real url', () => {
  const r = parseCurl(['curl', 'https://api.example/real', '--referer=https://ref.example'])
  assert.equal(r.url, 'https://api.example/real')
})

test('does not split a value that looks like a glued flag', () => {
  const r = parseCurl(['curl', 'https://x.test/a', '--data', '--foo=bar'])
  assert.equal(r.body?.toString(), '--foo=bar')
})

test('keeps a --data value that itself looks like a recognized glued option', () => {
  const r = parseCurl(['curl', '--data', '--url=https://payload.invalid', 'https://target.invalid'])
  assert.equal(r.method, 'POST')
  assert.equal(r.url, 'https://target.invalid')
  assert.equal(r.body?.toString(), '--url=https://payload.invalid')
})

test('--data-raw keeps a literal @ payload instead of reading a file', () => {
  const r = parseCurl(['curl', 'https://x.test/a', '--data-raw=@/no/such/soku-egress-test'])
  assert.equal(r.body?.toString(), '@/no/such/soku-egress-test')
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
