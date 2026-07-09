# SEO Hosting, Automations, And Files

These commands operate on the active Soku workspace. Confirm workspace first:

```bash
soku workspace status
```

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
soku automation create --name "Fast check" --prompt "Check account health" --cron "* * * * *" --timezone UTC
soku automation trigger <automation_id>
soku automation runs <automation_id>
```

`create` requires exactly one schedule option:

- `--cron <expr>` with optional `--timezone <iana>` (default `UTC`).
- `--interval-seconds <seconds>`; at least 3600 and divisible by 60.
- `--once-at <iso>` for a one-time UTC instant.

`runs` prints a Studio link when a conversation exists. The CLI does not read
conversation content.

## Context Hub

```bash
soku context list
soku context upload ./brief.pdf --dir research
soku context mkdir research
soku context rename old/path new/path
soku context rm research/brief.pdf
```

Paths are context-relative. Do not include a `context/` prefix.

## Temporary Public File URLs

```bash
soku files publish ./creative.png
```

URLs are short-lived signed URLs, usually around 30 minutes. If a downstream API
later fails to fetch the file, check expiration first.
