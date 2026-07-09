# Soku CLI

[![npm](https://img.shields.io/npm/v/@soku-ai/cli.svg)](https://www.npmjs.com/package/@soku-ai/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

`soku` is the shell-native way for an AI agent — Claude Code, Codex, Cursor, or
any terminal — to use [Soku](https://soku.ai): auth, workspace selection,
Google Ads / GA4 / PostHog data reads, typed ads writes, SEO Hosting,
automations, Context Hub files, third-party egress, and skill management. It
talks to Soku over `/api/cli/*`; no MCP host is required.

## Install

```bash
npm install -g @soku-ai/cli
# or run without installing
npx @soku-ai/cli --help
```

Requires Node.js >= 20.

## Quickstart

```bash
# 1. Authenticate (device flow — opens a browser / prints a QR code)
soku auth login

# 2. Pick your workspace (org + brand)
soku workspace use

# 3. Discover capabilities and make a call
soku --help
soku ads report --help
```

Optional: install the bundled `soku` agent skill so an AI agent knows how to
drive the CLI — see [`skills/soku/SKILL.md`](./skills/soku/SKILL.md).

## Capability model

The CLI's typed command tree is generated from a capability manifest at
[`src/generated/capabilities.json`](./src/generated/capabilities.json). **This
file is generated upstream and synced into this repository automatically — do
not hand-edit it.** New capabilities appear here when the Soku backend adds
them; a change to the backend's capability surface triggers an automated PR that
updates this file. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## Development

```bash
pnpm install        # installs deps (uses the pinned pnpm version)
pnpm typecheck      # tsc --noEmit
pnpm test           # compile + node:test runner
pnpm build          # emit dist/ + copy the capability manifest
```

- Source: `src/` (TypeScript, ESM, `NodeNext` module resolution)
- Tests: colocated `*.test.ts`, run with the built-in `node --test` runner
- `keytar` is an optional dependency — credential storage degrades gracefully to
  a file-backed store when the native module is unavailable.

## Contributing

Issues and pull requests are welcome. Please read
[CONTRIBUTING.md](./CONTRIBUTING.md) and our
[Code of Conduct](./CODE_OF_CONDUCT.md) first. For security reports, see
[SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © About Intelligence
