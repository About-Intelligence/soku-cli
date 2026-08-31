/** `soku egress -- <curl…>` — proxy a third-party API call through Soku so the
 * credential is injected server-side (no API key on this machine), and
 * `soku egress providers` — list the covered hosts.
 *
 * The agent prefixes its existing skill `curl` with `soku egress --`; we parse
 * the curl, strip any placeholder auth header, and forward the request to
 * `/api/cli/egress`. The upstream response is streamed back to stdout verbatim,
 * so the skill sees exactly what a direct call would return. Only Soku-level
 * failures (auth, allowlist, billing) become a CLI error envelope.
 */

import { randomUUID } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { Command } from 'commander'

import { clearToken, loadToken } from '../auth/store.js'
import { loadConfig, resolveApiBaseUrl } from '../config.js'
import { apiRequest } from '../http/client.js'
import { cyan, dim, emitError, emitSuccess, ExitCode, table } from '../output/envelope.js'

export interface ParsedCurl {
  method?: string
  url?: string
  headers: Record<string, string>
  body?: Buffer
  /** `-o/--output`: write the upstream body here instead of stdout. */
  output?: string
}

// A header value carrying only an auth scheme word (or nothing) — the result of
// `-H "Authorization: Bearer $X"` when `$X` is unset. Not a real credential.
const PLACEHOLDER_AUTH = /^\s*(bearer|token|key|basic)?\s*$/i

export class CurlUsageError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message)
  }
}

function readData(value: string): Buffer {
  // `@-` means stdin, which is how the published Gemini skills feed a heredoc
  // JSON body. `readFileSync('-')` looked for a file literally named `-`.
  if (value === '@-') return readFileSync(0)
  if (value.startsWith('@')) return readFileSync(value.slice(1))
  return Buffer.from(value)
}

/** Encode exactly as curl's `--data-urlencode` does.
 *
 * Measured against curl 8.7.1 rather than assumed, because two details are easy
 * to get wrong and both change the bytes the upstream receives:
 *
 *   - a space becomes `+`, NOT `%20` — this is form encoding, not RFC 3986
 *   - hex digits are LOWERCASE (`%2c`), where `encodeURIComponent` emits `%2C`
 *
 * Unreserved characters (`A-Za-z0-9-._~`) pass through; everything else is
 * percent-encoded per UTF-8 byte. Matching curl is the point: the whole promise
 * of `soku egress` is that prefixing an existing skill's curl changes nothing
 * about the request that reaches the third party.
 */
export function curlEscape(value: string): string {
  let out = ''
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch
    else if (ch === ' ') out += '+'
    else out += `%${byte.toString(16).padStart(2, '0')}`
  }
  return out
}

/** Build one `--data-urlencode` segment, following curl's four forms.
 *
 *   content        -> encoded content, no name
 *   =content       -> encoded content, no name (leading `=` dropped)
 *   name=content   -> `name=` kept literal, content encoded
 *   @file          -> encoded file bytes, no name
 *   name@file      -> `name=` kept literal, encoded file bytes
 *
 * Whichever of `=` or `@` appears first decides the form, matching curl.
 */
export function buildUrlEncodedSegment(
  spec: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  const eq = spec.indexOf('=')
  const at = spec.indexOf('@')

  if (eq !== -1 && (at === -1 || eq < at)) {
    const name = spec.slice(0, eq)
    const content = spec.slice(eq + 1)
    return name ? `${name}=${curlEscape(content)}` : curlEscape(content)
  }
  if (at !== -1) {
    const name = spec.slice(0, at)
    const path = spec.slice(at + 1)
    let content: string
    try {
      content = path === '-' ? readFileSync(0, 'utf8') : readFile(path)
    } catch (err) {
      throw new CurlUsageError(
        `--data-urlencode could not read file: ${path} (${(err as Error).message})`,
      )
    }
    return name ? `${name}=${curlEscape(content)}` : curlEscape(content)
  }
  return curlEscape(spec)
}

/** Short flags that take no value, so `-sSL` can be split into `-s -S -L`. */
const NO_VALUE_SHORT = new Set(['s', 'S', 'i', 'v', 'k', 'f', 'L', 'G', 'I', 'g', 'j', '#'])

/** Flags accepted and deliberately ignored, with no value to consume.
 *
 * Every one of these shapes curl's LOCAL behaviour — stderr noise, TLS
 * strictness, redirect handling, exit-code policy — and cannot change the
 * `{method, url, headers, body}` this command forwards. Ignoring them is
 * therefore not silent data loss; dropping a flag that WOULD change the request
 * is, which is why anything not listed here is now an error.
 */
const IGNORED_NO_VALUE = new Set([
  '-s', '--silent',
  '-S', '--show-error',
  '-i', '--include',
  '-v', '--verbose',
  '-k', '--insecure',
  '-f', '--fail', '--fail-with-body', '--fail-early',
  '-L', '--location', '--location-trusted',
  '--compressed',
  '--no-progress-meter',
  '-#', '--progress-bar',
  '--retry-all-errors', '--retry-connrefused',
  '-g', '--globoff',
  '-j', '--junk-session-cookies',
  '--no-keepalive',
  '--tcp-nodelay',
])

/** Accepted-and-ignored flags that consume one value.
 *
 * Consuming the value is the point: an unconsumed value becomes a stray token,
 * which is exactly how `--data-urlencode country=us` used to lose its argument.
 */
const IGNORED_WITH_VALUE = new Set([
  '-m', '--max-time',
  '--connect-timeout',
  '--retry', '--retry-delay', '--retry-max-time',
  '--limit-rate',
  '-w', '--write-out',
  '--resolve',
  '--max-redirs',
  '--noproxy',
  '-D', '--dump-header',
])

/** Expand a bundled short-flag token (`-sSL`) into its parts.
 *
 * Only bundles made entirely of no-value short flags expand; anything else is
 * rejected rather than guessed at, because a bundle ending in a value-taking
 * flag (`-so out.json`) would otherwise silently mis-assign the value.
 */
export function expandShortBundle(token: string): string[] | null {
  if (!/^-[A-Za-z#]{2,}$/.test(token)) return null
  const letters = token.slice(1).split('')
  if (!letters.every((c) => NO_VALUE_SHORT.has(c))) return null
  return letters.map((c) => `-${c}`)
}

/** Extract method / url / headers / body from a curl-style token list. Pure.
 *
 * Anything this parser does not understand is now an error. The previous
 * behaviour — skip the flag, and do not consume its value — meant an
 * unsupported flag vanished, its value was dropped as a stray token, and the
 * request went out anyway with parameters missing. The upstream then answered
 * about the first thing it noticed missing, which sent every investigation in
 * the wrong direction.
 */
export function parseCurl(tokens: string[]): ParsedCurl {
  const headers: Record<string, string> = {}
  let method: string | undefined
  let url: string | undefined
  let output: string | undefined
  let getMode = false
  // Every data flag appends here, and the parts join with `&`, matching curl.
  // Assigning instead (the old behaviour) meant `-d a=1 -d b=2` sent only b=2.
  const dataParts: string[] = []

  const expanded: string[] = []
  const start = tokens[0] === 'curl' ? 1 : 0
  for (let i = start; i < tokens.length; i++) {
    const bundle = expandShortBundle(tokens[i])
    if (bundle) expanded.push(...bundle)
    else expanded.push(tokens[i])
  }

  for (let i = 0; i < expanded.length; i++) {
    const t = expanded[i]

    const requireValue = (flag: string): string => {
      const v = expanded[++i]
      if (v === undefined) throw new CurlUsageError(`${flag} expects a value.`)
      return v
    }

    switch (t) {
      case '-X':
      case '--request':
        method = requireValue(t).toUpperCase()
        break
      case '-I':
      case '--head':
        method = 'HEAD'
        break
      case '-H':
      case '--header': {
        const h = requireValue(t)
        const idx = h.indexOf(':')
        if (idx > 0) headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim()
        break
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-ascii':
      case '--data-binary':
        dataParts.push(readData(requireValue(t)).toString())
        break
      case '--data-urlencode':
        dataParts.push(buildUrlEncodedSegment(requireValue(t)))
        break
      case '-G':
      case '--get':
        getMode = true
        break
      case '--url':
        url = requireValue(t)
        break
      case '-o':
      case '--output':
        output = requireValue(t)
        break
      default: {
        if (IGNORED_NO_VALUE.has(t)) break
        if (IGNORED_WITH_VALUE.has(t)) {
          requireValue(t)
          break
        }
        if (t.startsWith('-')) {
          throw new CurlUsageError(
            `Unsupported curl flag: ${t}`,
            'soku egress forwards {method, url, headers, body}. Supported: ' +
              '-X/--request, -I/--head, -H/--header, -d/--data(-raw|-ascii|-binary), ' +
              '--data-urlencode, -G/--get, --url, -o/--output. ' +
              'Rewrite the request without this flag, or open an issue to add it.',
          )
        }
        if (url !== undefined) {
          throw new CurlUsageError(
            `Unexpected argument: ${t}`,
            'Only one URL is supported; a stray argument usually means a flag before it was misspelled.',
          )
        }
        url = t
        break
      }
    }
  }

  const data = dataParts.join('&')
  let body: Buffer | undefined = data ? Buffer.from(data) : undefined

  if (!method) method = body ? 'POST' : 'GET'
  if (getMode && body && url) {
    // Append the already-encoded query verbatim. Round-tripping it through
    // URLSearchParams would re-encode it, changing the exact bytes curl would
    // have sent (uppercase hex, and `%2A` where curl writes `%2a`).
    url = `${url}${url.includes('?') ? '&' : '?'}${data}`
    body = undefined
    method = 'GET'
  }
  return { method, url, headers, body, output }
}

/** Drop empty / bare-scheme auth headers so the server injects the real key
 * (an empty `Authorization: Bearer ` would otherwise be treated as BYO). */
export function stripPlaceholderAuth(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (PLACEHOLDER_AUTH.test(v)) continue
    out[k] = v
  }
  return out
}

function workspace(): { orgId: string; brandId: string } {
  const cfg = loadConfig()
  const orgId = process.env.SOKU_ORG_ID || cfg.activeOrgId
  const brandId = process.env.SOKU_BRAND_ID || cfg.activeBrandId
  if (!orgId || !brandId) {
    emitError(
      'no_workspace',
      'No active workspace selected.',
      ExitCode.USAGE,
      'Run `soku org use <id>` then `soku brand use <id>`.',
    )
  }
  return { orgId, brandId }
}

function egressErrorExit(status: number, type: string, message: string): never {
  const code =
    status === 401 || status === 403
      ? ExitCode.AUTH
      : status === 402 || status === 400
        ? ExitCode.USAGE
        : status === 404
          ? ExitCode.NOT_FOUND
          : ExitCode.RUNTIME
  return emitError(type, message, code)
}

/** Where the upstream body goes: the `-o` file, or stdout when none was given. */
export function responseSink(output: string | undefined): NodeJS.WritableStream {
  return output ? createWriteStream(output) : process.stdout
}

async function runEgress(parsed: ParsedCurl): Promise<void> {
  if (!parsed.url) {
    emitError('usage', 'No URL found in the egress request.', ExitCode.USAGE, 'Usage: soku egress -- curl <url>')
  }
  const token = await loadToken()
  if (!token) {
    emitError('not_authenticated', 'No Soku session found.', ExitCode.AUTH, 'Run `soku auth login`.')
  }
  const { orgId, brandId } = workspace()
  const headers = stripPlaceholderAuth(parsed.headers)
  const spec = { method: parsed.method, url: parsed.url, headers, id: randomUUID() }
  const specHeader = Buffer.from(JSON.stringify(spec)).toString('base64')

  const base = resolveApiBaseUrl()
  let res: Response
  try {
    res = await fetch(`${base}/api/cli/egress`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Soku-Org': orgId,
        'X-Soku-Brand': brandId,
        'X-Soku-Egress-Spec': specHeader,
        ...(parsed.body ? { 'Content-Type': 'application/octet-stream' } : {}),
      },
      body: parsed.body,
    })
  } catch (err) {
    return emitError(
      'network_error',
      `Could not reach ${base}: ${(err as Error).message}`,
      ExitCode.RUNTIME,
      'Behind a proxy? Set ALL_PROXY.',
    )
  }

  // Success always carries the upstream marker; anything else is a Soku-level
  // failure (auth/workspace dependency error, or an _egress_error envelope).
  if (res.headers.get('x-soku-egress') !== 'upstream') {
    if (res.status === 401) await clearToken()
    const parsedBody = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const errObj =
      (parsedBody?.error as Record<string, unknown> | undefined) ??
      (parsedBody?.detail as Record<string, unknown> | undefined) ??
      {}
    const type = String(errObj.type ?? errObj.error ?? 'egress_error')
    const message = String(errObj.message ?? `Egress failed (HTTP ${res.status}).`)
    egressErrorExit(res.status, type, message)
  }

  // Passthrough: stream the upstream body verbatim — to the `-o` file when the
  // caller asked for one, otherwise stdout. Skills that download binary assets
  // (a rendered screenshot, say) pass `-o`, and dropping it would put the bytes
  // on stdout while the next step went looking for a file that never appeared.
  if (res.body) {
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(source, responseSink(parsed.output))
  }
  process.exit(ExitCode.OK)
}

interface ProviderItem {
  id: string
  hostnames: string[]
  auth: { location: string; name: string }
}

export function registerEgressCommands(program: Command): void {
  const egress = program
    .command('egress')
    .description('Proxy a third-party API call with a server-injected credential')
    .argument('[request...]', 'the third-party request, e.g. `-- curl -H "..." https://host/path`')
    .allowUnknownOption()
    .action(async (request: string[]) => {
      let parsed: ParsedCurl
      try {
        parsed = parseCurl(request)
      } catch (err) {
        if (err instanceof CurlUsageError) {
          emitError('usage', err.message, ExitCode.USAGE, err.hint)
        }
        throw err
      }
      await runEgress(parsed)
    })

  egress
    .command('providers')
    .description('List third-party hosts the egress proxy injects credentials for')
    .action(async () => {
      const data = await apiRequest<{ providers: ProviderItem[]; count: number }>(
        '/api/cli/egress/providers',
        { workspace: true },
      )
      emitSuccess(data, (d) => {
        const t = table(
          d.providers.map((p) => ({
            id: p.id,
            hosts: p.hostnames.join(', '),
            auth: `${p.auth.location}:${p.auth.name}`,
          })),
          [
            { key: 'id', header: 'PROVIDER' },
            { key: 'hosts', header: 'HOSTS' },
            { key: 'auth', header: 'AUTH' },
          ],
        )
        return `${t}\n${dim(`${d.count} covered · call via: `)}${cyan('soku egress -- curl <url>')}`
      })
    })
}
