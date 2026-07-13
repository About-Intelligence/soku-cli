<div align="center">
  <a href="https://soku.ai">
    <img src="./assets/soku-mark.svg" alt="Soku" width="104" />
  </a>
  <h1>Soku CLI</h1>
  <p><strong>Give any AI agent a secure command line to your growth stack.</strong></p>
  <p>
    Query marketing data, manage campaigns, publish SEO content, and automate<br />
    recurring work from Claude Code, Codex, Cursor, or any terminal.
  </p>
  <p>
    <a href="https://www.npmjs.com/package/@soku-ai/cli"><img src="https://img.shields.io/npm/v/@soku-ai/cli?color=ff6b00&amp;label=npm" alt="npm version" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&amp;logoColor=white" alt="Node.js 20 or newer" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-black.svg" alt="MIT license" /></a>
  </p>
  <p>
    <a href="https://soku.ai">Website</a> ·
    <a href="https://soku.ai/cli/skill.md">Agent guide</a> ·
    <a href="https://www.npmjs.com/package/@soku-ai/cli">npm</a> ·
    <a href="./CONTRIBUTING.md">Contributing</a>
  </p>
</div>

---

Soku CLI turns the tools and data already connected to your Soku workspace into
typed, discoverable commands. An agent can move from a question to an answer—or
from a plan to a human-approved action—without you copying data between tabs,
sharing API keys, or running an MCP host.

## Why Soku CLI?

- **One interface for your growth stack.** Work with Google Ads, Meta Ads,
  ChatGPT Ads, GA4, PostHog, SEO Hosting, automations, Context Hub, and more.
- **Built for agents, useful in a shell.** Commands are self-documenting, and
  non-interactive output uses a stable JSON envelope that agents and scripts can
  parse reliably.
- **Credentials stay out of prompts.** Soku handles authentication and can inject
  connected third-party credentials server-side.
- **Writes have a human gate.** Delivery-changing ads operations create a review
  request before anything goes live.
- **New capabilities arrive automatically.** The typed command tree is generated
  from Soku's capability registry, with `soku call` as a forward-compatible
  escape hatch.

## Quick start

### Let your AI agent set it up (recommended)

Paste this into Claude Code, Codex, Cursor, or another coding agent:

```text
Read https://soku.ai/cli/skill.md, install or update Soku CLI, sign in,
select my workspace, and install all business skills.
```

The agent guide walks the agent through installation, device login, workspace
selection, skill installation, and a first capability check.

### Set it up manually

```bash
# Install globally (Node.js 20+)
npm install -g @soku-ai/cli

# Sign in with the browser-based device flow
soku auth login

# Find and select a Soku brand workspace
soku workspace resolve <brand>
soku workspace use-brand <brand>
soku workspace status

# See everything available to you
soku --help
```

No global install needed? Start with `npx @soku-ai/cli --help`.

## What can you do with it?

### Turn ad data into answers

Start with cached, normalized reporting across supported ad platforms:

```bash
soku ads list-ad-accounts --platform google

soku ads query-single-dimension \
  --platform google \
  --account-id <account_id> \
  --dimension campaign \
  --date-start 2026-06-01 \
  --date-end 2026-06-30
```

Use the same workflow for Meta, TikTok, or ChatGPT Ads, or reach for Google Ads
GAQL when you need a custom breakdown.

### Understand acquisition and product behavior together

```bash
# Website acquisition and conversion
soku ga4 list-properties
soku ga4 get-property-overview --property-id <property_id>
soku ga4 list-traffic-sources --property-id <property_id>

# Product behavior
soku posthog list-projects
soku posthog query \
  --project-id <project_id> \
  --tool execute-sql \
  --arguments '{"query":"SELECT count() FROM events WHERE event = '\''$pageview'\''"}'
```

This makes it possible for an agent to investigate the path from campaign spend
to site traffic to in-product behavior without asking you to export CSV files.

### Create campaign changes with a human in control

```bash
soku ads meta campaign create \
  --account-id <meta_account_id> \
  --name "Launch Test" \
  --objective OUTCOME_TRAFFIC \
  --summary "Create paused Meta traffic campaign Launch Test"
```

Delivery-changing writes return a review ID instead of executing immediately:

```bash
soku review show <review_id>
soku review approve <review_id>
```

An agent can prepare the exact change and explain it; a human still decides
whether it runs.

### Publish and automate growth work

```bash
# Publish a complete HTML page through Soku SEO Hosting
soku seo-hosting pages put \
  --section blog \
  --slug launch-notes \
  --title "Launch notes" \
  --html-file page.html
soku seo-hosting pages publish --section blog --slug launch-notes

# Schedule a recurring agent task
soku automation create \
  --name "Weekly account health" \
  --prompt "Review paid acquisition performance and flag anomalies" \
  --cron "0 9 * * 1" \
  --timezone America/Los_Angeles

# Add source material to the workspace Context Hub
soku context upload ./campaign-brief.pdf --dir research
```

## Agent-native by design

In a non-interactive shell, every command returns a predictable JSON envelope:

```json
{"ok":true,"data":{"...":"..."}}
```

Errors use the same shape and a non-zero exit code:

```json
{"ok":false,"error":{"code":"...","message":"..."}}
```

Install Soku's agent skills to give your agent the workflows and guardrails
behind the commands—not just their names:

```bash
soku skill install --all --global
soku skill list
soku skill status
```

The bundled meta skill is available at [`skills/soku/SKILL.md`](./skills/soku/SKILL.md).

## Command map

| Area | Start here | Typical use |
| --- | --- | --- |
| Authentication | `soku auth --help` | Sign in, sign out, and check session state |
| Workspace | `soku workspace --help` | Resolve and switch organization/brand context |
| Advertising | `soku ads --help` | Query reporting data and prepare reviewed writes |
| Analytics | `soku ga4 --help`, `soku posthog --help` | Analyze acquisition, conversion, and product behavior |
| SEO Hosting | `soku seo-hosting --help` | Stage, publish, and manage SEO pages and domains |
| Automations | `soku automation --help` | Schedule and inspect recurring agent work |
| Context Hub | `soku context --help` | Organize files an agent can use as context |
| Secure egress | `soku egress --help` | Call supported third-party APIs without exposing keys |
| Reviews | `soku review --help` | Inspect and decide on gated operations |
| Skills | `soku skill --help` | Install and update Soku workflows for AI agents |

Run `soku <namespace> <action> --help` before an unfamiliar call. Typed command
names use kebab-case; raw capability names used with `soku call` use snake_case.

## How it works

The CLI talks to Soku over `/api/cli/*`; it does not require an MCP host. Its
typed commands are generated from
[`src/generated/capabilities.json`](./src/generated/capabilities.json), which is
synced automatically from the Soku backend. Do not edit that file by hand.

If a newly released capability does not yet have an ergonomic typed command,
you can still discover it and call it directly:

```bash
soku call ads list_ad_accounts -p platform=google
soku call <namespace> <action> --help
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The project is TypeScript with ESM and `NodeNext` module resolution. Tests are
colocated as `*.test.ts` files and run with Node's built-in test runner.
`keytar` is optional; when it is unavailable, credential storage falls back to
a file-backed store.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md)
and our [Code of Conduct](./CODE_OF_CONDUCT.md) before contributing. Please use
[SECURITY.md](./SECURITY.md) to report security issues.

## License

[MIT](./LICENSE) © About Intelligence
