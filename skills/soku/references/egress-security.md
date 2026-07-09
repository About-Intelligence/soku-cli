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
