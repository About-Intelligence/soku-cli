# Ads Writes

Meta and Google write commands use typed CLI surfaces where available. Most
delivery-changing writes are review-gated: the command creates a pending review
and does not execute until a human approves.

## Prerequisites

```bash
soku auth login --no-wait
soku workspace status
soku ads list-ad-accounts --platform meta
```

A default login can reach ads writes (no resource needed); each
delivery-changing write still returns a pending review for a human to approve.

## Meta Account Helpers

```bash
soku ads meta account pages --account-id <meta_account_id>
soku ads meta account instagram --account-id <meta_account_id>
soku ads meta campaign get --account-id <meta_account_id> --campaign-id <campaign_id>
soku ads meta ad get --account-id <meta_account_id> --ad-id <ad_id>
```

### Instagram identity (required for IG placements)

Before creating any creative that runs on Instagram, resolve the
**ad-account-connected** IG identity. The public IG `@handle` or the Facebook
Page id is rejected by the ads API — you must use the id returned by:

```bash
soku ads meta account instagram --account-id <meta_account_id>
```

Pass that `data[].id` as `instagram_user_id` (e.g. `-p instagram_user_id=<id>`)
when building the creative. An empty result means no IG account is connected to
the ad account — connect it in Business Manager first.

## Meta Assets

Image upload mutates the Meta asset library but does not change delivery, so it
executes immediately and returns `image_hash` values:

```bash
soku ads meta asset upload-images --account-id <meta_account_id> ./hero.png ./square.jpg
soku ads meta asset upload-images --account-id <meta_account_id> \
  --url https://example.com/hero.png --name-prefix launch
```

## Meta Single-Object Flow

Always inspect help for the exact flags before using a new command:

```bash
soku ads meta campaign create --help
soku ads meta adset create --help
soku ads meta creative create --help
soku ads meta ad create --help
```

Common flow:

```bash
soku ads meta campaign create \
  --account-id <meta_account_id> \
  --name "Launch Test" \
  --objective OUTCOME_TRAFFIC \
  --summary "Create paused Meta traffic campaign Launch Test"

soku ads meta adset create \
  --account-id <meta_account_id> \
  --campaign-id <campaign_id> \
  --name "US Prospecting" \
  --optimization-goal LINK_CLICKS \
  --billing-event IMPRESSIONS \
  -p targeting='{"geo_locations":{"countries":["US"]}}' \
  --summary "Create paused Meta ad set US Prospecting"

soku ads meta creative create \
  --account-id <meta_account_id> \
  --name "Hero image creative" \
  --page-id <page_id> \
  --image-hash <image_hash> \
  --message "Primary text" \
  --headline "Headline" \
  --link https://example.com \
  --call-to-action-type LEARN_MORE \
  --summary "Create Meta image creative for Launch Test"

soku ads meta ad create \
  --account-id <meta_account_id> \
  --adset-id <adset_id> \
  --name "Hero image ad" \
  --creative-id <creative_id> \
  --summary "Create paused Meta ad Hero image ad"
```

Dynamic creative (Advantage+ creative) uses `--asset-feed-spec` instead of a
single asset — Meta auto-combines the arrays. It is a primary media source, so
it is mutually exclusive with `--image-hash` / `--video-id` /
`--child-attachments`; the spec needs at least one of `images`/`videos` plus
`ad_formats`, and CTA / lead-form wiring goes inside the spec
(`call_to_action_types`), not as top-level flags. The ad set must be
dynamic-creative-enabled (`soku ads meta adset create ... -p is_dynamic_creative=true`).

```bash
soku ads meta creative create \
  --account-id <meta_account_id> \
  --name "Dynamic creative" \
  --page-id <page_id> \
  --asset-feed-spec '{"images":[{"hash":"<hash1>"},{"hash":"<hash2>"}],"bodies":[{"text":"Primary text A"},{"text":"Primary text B"}],"titles":[{"text":"Headline A"}],"link_urls":[{"website_url":"https://example.com"}],"call_to_action_types":["LEARN_MORE"],"ad_formats":["SINGLE_IMAGE"]}' \
  --summary "Create Meta dynamic creative"
```

Status controls exist at delivery levels:

```bash
soku ads meta campaign activate --campaign-id <campaign_id> --account-id <meta_account_id> --summary "Activate campaign"
soku ads meta adset pause --adset-id <adset_id> --account-id <meta_account_id> --summary "Pause ad set"
soku ads meta ad pause --ad-id <ad_id> --account-id <meta_account_id> --summary "Pause ad"
```

## Bulk Meta Create

Bulk commands are one layer at a time. Each item in `--items-file` must be an
object with a unique non-empty `client_ref`.

```bash
soku ads meta campaign bulk-create --account-id <meta_account_id> --items-file campaigns.json --summary "Bulk-create campaigns"
soku ads meta adset bulk-create --account-id <meta_account_id> --items-file adsets.json --summary "Bulk-create ad sets"
soku ads meta creative bulk-create --account-id <meta_account_id> --items-file creatives.json --summary "Bulk-create creatives"
soku ads meta ad bulk-create --account-id <meta_account_id> --items-file ads.json --summary "Bulk-create ads"
```

After approval, bulk reviews execute asynchronously. Poll with:

```bash
soku review show <review_id>
```

## Google Ads Writes

Use:

```bash
soku ads google --help
soku ads google campaign --help
soku ads google ad-group --help
soku ads google ad --help
soku ads google keyword --help
```

The command path determines platform. Do not add `--platform`; the CLI injects
`platform=google`.

## Review Gate

Review-gated commands return a review id:

```bash
soku review list
soku review show <review_id>
```

As an agent, always show the review id and summary to the user first — a human
must authorize the write. If your harness prompts for explicit human
confirmation before each shell command (e.g. Claude Code's permission prompt),
you MAY then run `soku review approve <id>` yourself: that prompt is the human
gate, so never allowlist or auto-approve it. If your harness auto-runs commands
without confirmation, do not self-approve — let the user run it. Approval is
single-use; failed approval is terminal, so create a fresh review for retry.
