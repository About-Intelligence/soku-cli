# Authentication And Workspace

Soku CLI auth is machine-level and org-agnostic. The active org and brand are
selected separately and sent on each workspace-scoped request.

## Agent Login: Non-Blocking Split Flow

In a shell/container agent environment, prefix every `soku auth login` call —
including the `--device-code` resume command below — with
`SOKU_NO_KEYCHAIN=1`. The token is only written on the resume/poll step, so if
each command runs in a fresh process (e.g. a new turn), an `export` on the
first call alone will not cover it. The CLI's OS-keychain lookup can hang
indefinitely with no output on boxes without a working keychain/D-Bus session
— that hang never times out or errors, so there is nothing to catch and retry
once it happens. The flag skips the OS keychain and stores the token in
`~/.soku/credentials.json` (0600) instead; this has no downside for an agent
session.

Do not block a turn waiting for browser approval. Start login with:

```bash
SOKU_NO_KEYCHAIN=1 soku auth login --no-wait
```

Return the exact `verification_uri` and `user_code` to the user, then stop. Do
not edit, re-encode, or reconstruct the URL. After the user approves, resume
with the exact `next` command returned by the CLI, prefixed the same way:

```bash
SOKU_NO_KEYCHAIN=1 soku auth login --device-code <device_code>
```

If the browser approval page shows no workspace options (for example, a
platform admin with no org memberships), the user can approve directly without
selecting a workspace. Select a brand after login with
`soku workspace use-brand`.

For CI or headless contexts, use `SOKU_TOKEN`; do not echo it.

## Resources

The CLI resource model has been retired — `--resource` is **no longer needed
for anything**. A default `soku auth login` reaches the entire CLI surface: all
data commands (`soku ads / ga4 / posthog / call ...`) **and** every sub-command
(`soku seo-hosting / automation / files / context / brand skill ...`). Writes
still return a HITL review the user approves; that is the only gate left
(besides the active org/brand). The `--resource` flag and the `soku resources`
command have been removed from the CLI.

## Workspace

Never infer Soku workspace state from the local shell directory.

```bash
soku workspace status
soku workspace resolve <brand>
soku workspace use-brand <brand>
```

If `resolve` is ambiguous, show the candidates and ask the user which exact
brand/org to use. For one-off scripts, `SOKU_ORG_ID` and `SOKU_BRAND_ID` can
override saved config.

Legacy commands still work, but prefer `workspace` for agent flows:

```bash
soku org list
soku org use <slug-or-id>
soku brand list
soku brand use <slug-or-id>
```

## Platform Admins

`soku auth status` reports `is_platform_admin`, which is `true` only for an
active platform admin. An active platform admin can work across every active
org without holding an org membership: `soku workspace use-brand`,
`soku workspace resolve`, `soku org list`, and `soku brand list` cover the
full set of active orgs and brands. Everyone else stays scoped to the orgs
where they have a membership.

## Session State

```bash
soku auth status
soku auth logout
```

On exit code 2 with an expired or revoked token, the CLI drops the stored token.
Run the split login flow again.

## Brand Memory

Memory is scoped to the active Soku workspace:

```bash
soku memory list
soku memory search "policy"
soku memory get reference noiz-policy-event
```

Use memory as background and investigation leads. Do not report memory-derived
context as verified fact unless the same turn confirms it with data actions,
change history, billing evidence, or another authoritative source.
