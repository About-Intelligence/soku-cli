# Egress And Security

Use `soku egress` for covered third-party APIs. Soku injects provider
credentials server-side; no third-party API key lives on this machine.

## Egress Pattern

Prefix the skill's `curl` with `soku egress --`:

```bash
soku egress -- curl -H "Authorization: Bearer $AHREFS_API_KEY" "https://api.ahrefs.com/v3/..."
```

`$AHREFS_API_KEY` may be unset locally. That is expected. The CLI strips empty
placeholder auth and the Soku API injects the real credential.

### Which curl flags are understood

`soku egress` forwards four things to the proxy — method, URL, headers, body —
so it parses the curl flags that decide those, and nothing else.

**Honored** (they change the request):

| Flag | Effect |
| --- | --- |
| `-X` / `--request` | HTTP method |
| `-I` / `--head` | method `HEAD` |
| `-H` / `--header` | request header |
| `-d` / `--data` / `--data-raw` / `--data-ascii` / `--data-binary` | body, sent verbatim |
| `--data-urlencode` | body, URL-encoded exactly as curl does |
| `-G` / `--get` | fold the accumulated data into the query string |
| `--url` | request URL |
| `-o` / `--output` | write the response body to this file |

Repeated data flags **accumulate**, joined with `&`, the way curl joins them.
`@file` reads a file and `@-` reads stdin, for both `-d` and `--data-urlencode`.

**Accepted and ignored**: `-s`, `-S`, `-i`, `-v`, `-k`, `-f`/`--fail`, `-L`,
`--compressed`, `-w`, `-m`/`--max-time`, `--connect-timeout`, `--retry`,
`--retry-delay`, `--retry-max-time`, `--retry-all-errors`, `--resolve`,
`--max-redirs`, `--limit-rate`, `-D`, and their long forms. These shape curl's
local behaviour — output noise, timeouts, retry policy — and cannot change the
request that is forwarded. Bundled short flags (`-sSL`) are understood.

**Anything else is an error.** A flag this list does not name stops the command
with a usage error naming the flag; the request is not sent. That is deliberate:
the previous behaviour skipped an unrecognised flag *and did not consume its
value*, so the value fell through and was dropped too. The request went out with
parameters missing and the third party answered about whatever it noticed first
— an error that pointed nowhere near the real cause. If a skill needs a flag
that is not listed, rewrite the request without it (inline the query in the URL,
move a `--form` upload to a body) rather than expecting it to be ignored.

### Encoding matches curl exactly

`--data-urlencode` is form encoding: a space becomes `+` (not `%20`) and
percent-escapes use lowercase hex (`%2c`, not `%2C`). The CLI reproduces this
byte for byte, so prefixing an existing curl does not change what the third
party receives.

List covered hosts:

```bash
soku egress providers
```

For a host not listed, the proxy does not inject credentials. Follow that
skill's own auth instructions instead.

## Do Not Preflight Local Keys

Do not write guards such as:

```bash
test -n "$AHREFS_API_KEY"
```

Do not abort a skill because a key looks missing. Route the call through
`soku egress -- curl ...`.

## Response Semantics

Successful upstream responses are returned verbatim on stdout, not wrapped in a
success envelope. Soku-level failures use the normal CLI error envelope.

## General Security Rules

- Never print the Soku access token.
- Prefer `SOKU_TOKEN` for CI and headless agents.
- Never approve a review-gated write the user has not seen, and never allowlist
  or auto-approve `soku review approve`. Self-approving is allowed only when the
  harness prompts for explicit human confirmation before each command (see the
  review-gate rule in `references/ads-write.md`).
- Avoid literal secret argv values. For Cloudflare Worker setup use
  `--cf-token-env` or `--cf-token-stdin`.
- Pass user-provided values as separate argv elements.
- Treat `verification_uri`, signed URLs, review ids, and provider URLs as
  opaque strings.
