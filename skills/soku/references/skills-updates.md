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
