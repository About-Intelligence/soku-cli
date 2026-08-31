# SEO Hosting, Automations, And Files

These commands all write to the **active** Soku workspace. Confirm the brand in
the same turn as the write, and read the result back afterwards:

```bash
soku workspace status
```

The CLI keeps whatever brand was selected last and does not follow the brand the
user has open in the web app. A write into the wrong brand succeeds and looks
exactly like a correct one, so the confirmation has to be immediate, not
something done earlier in the session.

## SEO Hosting Pages

SEO Hosting pages are complete HTML documents, not Markdown. They are addressed
by `section` and `slug`.

```bash
soku seo-hosting status
soku seo-hosting pages list --section blog --status draft
soku seo-hosting pages put --section blog --slug how-to --title "How to ..." --html-file page.html
soku seo-hosting pages publish --section blog --slug how-to
soku seo-hosting pages unpublish --section blog --slug how-to
soku seo-hosting pages delete --section blog --slug how-to --confirm
soku seo-hosting pages upload-asset --path blog/how-to/hero.png --file ./hero.png
```

Run `status` before publishing. If no domain is live for the section, do not
publish yet.

`put` creates or overwrites a draft and requires exactly one HTML source:
`--html`, `--html-file`, or `--html-stdin`. Reference uploaded assets by the
absolute URL returned from `upload-asset`. No custom JavaScript.

Writes run immediately. Confirm user intent before publishing or deleting.

## SEO Hosting Domain Connections

```bash
soku seo-hosting connections list
soku seo-hosting connections connect-cname --hostname blog.example.com
soku seo-hosting connections verify <connection_id>
soku seo-hosting connections disconnect <connection_id> --confirm
```

Cloudflare Worker reverse proxy setup:

```bash
soku seo-hosting connections probe --hostname example.com --sections blog,use-cases
soku seo-hosting connections connect-worker --hostname example.com \
  --sections blog,use-cases --cf-token-env CLOUDFLARE_API_TOKEN
printf %s "$CLOUDFLARE_API_TOKEN" | soku seo-hosting connections connect-worker \
  --hostname example.com --sections blog --cf-token-stdin
```

Never pass Cloudflare tokens as literal argv values. Use `--cf-token-env` or
`--cf-token-stdin`. Add conflict override flags only after the user confirms the
risk.

## Automations

```bash
soku automation list
soku automation get <automation_id>
soku automation create --name "Fast check" --prompt "Check account health" --cron "* * * * *" --timezone UTC
soku automation update <automation_id> --prompt "Check account health and budget"
soku automation pause <automation_id>
soku automation resume <automation_id>
soku automation delete <automation_id> --confirm
soku automation deps <automation_id>
soku automation trigger <automation_id>
soku automation runs <automation_id>
```

`create` requires exactly one schedule option:

- `--cron <expr>` with optional `--timezone <iana>` (default `UTC`).
- `--interval-seconds <seconds>`; at least 3600 and divisible by 60.
- `--once-at <iso>` for a one-time UTC instant.

`update` sends only the flags you pass; everything else keeps its stored value.
It takes the same schedule flags as `create` (at most one), plus `--name`,
`--prompt`, and `--status`. `--timezone` is only accepted together with
`--cron`, because the server rebuilds the schedule from a whole contract and a
lone timezone would be silently dropped.

**Do not rebuild an automation to change it.** `update` edits the existing row
and keeps its id, run history, and schedule version. Rebuilding loses all three,
and leaves the original still scheduled unless you also pause or delete it.

`pause` stops an automation and clears its next run; `resume` puts it back to
active and recomputes the next run. Both are `update --status` underneath.

`deps` reports whether the automation's saved dependencies still resolve:

- **attachments** are looked up for real, so a deleted or cross-brand file shows
  as `missing` before the automation next fires.
- **context references** are classified, not verified. A reference marked
  `brand-pinned` (ad account, campaign, ad set, ad, report) names a row inside
  the current brand: copying the automation into another brand carries the id
  across but not the thing it points at, so those must be re-picked there. A
  `portable` reference (skill, integration) does not have that problem.

Run `deps` before migrating an automation between brands, and after any change
that may have deleted a referenced file.

## Context Hub

```bash
soku context list
soku context upload ./brief.pdf --dir research
soku context mkdir research
soku context rename old/path new/path
soku context rm research/brief.pdf
```

Paths are context-relative. Do not include a `context/` prefix.

### Bulk uploads

`upload` takes directories (recursing and preserving structure under `--dir`)
and runs files concurrently. For a large migration:

```bash
soku context upload ./assets --dir assets --concurrency 8 --verify
soku context uploads                                  # runs with unfinished files
soku context upload --resume <run_id>                 # finish one of them
soku context verify ./assets --dir assets             # reconcile without uploading
```

- Each file is retried on transient failures (no response, HTTP 408/429/5xx)
  before the run gives up on it; `--retries <n>` changes the attempt count. A
  permanent failure such as 403 is not retried.
- Every run records a resumable run id. If any file is still unfinished when the
  run ends, the output carries `resume_command` — run it to re-upload only the
  files that never landed. Finished runs leave no record behind.
- `--resume` refuses to run if the active brand is not the one the recorded run
  targeted. Switch back with `soku workspace use-brand` rather than forcing it:
  the files would otherwise land, in the wrong brand, and look successful.
- `--verify` (and the standalone `soku context verify`) reconciles against the
  server by size **and** checksum. A file the server reports no checksum for is
  reported as `unverified`, not `ok` — a missing hash is not proof of a good
  upload. Both `upload --verify` and `verify` exit non-zero if anything is
  missing, mismatched, or unverified, so a script can gate on them.

Do not hand-count files to check a migration. `verify` is the reconciliation.

## Temporary Public File URLs

```bash
soku files publish ./creative.png
```

URLs are short-lived signed URLs, usually around 30 minutes. If a downstream API
later fails to fetch the file, check expiration first.
