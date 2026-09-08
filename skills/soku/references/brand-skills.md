# Brand Skills

`soku brand skill ...` manages the skills inside the **active Soku brand
workspace** — what the Soku agent loads for that brand. This is different from
`soku skill ...`, which installs Soku-managed skills into your **local** agent
(Claude Code / Codex / Cursor). See `skills-updates.md` for the local side.

Requires a selected brand (`soku workspace status`) and a session whose
resources include `brand-skills`.

## Three catalogs

| Catalog | What it is | Commands |
| --- | --- | --- |
| Official | Skills shipped by Soku; every brand starts with them installed | `catalog`, `install <slug>`, `uninstall`, `reset` |
| Private | Skills this brand uploaded itself; visible only inside the brand | `upload`, `delete`, `files`, `read`, `write`, `create-file`, `delete-file`, `download` |
| Community | Skills other Soku workspaces published; anyone can install a copy | `community`, `install <slug> --community`, `publish` |

## Browse and install

```bash
soku brand skill list                      # installed official + private (incl. community copies)
soku brand skill catalog                   # official catalog with this brand's state
soku brand skill community                 # community catalog with this brand's state
soku brand skill community -q seo --sort installs
soku brand skill install ads-report        # official
soku brand skill install seo-digest --community
```

A community install copies the listing's latest version into the brand as a
private skill (it shows `source: community`). The publisher's later changes are
never applied automatically: when `community` shows `update → x.y.z` for a
slug this brand already has, run `install <slug> --community` again to replace
the copy. That also discards any local edits made to the copy.

## Publish a private skill

```bash
soku brand skill publish <slug>
soku brand skill publish <slug> --category analytics,creative
```

`--category` files the listing under one or more of `ads`, `seo`, `aso`,
`creative`, `social`, `analytics`, `general`, `operations` (comma-separated,
at most 4); without it the SKILL.md frontmatter `category` is used. It never
rewrites the SKILL.md itself.

Publishes the brand's private skill `<slug>` to the community catalog. Rules:

- Only private uploads qualify. A copy installed from the community cannot be
  re-published (`409 conflict`).
- Attribution is the organisation that owns the brand, never a person.
- The slug is global and first come, first served, and must not collide with an
  official skill. On `409 conflict` rename the skill in `SKILL.md` (the slug is
  derived from `name`) and publish again.
- Each publish needs a `version` in `SKILL.md` frontmatter that this slug has
  not published before (a missing version publishes as `0.1.0`). Bump it and
  publish again to ship a new version.
- There is no review step: the listing is live immediately. Nothing in a
  published skill should assume it only runs for the author's own brand.

## Safety rules for community skills

- Community skills are not reviewed by Soku. Read the full `SKILL.md` before
  installing one on a user's behalf: `soku brand skill install <slug> --community`
  makes the agent follow those instructions on the next turn.
- Do not publish anything containing credentials, customer data, or brand-
  specific secrets — the bundle is copied verbatim to other workspaces.
