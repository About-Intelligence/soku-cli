# Ads Writes

Meta, Google, and ChatGPT Ads write commands use typed CLI surfaces where
available. Most delivery-changing writes are review-gated: the command creates a
pending review and does not execute until a human approves.

## Prerequisites

```bash
soku auth login --no-wait
soku workspace status
soku ads list-ad-accounts --platform meta
```

A default login can reach ads writes (no resource needed); every ads write,
including asset uploads, returns a pending review with an `approve_url` the
user opens to approve it (see "Review Gate" below).

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

Image upload only adds to the Meta asset library, but it is still a
review-gated write: it returns a pending review, and the `image_hash` values
arrive in the review result once the user approves. The command writes the
approval header for you (override with `--summary`):

```bash
soku ads meta asset upload-images --account-id <meta_account_id> ./hero.png ./square.jpg
soku ads meta asset upload-images --account-id <meta_account_id> \
  --url https://example.com/hero.png --name-prefix launch
soku review wait <review_id>   # then read image_hash from the result
```

Local files are stored in Soku first and the review carries only their id, so
an approval that comes hours later still works. Never publish a local file with
`soku files publish` to get a URL for an ad upload: that link expires in 30
minutes.

## Meta Video Ads

To put local videos into an ad set, use one command and one approval. It
uploads every file to Soku, and once the user approves it uploads them to the
ad account, waits for Meta to process them, and creates one creative plus one
**PAUSED** ad per video:

```bash
soku ads meta ad deploy-videos ./clip1.mp4 ./clip2.mp4 ./clip3.mp4 \
  --account-id <meta_account_id> --adset-id <adset_id> --page-id <page_id> \
  --message "Primary text" --headline "Headline" \
  --link https://example.com --cta LEARN_MORE --destination WEBSITE_AND_SHOP_OPT_OUT
soku review wait <review_id>
```

- Copy the flags from an existing ad in the same ad set when the user asks to
  "match" it (read it with `soku ads meta ad get`); ask when copy is unknown.
- Per-video copy: `--items-file items.json`, a JSON array whose items name one
  of `file` / `video_id` / `media_asset_id`, plus optional `name`, `message`,
  `headline`, `description`, `link`, `thumbnail_url`.
- Videos already in the ad library: `--video-id <id>` (repeatable).
- With `--link` on Meta v26, ask the user for `--destination` before
  submitting.
- Lead ads (`--lead-gen-form-id`) need a thumbnail per video
  (`thumbnail_url` or `thumbnail_image_hash` in `--items-file`).
- Read the result per item: `stage=ad` with `ad_id` means done.
  `META_VIDEO_NOT_READY` means Meta was still processing that video: check
  it with `soku ads meta asset video --video-id <id> --account-id <id>`, then
  deploy it again with `--video-id`. The other items were still deployed.
- The ads are paused. Activating them is a separate write the user decides on.

Library-only upload (no ads), one approval per file; the inbox link approves
them together:

```bash
soku ads meta asset upload-video --account-id <meta_account_id> ./clip1.mp4 ./clip2.mp4
soku review wait <review_id...>   # each result carries video_id and video_status
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

Status controls exist at delivery levels. A write that names an existing
campaign / ad set / ad must first read that object back (`soku ads meta
campaign get` / `adset get` / `ad get`, or the matching list command) and quote
its current name **and** literal id in `--summary`; the server rejects a summary
that omits a literal target id with `invalid_ads_payload`:

```bash
soku ads meta campaign activate --campaign-id <campaign_id> --account-id <meta_account_id> --summary "Activate campaign 'Launch Test' (campaign_id <campaign_id>)"
soku ads meta adset pause --adset-id <adset_id> --account-id <meta_account_id> --summary "Pause ad set 'US Prospecting' (adset_id <adset_id>)"
soku ads meta ad pause --ad-id <ad_id> --account-id <meta_account_id> --summary "Pause ad 'Hero image ad' (ad_id <ad_id>)"
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

After approval, bulk reviews execute asynchronously. `soku review wait` waits
through both the decision and the execution; `show` reads the current state:

```bash
soku review wait <review_id>
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

## ChatGPT Ads Writes

Use:

```bash
soku ads chatgpt --help
soku ads chatgpt account --help
soku ads chatgpt campaign --help
soku ads chatgpt ad-group --help
soku ads chatgpt ad --help
```

The command path determines platform. Do not add `--platform`; the CLI injects
`platform=chatgpt_ads`.

The object model is `Campaign → Ad Group → Ad`. `campaign create` requires a
non-empty inline ad-groups array (`--ad-groups '<json>'` or
`--ad-groups-file groups.json`); each group is `manual` (with authored `ads`)
or `generative`. Campaign, ad group, and ad creates are all forced paused by
the backend; activation is a separate review-gated
`soku ads chatgpt campaign activate` that the user must explicitly request and
approve. ChatGPT Ads status literals are lowercase `active` / `paused`, ads
live under `ad_group_id` (never `adset_id`), and every mutation requires
`--account-id`.

```bash
soku ads chatgpt campaign create \
  --account-id <account_id> --name "Launch Test" \
  --landing-page "https://example.com/?utm_source=chatgpt_ads" \
  --objective clicks --budget-daily 300 \
  --ad-groups '[{"group_type":"manual","name":"AG 1","landing_page":"https://example.com/?utm_source=chatgpt_ads","brand_name":"Example","ads":[{"name":"Ad 1","headline":"Headline","copy":"Body","cta":"Learn more","landing_page":"https://example.com/?utm_source=chatgpt_ads"}]}]' \
  --summary "Create paused ChatGPT Ads campaign Launch Test"

soku ads chatgpt ad-group create \
  --account-id <account_id> --campaign-id <campaign_id> \
  --name "AG 2" --landing-page "https://example.com/?utm_source=chatgpt_ads" \
  --brand-name "Example" --group-type generative \
  --summary "Add generative ad group AG 2"

soku ads chatgpt ad create \
  --account-id <account_id> --ad-group-id <ad_group_id> \
  --name "Ad 2" --headline "Headline" --copy "Body" --cta "Learn more" \
  --landing-page "https://example.com/?utm_source=chatgpt_ads" \
  --summary "Add authored ad Ad 2"
```

Reads need no `--summary`: `soku ads chatgpt account info` (billing facts plus
activation/tracking preflight), `campaign list|get`, `ad-group list|get`.
Archives (`campaign remove`, `ad-group archive`, `ad archive`) are
provider-side archive toggles — verify current state with a read first.

Legacy ad-unit campaigns (`create_ad_unit`, `generate_ad_units`,
`add_campaign_ad_units`, `replace_campaign_ad_units`, `archive_ad_unit`) are
deprecated and stay on the raw `soku call ads <action>` surface for existing
campaigns only; do not use them for new deployments. Migrate a legacy campaign
with `soku ads chatgpt campaign migrate-legacy` (moves ad units into paused Ad
Groups and authored Ads).

## Review Gate

Review-gated commands return a review id plus `approve_url` / `inbox_url`:

```bash
soku review list            # ends with the inbox link when anything is pending
soku review show <review_id>
```

As an agent, never approve a write yourself. Give the user the `approve_url`
from the pending response (or `inbox_url` when you parked several) with one
line on what they are approving, then wait for their decision:

```bash
soku review wait <review_id> [<review_id> ...]   # exits 5 on deny or failure
soku review open <review_id>                    # opens the page in the user's browser
```

Do not tell the user a change is applied or live until the review reports the
execution result and the read-back matches; approval alone is not execution.
`soku review approve` / `deny` are for a person deciding in their own terminal:
never run or allowlist them. If a pending response has no `approve_url` (an
older Soku API), ask the user to run `soku review approve <review_id>`
themselves. Approval is single-use; failed approval is terminal, so create a
fresh review for retry.

A command the user chose to "Always approve" in Soku (chat or the approval
page) runs at submit and returns its result marked `auto_approved`; a
`require_human` guardrail still turns it back into a pending review.
