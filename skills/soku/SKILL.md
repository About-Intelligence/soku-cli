---
name: soku
description: >-
  Use when calling Soku CLI capabilities from a shell: auth, workspace
  selection, ads/GA4/PostHog data reads, typed ads writes, SEO Hosting,
  automations, Context Hub files, temporary file publishing, brand skills,
  third-party egress, review-gated writes, skill installation, or CLI updates.
license: MIT
metadata:
  author: About Intelligence
  version: "0.4"
---

# Soku CLI

The `soku` CLI is the shell-native way for an AI agent to use Soku from Claude
Code, Codex, Cursor, or any terminal. It talks to Soku over `/api/cli/*`; no MCP
host is required. Treat this file as the router. Load the relevant reference
file before acting on a detailed workflow.

## Reference Router

Read only the reference files needed for the user's task:

| Task | Read |
| --- | --- |
| First-time setup, expired token, workspace selection, org/brand ambiguity | `references/auth-workspace.md` |
| Ads, GA4, or PostHog reads; raw `soku call`; command discovery | `references/data-capabilities.md` and `references/capability-flow.md` |
| Meta/Google/ChatGPT Ads writes, uploads, bulk create, review-gated approval | `references/ads-write.md` |
| SEO Hosting, automations, Context Hub files, temporary public file URLs | `references/seo-automation-files.md` |
| Third-party APIs through server-side credential injection; security rules | `references/egress-security.md` |
| Installing, updating, or removing Soku-managed local skills | `references/skills-updates.md` |

For an installed business skill such as `soku-ads-report`, read that skill too.
Business skills carry their own "Running this skill with the Soku CLI" section.

## Default Flow

1. Check auth/workspace state:

```bash
soku auth status
soku workspace status
```

2. If auth is missing or expired, use the agent split-flow from
`references/auth-workspace.md`.

3. If the workspace is not ready, resolve and select the remote Soku brand:

```bash
soku workspace resolve <brand>
soku workspace use-brand <brand>
```

4. Pick the reference for the task. Do not infer Soku org/brand from the current
local repo directory.

5. Inspect command help before unfamiliar calls:

```bash
soku --help
soku <namespace> --help
soku <namespace> <action> --help
```

6. Run the command and parse JSON output. In non-TTY contexts, success is
`{"ok":true,"data":...}` and errors are `{"ok":false,"error":...}`.

## Non-Negotiable Rules

- Never print or persist the Soku access token.
- Never ask the user to paste third-party provider keys for covered providers.
- Do not fail just because an upstream provider key env var is unset. Use
  `soku egress -- curl ...` for covered third-party APIs.
- A human must authorize every review-gated write — but don't force a
  copy-paste. If your harness prompts for explicit human confirmation before
  each shell command (e.g. Claude Code's permission prompt), you MAY run
  `soku review approve <id>` yourself after showing the user the diff/summary;
  that confirmation prompt is the human gate. Never allowlist or auto-approve
  `soku review approve`/`deny`, and never approve a write the user has not seen.
  If your harness runs commands without per-command human confirmation, do NOT
  self-approve — surface the `review_id` for the user to run.
- Pass user values as separate argv elements. Do not build a shell command by
  string-concatenating untrusted values.
- Do not scan local repo files, `AGENTS.md`, or `context/` folders for Soku
  workspace state unless the user explicitly asks about local files.
- When a command prints a hint, follow it before retrying. Do not loop blindly.

## Exit Codes

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Success | Parse `data`. |
| 1 | Usage or no workspace | Fix args, or run `soku workspace status` / `use-brand`. |
| 2 | Auth missing, expired, or revoked | Run `soku auth login --no-wait`. |
| 4 | Not found or unknown capability | Re-check `soku --help` / `soku <ns> --help`. |
| 5 | Runtime or network failure | Retry if transient; if behind a proxy set `ALL_PROXY`. |

## Capability Discovery

Typed command names are kebab-case:

```bash
soku ads query-single-dimension --help
```

Raw `soku call` action names use registry snake_case:

```bash
soku call ads query_single_dimension --payload '{"account_id":"123","dimension":"campaign"}'
```

Prefer typed commands when they exist. Use `soku call` only as a forward-compatible
escape hatch for a newer action or an action not yet exposed ergonomically.

## Installed Skill Names

The bundled CLI meta skill is named `soku`. Business skills are installed with a
Soku prefix, for example `soku-ads-report` and `soku-google-ads`.

```bash
soku skill list
soku skill install ads-report google-ads
soku skill status
```

When asking an AI client to invoke a business skill, write
`use @soku-ads-report skill`, not `@ads-report`.

## Updating This Skill

`soku update skills` refreshes the bundled `soku` meta skill and every installed
Soku-managed business skill recorded in `.soku-skills.json`. It also refreshes
legacy meta-only installs that have `soku/SKILL.md` but no manifest, so older
installations receive this `references/` directory.

`soku update cli` also silently refreshes an already-installed global `soku`
meta skill as an npm postinstall side effect. Its JSON result carries
`mustRereadMetaSkill: true` plus `metaSkillRefreshed: [<paths>]` when that
happened. After running `soku update cli`, check that field: if true, re-read
this file (and `references/`) from the listed path before continuing — do not
keep acting on this session's previously loaded copy of this skill.
