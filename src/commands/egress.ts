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
import { readFileSync } from 'node:fs'
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
}

// A header value carrying only an auth scheme word (or nothing) — the result of
// `-H "Authorization: Bearer $X"` when `$X` is unset. Not a real credential.
const PLACEHOLDER_AUTH = /^\s*(bearer|token|key|basic)?\s*$/i

function readData(value: string): Buffer {
  if (value.startsWith('@')) return readFileSync(value.slice(1))
  return Buffer.from(value)
}

// Long options we consume as `--flag value`; only these are worth un-gluing.
// Restricting the split keeps us from mangling an unknown option's value into a
// stray token (e.g. `--referer=https://x` would otherwise clobber the target
// url) or from splitting a value that happens to look like `--foo=bar`.
const GLUED_OPTS = new Set(['--request', '--header', '--data', '--data-raw', '--data-ascii', '--data-binary', '--url'])

/** Expand glued long options (`--flag=value`) into `--flag`, `value` so both
 * curl forms parse the same, but only for options we actually recognize.
 * Splits on the first `=` only. Pure. */
function expandLongFlags(tokens: string[]): string[] {
  const out: string[] = []
  for (const t of tokens) {
    const eq = t.indexOf('=')
    if (eq > 2 && t.startsWith('--') && GLUED_OPTS.has(t.slice(0, eq))) {
      out.push(t.slice(0, eq), t.slice(eq + 1))
    } else {
      out.push(t)
    }
  }
  return out
}

/** Extract method / url / headers / body from a curl-style token list. Pure. */
export function parseCurl(input: string[]): ParsedCurl {
  const tokens = expandLongFlags(input)
  const headers: Record<string, string> = {}
  let method: string | undefined
  let url: string | undefined
  let body: Buffer | undefined
  let getMode = false

  let i = tokens[0] === 'curl' ? 1 : 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '-X':
      case '--request':
        method = tokens[++i]?.toUpperCase()
        break
      case '-H':
      case '--header': {
        const h = tokens[++i]
        if (h) {
          const idx = h.indexOf(':')
          if (idx > 0) headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim()
        }
        break
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-ascii':
      case '--data-binary': {
        const d = tokens[++i]
        if (d !== undefined) body = readData(d)
        break
      }
      case '-G':
      case '--get':
        getMode = true
        break
      case '--url':
        url = tokens[++i]
        break
      default:
        if (/^https?:\/\//i.test(t)) url = t
        // Unknown flags are skipped; we do not consume their value, so a few
        // exotic curl flags may leak a token — the documented subset is
        // -X/-H/-d/--data*/-G/--url + the URL.
        break
    }
  }

  if (!method) method = body ? 'POST' : 'GET'
  if (getMode && body && url) {
    const u = new URL(url)
    for (const [k, v] of new URLSearchParams(body.toString())) u.searchParams.append(k, v)
    url = u.toString()
    body = undefined
    method = 'GET'
  }
  return { method, url, headers, body }
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

  // Passthrough: stream the upstream body to stdout verbatim.
  if (res.body) {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), process.stdout)
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
      await runEgress(parseCurl(request))
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
