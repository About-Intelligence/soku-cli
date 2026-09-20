# Skills And Updates

Soku distributes two kinds of local agent skills:

- Bundled meta skill: `soku` teaches the CLI basics and references.
- Business skills: catalog skills installed as `soku-<slug>`, for example
  `soku-ads-report`.

## Install

Install the bundled meta skill:

```bash
soku skill install
soku skill install --global
soku skill install --agent claude --global
```

Install business skills:

```bash
soku skill list
soku skill install account-audit
soku skill install ads-report google-ads
soku skill install --all
soku skill status
soku skill list-installed
```

Business skill install automatically ensures the `soku` meta skill exists.
Installed business skill names are Soku-prefixed:

```text
use @soku-ads-report skill
```

Use catalog slugs for install/remove (`ads-report`) and agent names for
invocation (`soku-ads-report`).

## Update

```bash
soku update status
soku update skills
soku update cli
```

Normal `soku` commands schedule a background skill refresh at most once every 24
hours. Controls:

```bash
SOKU_NO_SKILL_AUTO_UPDATE=1
SOKU_UPDATE_INTERVAL_HOURS=6
SOKU_AUTO_UPDATE_CLI=1
```

The CLI binary itself is advisory by default. Run `soku update cli` to install
the latest npm package unless the user explicitly opted into auto CLI updates.

## Legacy Meta-Only Installs

Older installations may have only:

```text
<skillsDir>/soku/SKILL.md
```

with no `.soku-skills.json` manifest and no `references/` directory.
`soku update skills` detects those legacy meta-only installs, refreshes
`SKILL.md`, copies `references/`, and writes a Soku-managed manifest entry.

Global `npm i -g @soku-ai/cli` also refreshes already-installed global meta
skills after npm finishes installing. It does not install new business skills
and does not scan project-local directories.

`soku update cli` runs that same global `npm i -g` under the hood, so its JSON
result includes `mustRereadMetaSkill` and `metaSkillRefreshed: [<paths>]`. When
`mustRereadMetaSkill` is true, re-read this skill from the listed path(s)
before continuing — the on-disk copy just changed underneath this session.

## Remove

```bash
soku skill remove ads-report
soku skill remove soku
```

Removing the last Soku-managed skill removes the local `.soku-skills.json`
manifest.

## After Upgrading The CLI

An upgrade can add, change, or retire capabilities, which invalidates whatever
this session believed the CLI could do. Ask the CLI itself rather than guessing:

```bash
soku changelog --since <the version you upgraded from> --summary
soku changelog --since <the version you upgraded from>
```

`--summary` gives counts per version; without it, each entry lists the actions
that were added or removed and, for a surviving action, which fields changed.
Output is the usual JSON envelope in a non-TTY context, so it can be parsed.

The changelog is bundled with the installed CLI, so it always describes the
binary that is running and needs no network call. It cannot speak for versions
older than its `historyStartsAt`; when `--since` reaches past that, the response
sets `truncated: true` and says so rather than implying nothing changed.

This skill records the CLI release it was written against in the line right
under its title. If the installed CLI is newer, run the command
above before relying on details in these reference files.

## Community Skills In The Active Brand

Local `soku skill install` installs a business skill into the calling agent.
`brand skill` manages skills in the active Soku brand instead. Official catalog
installs and community installs have separate commands:

```bash
soku workspace status
soku brand skill community list --query "audit" --sort installs --limit 30 --offset 0
soku brand skill community install growth-audit
soku brand skill community install growth-audit --expected-price-credits 300
soku brand skill publish my-skill --categories analytics,ads --price-credits 300
```

Browse first: the list includes price, entitlement, installed version, and
available updates. Only pass `--expected-price-credits` after the user agrees
to that skill's exact one-time price for the active organization. Without the
flag, a paid skill needing purchase returns `purchase_required`; already owned,
free, and publisher-entitled skills can install without a new purchase.
A changed price returns `conflict` with `error.details.code = price_changed` and
`error.details.price_credits`. Obtain agreement to the new price before retrying;
never automatically restate the server's price. Reinstall upgrades an existing
community copy. Read it first if the brand has local edits.

`publish` publishes an uploaded private skill. Omit `--price-credits` to retain
the listing price; use 0 for free or 100–20000 for paid. Publishing paid versions
requires a paid plan and review: inspect `skill.status` and
`skill.pending_version.review_status`, and never describe a pending version as
live. New versions require a version bump in SKILL.md. These mutations are not
ads review-gated and run immediately subject to server admission.
